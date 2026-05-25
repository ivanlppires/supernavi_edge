import { readFile } from 'fs/promises';
import { join } from 'path';
import * as slidesDb from '../db/slides.js';

export default async function pendingSlidesRoutes(fastify, opts = {}) {
  const deps = {
    listPendingReviewSlides: slidesDb.listPendingReviewSlides,
    countPendingReviewSlides: slidesDb.countPendingReviewSlides,
    getSlide: slidesDb.getSlide,
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
}
