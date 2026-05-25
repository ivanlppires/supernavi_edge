import { test } from 'node:test';
import assert from 'node:assert/strict';

test('canEmitRegistered exists and accepts a slide id', async () => {
  const mod = await import('./review-gate.js');
  assert.equal(typeof mod.canEmitRegistered, 'function');
  assert.equal(mod.canEmitRegistered.length, 1);
});
