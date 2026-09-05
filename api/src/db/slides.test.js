import { test } from 'node:test';
import assert from 'node:assert/strict';

test('updateSlideExternalFields exists and accepts (id, fields)', async () => {
  const mod = await import('./slides.js');
  assert.equal(typeof mod.updateSlideExternalFields, 'function');
  assert.equal(mod.updateSlideExternalFields.length, 2);
});

test('getRecentMaxCaseBase (plausibility reference for manual names) is kept', async () => {
  const mod = await import('./slides.js');
  assert.equal(typeof mod.getRecentMaxCaseBase, 'function');
});

test('review-queue and OCR helpers are gone', async () => {
  const mod = await import('./slides.js');
  for (const fn of ['updateSlideOcr', 'listPendingOcrSlides', 'listPendingReviewSlides', 'countPendingReviewSlides', 'setSlideReviewStatus']) {
    assert.equal(mod[fn], undefined, `${fn} should not be exported`);
  }
});
