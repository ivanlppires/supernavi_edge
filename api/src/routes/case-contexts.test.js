import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

test('GET /v1/case-contexts/:caseBase — returns 404 when missing', async () => {
  const fastify = Fastify();
  const route = await import('./case-contexts.js');
  await fastify.register(route.default, { deps: { getCaseContext: async () => null } });
  const res = await fastify.inject({ method: 'GET', url: '/v1/case-contexts/AP26000388' });
  assert.equal(res.statusCode, 404);
  await fastify.close();
});

test('GET /v1/case-contexts/:caseBase — returns the stored context', async () => {
  const fastify = Fastify();
  const route = await import('./case-contexts.js');
  const ctx = { case_base: 'AP26000388', exam_type: 'AP', subtipo: 'biopsia_pele',
                sexo: 'F', idade: 62, material: 'Biópsia pele', hipotese: null };
  await fastify.register(route.default, { deps: { getCaseContext: async () => ctx } });
  const res = await fastify.inject({ method: 'GET', url: '/v1/case-contexts/AP26000388' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().case_base, 'AP26000388');
  await fastify.close();
});
