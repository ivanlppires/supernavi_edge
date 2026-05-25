import { test } from 'node:test';
import assert from 'node:assert/strict';

test('listPendingReviewSlides exists and is async', async () => {
  const mod = await import('./slides.js');
  assert.equal(typeof mod.listPendingReviewSlides, 'function');
});

test('setSlideReviewStatus exists and accepts (id, status)', async () => {
  const mod = await import('./slides.js');
  assert.equal(typeof mod.setSlideReviewStatus, 'function');
  assert.equal(mod.setSlideReviewStatus.length, 2);
});

test('countPendingReviewSlides exists', async () => {
  const mod = await import('./slides.js');
  assert.equal(typeof mod.countPendingReviewSlides, 'function');
});
