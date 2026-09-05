import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const pendingRow = (over = {}) => ({
  id: 'abc123', original_filename: '485948_20251212151927.svs', external_case_base: 'AP26002614',
  external_slide_label: 'AP26002614A', dsmeta_path: '/data/scanner/x.dsmeta', format: 'svs',
  review_status: 'pending', created_at: new Date('2026-09-05T10:00:00Z'), ...over,
});

function harness(rows, over = {}) {
  const calls = { updates: [], statuses: [], emitted: [], countBroadcasts: 0 };
  const deps = {
    listPendingReviewSlides: async () => rows,
    countPendingReviewSlides: async () => rows.length,
    getSlide: async (id) => rows.find(r => r.id === id) || null,
    setSlideReviewStatus: async (id, status) => { calls.statuses.push([id, status]); return true; },
    updateSlideOcr: async (id, fields) => { calls.updates.push([id, fields]); },
    deduplicateSlideLabel: async (name) => name,
    getRecentMaxCaseBase: async () => 'AP26002643',
    emitSlideRegistered: async (id) => { calls.emitted.push(id); },
    emitPendingCountChanged: async () => { calls.countBroadcasts += 1; },
    ...over,
  };
  return { deps, calls };
}

async function app(deps) {
  const fastify = Fastify();
  const route = await import('./pending-slides.js');
  await fastify.register(route.default, { deps });
  return fastify;
}

test('GET /pending-slides returns the queue with proposed names', async () => {
  const { deps } = harness([pendingRow()]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'GET', url: '/pending-slides' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 1);
  assert.equal(body.slides[0].id, 'abc123');
  assert.equal(body.slides[0].proposed_name, 'AP26002614A');
  assert.equal(body.slides[0].case_base, 'AP26002614');
  assert.equal(body.slides[0].has_dsmeta, true);
  await fastify.close();
});

test('GET /:id/image returns the JPEG bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pending-img-'));
  const dsmeta = join(dir, 'foo.svs.dsmeta');
  await mkdir(dsmeta);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  await writeFile(join(dsmeta, 'label.jpg'), bytes);
  const { deps } = harness([pendingRow({ id: 'abc', dsmeta_path: dsmeta })]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'GET', url: '/pending-slides/abc/image?which=label' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.deepEqual(res.rawPayload, bytes);
  await fastify.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /:id/image rejects an invalid `which`', async () => {
  const { deps } = harness([pendingRow({ id: 'abc' })]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'GET', url: '/pending-slides/abc/image?which=thumb' });
  assert.equal(res.statusCode, 400);
  await fastify.close();
});

test('POST /:id/confirm accepts the OCR proposal as typed and confirms the slide', async () => {
  const { deps, calls } = harness([pendingRow()]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'POST', url: '/pending-slides/abc123/confirm', payload: { filename: 'AP26002614A' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().filename, 'AP26002614A.svs');
  assert.deepEqual(calls.statuses, [['abc123', 'confirmed']]);
  assert.deepEqual(calls.emitted, ['abc123']);
  assert.equal(calls.updates[0][1].externalCaseBase, 'AP26002614');
  assert.equal(calls.countBroadcasts, 1);
  await fastify.close();
});

test('POST /:id/confirm accepts the abbreviated handwritten form', async () => {
  const { deps, calls } = harness([pendingRow({ external_slide_label: null, external_case_base: null })]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'POST', url: '/pending-slides/abc123/confirm', payload: { filename: '26-2614a' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().case_base, 'AP26002614');
  assert.equal(calls.updates[0][1].externalSlideLabel, 'AP26002614A');
  await fastify.close();
});

test('POST /:id/confirm rejects a truncated abbreviation (incident 2026-09-04)', async () => {
  const { deps, calls } = harness([pendingRow()]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'POST', url: '/pending-slides/abc123/confirm', payload: { filename: '26-2' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'invalid_format');
  assert.equal(calls.emitted.length, 0);
  await fastify.close();
});

test('POST /:id/confirm rejects an implausibly low case number', async () => {
  const { deps, calls } = harness([pendingRow()]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'POST', url: '/pending-slides/abc123/confirm', payload: { filename: 'AP26000002' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'implausible_case_number');
  assert.equal(res.json().reference, 'AP26002643');
  assert.equal(calls.statuses.length, 0);
  await fastify.close();
});

test('POST /:id/confirm is 409 when the slide is not pending', async () => {
  const { deps } = harness([pendingRow({ review_status: 'confirmed' })]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'POST', url: '/pending-slides/abc123/confirm', payload: { filename: 'AP26002614A' } });
  assert.equal(res.statusCode, 409);
  await fastify.close();
});

test('POST /confirm-all confirms slides with a proposal and skips unnamed ones', async () => {
  const rows = [
    pendingRow({ id: 'a1' }),
    pendingRow({ id: 'a2', external_slide_label: 'AP26002700B', external_case_base: 'AP26002700' }),
    pendingRow({ id: 'a3', external_slide_label: null, external_case_base: null }),
  ];
  const { deps, calls } = harness(rows);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'POST', url: '/pending-slides/confirm-all' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, confirmed: 2, skipped: 1, failed: [] });
  assert.deepEqual(calls.emitted, ['a1', 'a2']);
  assert.equal(calls.countBroadcasts, 1);
  await fastify.close();
});

test('POST /:id/rescan marks the slide and broadcasts the count', async () => {
  const { deps, calls } = harness([pendingRow()]);
  const fastify = await app(deps);
  const res = await fastify.inject({ method: 'POST', url: '/pending-slides/abc123/rescan' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.statuses, [['abc123', 'rescan']]);
  await fastify.close();
});
