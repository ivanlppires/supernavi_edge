import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mockRows = [
  { id: 'abc123', original_filename: 'AP26000388A1.svs', external_case_base: 'AP26000388',
    external_slide_label: 'AP26000388A1', dsmeta_path: '/data/scanner/x.dsmeta', format: 'svs',
    created_at: new Date('2026-05-24T10:00:00Z') },
];

test('GET /v1/pending-slides returns the queue with proposed names', async () => {
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    skipFlagCheck: true,
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

test('GET /:id/image returns the JPEG bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pending-img-'));
  const dsmeta = join(dir, 'foo.svs.dsmeta');
  await mkdir(dsmeta);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  await writeFile(join(dsmeta, 'label.jpg'), bytes);

  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    skipFlagCheck: true,
    deps: { getSlide: async () => ({ id: 'abc', dsmeta_path: dsmeta, review_status: 'pending' }) },
  });
  const res = await fastify.inject({ method: 'GET', url: '/v1/pending-slides/abc/image?which=label' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.deepEqual(res.rawPayload, bytes);
  await fastify.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /:id/image rejects invalid `which`', async () => {
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    skipFlagCheck: true,
    deps: { getSlide: async () => ({ id: 'abc', dsmeta_path: '/tmp', review_status: 'pending' }) },
  });
  const res = await fastify.inject({ method: 'GET', url: '/v1/pending-slides/abc/image?which=../etc/passwd' });
  assert.equal(res.statusCode, 400);
  await fastify.close();
});

test('POST /:id/confirm — happy path with new case context', async () => {
  const calls = [];
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    skipFlagCheck: true,
    deps: {
      getSlide: async (id) => ({ id, format: 'svs', review_status: 'pending' }),
      deduplicateSlideLabel: async (name) => name,
      updateSlideOcr: async (...args) => { calls.push(['updateSlideOcr', ...args]); },
      setSlideReviewStatus: async (...args) => { calls.push(['setSlideReviewStatus', ...args]); return true; },
      upsertCaseContext: async (ctx) => { calls.push(['upsertCaseContext', ctx]); return ctx; },
      emitSlideRegistered: async (id) => { calls.push(['emitSlideRegistered', id]); },
      emitClinicalContextSet: async (caseBase) => { calls.push(['emitClinicalContextSet', caseBase]); },
    },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/v1/pending-slides/abc/confirm',
    payload: {
      filename: 'AP26000388A1',
      clinicalContext: { exam_type: 'AP', subtipo: 'biopsia_pele', sexo: 'F', idade: 62,
                         material: 'Biópsia pele', hipotese: null },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(calls.find(c => c[0] === 'upsertCaseContext'));
  assert.ok(calls.find(c => c[0] === 'emitClinicalContextSet'));
  assert.ok(calls.find(c => c[0] === 'emitSlideRegistered'));
  await fastify.close();
});

test('POST /:id/confirm — rejects bad filename', async () => {
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    skipFlagCheck: true,
    deps: { getSlide: async () => ({ review_status: 'pending' }) },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/v1/pending-slides/abc/confirm',
    payload: { filename: 'lixo123' },
  });
  assert.equal(res.statusCode, 400);
  await fastify.close();
});

test('POST /:id/confirm — 409 when slide is not pending', async () => {
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    skipFlagCheck: true,
    deps: { getSlide: async () => ({ review_status: 'confirmed' }) },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/v1/pending-slides/abc/confirm',
    payload: { filename: 'AP26000388A1' },
  });
  assert.equal(res.statusCode, 409);
  await fastify.close();
});

test('POST /:id/rescan — marks slide as rescan without events', async () => {
  const calls = [];
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, {
    skipFlagCheck: true,
    deps: {
      getSlide: async () => ({ id: 'abc', review_status: 'pending' }),
      setSlideReviewStatus: async (id, status) => { calls.push([id, status]); return true; },
      emitSlideRegistered: async () => { throw new Error('should not be called'); },
    },
  });
  const res = await fastify.inject({ method: 'POST', url: '/v1/pending-slides/abc/rescan' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [['abc', 'rescan']]);
  await fastify.close();
});
