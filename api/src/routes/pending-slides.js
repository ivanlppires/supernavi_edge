import { readFile } from 'fs/promises';
import { join } from 'path';
import * as slidesDb from '../db/slides.js';
import { query } from '../db/index.js';
import { parseSlideName, validateSlideName } from '../lib/slide-name-parser.js';
import { parseCaseBase } from '../lib/case-plausibility.js';
import { eventBus } from '../services/events.js';

/**
 * Review queue: slides whose name came from OCR (or that have no name) wait
 * here for a person. Nothing is blocked — the slide is processed and uploaded
 * with name_confirmed=false; confirming re-emits SlideRegistered with
 * name_confirmed=true so the cloud links it to its PathoWeb case.
 */

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
      name_confirmed: true,
    })]
  );
}

export default async function pendingSlidesRoutes(fastify, opts = {}) {
  const deps = {
    listPendingReviewSlides: slidesDb.listPendingReviewSlides,
    countPendingReviewSlides: slidesDb.countPendingReviewSlides,
    getSlide: slidesDb.getSlide,
    setSlideReviewStatus: slidesDb.setSlideReviewStatus,
    updateSlideOcr: slidesDb.updateSlideOcr,
    deduplicateSlideLabel: slidesDb.deduplicateSlideLabel,
    getRecentMaxCaseBase: slidesDb.getRecentMaxCaseBase,
    emitSlideRegistered: defaultEmitSlideRegistered,
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

  /**
   * Validate a typed/proposed name (format + plausibility against recent cases),
   * apply it and confirm the slide. Returns { ok, status?, body }.
   */
  async function confirmWithName(slide, filename) {
    const text = String(filename || '').trim();
    const candidate = parseSlideName(text);
    const base = candidate ? parseCaseBase(candidate.caseBase) : null;
    const reference = base ? await deps.getRecentMaxCaseBase(base.prefix, base.year) : null;
    const check = validateSlideName(text, reference);
    if (!check.ok) {
      return { ok: false, status: 400, body: { error: check.message, code: check.code, reference } };
    }
    const parsed = check.parsed;
    const dedupName = await deps.deduplicateSlideLabel(parsed.fullName, slide.id);
    const newFilename = dedupName + '.' + (slide.format || 'svs');

    await deps.updateSlideOcr(slide.id, {
      originalFilename: newFilename,
      externalCaseId: `pathoweb:${parsed.caseBase}`,
      externalCaseBase: parsed.caseBase,
      externalSlideLabel: dedupName,
      ocrStatus: 'done',
    });
    await deps.setSlideReviewStatus(slide.id, 'confirmed');
    await deps.emitSlideRegistered(slide.id);
    return { ok: true, body: { ok: true, slide_id: slide.id, filename: newFilename, case_base: parsed.caseBase } };
  }

  fastify.get('/pending-slides', async () => {
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

  fastify.get('/pending-slides/:id/image', async (req, reply) => {
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

  // Confirm every pending slide that has an OCR proposal (one click for a batch
  // of correctly read labels); slides without a proposal stay pending.
  fastify.post('/pending-slides/confirm-all', async () => {
    const rows = await deps.listPendingReviewSlides();
    const result = { ok: true, confirmed: 0, skipped: 0, failed: [] };
    for (const row of rows) {
      if (!row.external_slide_label) {
        result.skipped += 1;
        continue;
      }
      try {
        const r = await confirmWithName(row, row.external_slide_label);
        if (r.ok) result.confirmed += 1;
        else result.failed.push({ slide_id: row.id, error: r.body.error, code: r.body.code });
      } catch (err) {
        result.failed.push({ slide_id: row.id, error: err.message });
      }
    }
    await deps.emitPendingCountChanged();
    return result;
  });

  fastify.post('/pending-slides/:id/confirm', async (req, reply) => {
    const filename = req.body && typeof req.body.filename === 'string' ? req.body.filename : '';
    if (!filename.trim()) return reply.code(400).send({ error: 'filename is required', code: 'invalid_format' });

    const slide = await deps.getSlide(req.params.id);
    if (!slide) return reply.code(404).send({ error: 'slide not found' });
    if (slide.review_status !== 'pending') {
      return reply.code(409).send({ error: 'slide is not pending review' });
    }

    const r = await confirmWithName(slide, filename);
    if (!r.ok) return reply.code(r.status).send(r.body);
    await deps.emitPendingCountChanged();
    return r.body;
  });

  fastify.post('/pending-slides/:id/rescan', async (req, reply) => {
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
