import { test } from 'node:test';
import assert from 'node:assert/strict';

test('module exports the expected helpers', async () => {
  const mod = await import('./case-contexts.js');
  assert.equal(typeof mod.getCaseContext, 'function');
  assert.equal(typeof mod.upsertCaseContext, 'function');
});
