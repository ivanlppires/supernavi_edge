import * as ctxDb from '../db/case-contexts.js';
import { isReviewQueueEnabled } from '../lib/feature-flags.js';

export default async function caseContextRoutes(fastify, opts = {}) {
  fastify.addHook('preHandler', async (req, reply) => {
    if (!opts.skipFlagCheck && !isReviewQueueEnabled()) {
      return reply.code(404).send({ error: 'review queue disabled' });
    }
  });

  const deps = { getCaseContext: ctxDb.getCaseContext, ...opts.deps };

  fastify.get('/case-contexts/:caseBase', async (req, reply) => {
    const ctx = await deps.getCaseContext(req.params.caseBase);
    if (!ctx) return reply.code(404).send({ error: 'not found' });
    return ctx;
  });
}
