import * as slidesDb from '../db/slides.js';

export default async function pendingSlidesRoutes(fastify, opts = {}) {
  const deps = {
    listPendingReviewSlides: slidesDb.listPendingReviewSlides,
    countPendingReviewSlides: slidesDb.countPendingReviewSlides,
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
}
