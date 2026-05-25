import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const mockRows = [
  { id: 'abc123', original_filename: 'AP26000388A1.svs', external_case_base: 'AP26000388',
    external_slide_label: 'AP26000388A1', dsmeta_path: '/data/scanner/x.dsmeta', format: 'svs',
    created_at: new Date('2026-05-24T10:00:00Z') },
];

test('GET /v1/pending-slides returns the queue with proposed names', async () => {
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    deps: {
      listPendingReviewSlides: async () => mockRows,
      countPendingReviewSlides: async () => 1,
    },
  });
  const res = await fastify.inject({ method: 'GET', url: '/v1/pending-slides' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 1);
  assert.equal(body.slides[0].id, 'abc123');
  assert.equal(body.slides[0].proposed_name, 'AP26000388A1');
  assert.equal(body.slides[0].case_base, 'AP26000388');
  await fastify.close();
});
