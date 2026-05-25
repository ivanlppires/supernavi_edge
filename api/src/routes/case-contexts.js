import * as ctxDb from '../db/case-contexts.js';

export default async function caseContextRoutes(fastify, opts = {}) {
  const deps = { getCaseContext: ctxDb.getCaseContext, ...opts.deps };

  fastify.get('/v1/case-contexts/:caseBase', async (req, reply) => {
    const ctx = await deps.getCaseContext(req.params.caseBase);
    if (!ctx) return reply.code(404).send({ error: 'not found' });
    return ctx;
  });
}
