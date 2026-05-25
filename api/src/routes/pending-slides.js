import { readFile } from 'fs/promises';
import { join } from 'path';
import * as slidesDb from '../db/slides.js';
import * as ctxDb from '../db/case-contexts.js';
import { query } from '../db/index.js';
import { confirmBodySchema } from '../lib/clinical-context-schema.js';
import { parsePathologyFilename } from '../lib/filename-parser.js';
import { eventBus } from '../services/events.js';
import { isReviewQueueEnabled } from '../lib/feature-flags.js';

async function defaultEmitSlideRegistered(slideId) {
  const r = await query(
    `SELECT width, height, mpp, external_case_id, external_case_base,
            external_slide_label, original_filename
       FROM slides WHERE id = $1`, [slideId]);
  const s = r.rows[0];
  if (!s) return;
  await query(
    `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
     VALUES ($1, $2, $3, $4)`,
    ['slide', slideId, 'registered', JSON.stringify({
      slide_id: slideId, case_id: null,
      svs_filename: s.original_filename,
      width: s.width || 0, height: s.height || 0, mpp: parseFloat(s.mpp) || 0,
      external_case_id: s.external_case_id,
      external_case_base: s.external_case_base,
      external_slide_label: s.external_slide_label,
    })]
  );
}

async function defaultEmitClinicalContextSet(caseBase) {
  const ctx = await ctxDb.getCaseContext(caseBase);
  if (!ctx) return;
  await query(
    `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
     VALUES ($1, $2, $3, $4)`,
    ['case', caseBase, 'clinical_context_set', JSON.stringify({
      case_base: caseBase,
      exam_type: ctx.exam_type,
      subtipo: ctx.subtipo,
      sexo: ctx.sexo,
      idade: ctx.idade,
      material: ctx.material,
      hipotese: ctx.hipotese,
    })]
  );
}

export default async function pendingSlidesRoutes(fastify, opts = {}) {
  fastify.addHook('preHandler', async (req, reply) => {
    if (!opts.skipFlagCheck && !isReviewQueueEnabled()) {
      return reply.code(404).send({ error: 'review queue disabled' });
    }
  });

  const deps = {
    listPendingReviewSlides: slidesDb.listPendingReviewSlides,
    countPendingReviewSlides: slidesDb.countPendingReviewSlides,
    getSlide: slidesDb.getSlide,
    setSlideReviewStatus: slidesDb.setSlideReviewStatus,
    updateSlideOcr: slidesDb.updateSlideOcr,
    deduplicateSlideLabel: slidesDb.deduplicateSlideLabel,
    upsertCaseContext: ctxDb.upsertCaseContext,
    emitSlideRegistered: defaultEmitSlideRegistered,
    emitClinicalContextSet: defaultEmitClinicalContextSet,
    emitPendingCountChanged: async () => {
      try {
        const n = await slidesDb.countPendingReviewSlides();
        eventBus.emitPendingCountChanged(n);
      } catch (err) {
        console.warn(`[Pending] Failed to broadcast pending count: ${err.message}`);
      }
    },
    ...opts.deps,
  };

  fastify.get('/v1/pending-slides', async () => {
    const [rows, total] = await Promise.all([
      deps.listPendingReviewSlides(),
      deps.countPendingReviewSlides(),
    ]);
    return {
      total,
      slides: rows.map(r => ({
        id: r.id,
        original_filename: r.original_filename,
        proposed_name: r.external_slide_label || null,
        case_base: r.external_case_base || null,
        has_dsmeta: Boolean(r.dsmeta_path),
        format: r.format,
        created_at: r.created_at,
      })),
    };
  });

  fastify.get('/v1/pending-slides/:id/image', async (req, reply) => {
    const { id } = req.params;
    const which = req.query.which || 'label';
    if (which !== 'label' && which !== 'slide2') {
      return reply.code(400).send({ error: 'which must be "label" or "slide2"' });
    }
    const slide = await deps.getSlide(id);
    if (!slide || !slide.dsmeta_path) return reply.code(404).send({ error: 'no image available' });
    const filename = which === 'label' ? 'label.jpg' : 'slide2.jpg';
    const path = join(slide.dsmeta_path, filename);
    try {
      const buf = await readFile(path);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'private, max-age=600');
      return buf;
    } catch (err) {
      if (err.code === 'ENOENT') return reply.code(404).send({ error: `${filename} not found` });
      throw err;
    }
  });

  fastify.post('/v1/pending-slides/:id/confirm', async (req, reply) => {
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.format() });
    }
    const { filename, clinicalContext } = parsed.data;

    const slide = await deps.getSlide(req.params.id);
    if (!slide) return reply.code(404).send({ error: 'slide not found' });
    if (slide.review_status !== 'pending') {
      return reply.code(409).send({ error: 'slide is not pending review' });
    }

    const parsedName = parsePathologyFilename(filename);
    if (!parsedName) return reply.code(400).send({ error: 'filename did not parse' });
    const caseBase = parsedName.caseBase;

    const dedupName = await deps.deduplicateSlideLabel(`${parsedName.caseBase}${parsedName.label}`, slide.id);
    const newFilename = dedupName + '.' + (slide.format || 'svs');

    await deps.updateSlideOcr(slide.id, {
      originalFilename: newFilename,
      externalCaseId: `pathoweb:${caseBase}`,
      externalCaseBase: caseBase,
      externalSlideLabel: dedupName,
      ocrStatus: 'done',
    });

    if (clinicalContext) {
      await deps.upsertCaseContext({
        caseBase,
        examType: clinicalContext.exam_type,
        subtipo: clinicalContext.subtipo,
        sexo: clinicalContext.sexo,
        idade: clinicalContext.idade,
        material: clinicalContext.material,
        hipotese: clinicalContext.hipotese ?? null,
      });
      await deps.emitClinicalContextSet(caseBase);
    }

    await deps.setSlideReviewStatus(slide.id, 'confirmed');
    await deps.emitSlideRegistered(slide.id);
    await deps.emitPendingCountChanged();

    return { ok: true, slide_id: slide.id, filename: newFilename, case_base: caseBase };
  });

  fastify.post('/v1/pending-slides/:id/rescan', async (req, reply) => {
    const slide = await deps.getSlide(req.params.id);
    if (!slide) return reply.code(404).send({ error: 'slide not found' });
    if (slide.review_status !== 'pending') {
      return reply.code(409).send({ error: 'slide is not pending review' });
    }
    await deps.setSlideReviewStatus(slide.id, 'rescan');
    await deps.emitPendingCountChanged();
    return { ok: true, slide_id: slide.id };
  });
}
