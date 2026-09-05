import { test } from 'node:test';
import assert from 'node:assert/strict';

test('canEmitRegistered exists and accepts a slide id', async () => {
  const mod = await import('./review-gate.js');
  assert.equal(typeof mod.canEmitRegistered, 'function');
  assert.equal(mod.canEmitRegistered.length, 1);
});

test('decideEmitRegistered: legacy (null) and confirmed slides are allowed', async () => {
  const { decideEmitRegistered } = await import('./review-gate.js');
  assert.equal(decideEmitRegistered({ reviewStatus: null, alreadyEmitted: false }).emit, true);
  assert.equal(decideEmitRegistered({ reviewStatus: undefined, alreadyEmitted: false }).emit, true);
  assert.equal(decideEmitRegistered({ reviewStatus: 'confirmed', alreadyEmitted: false }).emit, true);
});

test('decideEmitRegistered: pending/rescan slides are blocked until confirmed', async () => {
  const { decideEmitRegistered } = await import('./review-gate.js');
  const d = decideEmitRegistered({ reviewStatus: 'pending', alreadyEmitted: false });
  assert.equal(d.emit, false);
  assert.match(d.reason, /pending/);
  assert.equal(decideEmitRegistered({ reviewStatus: 'rescan', alreadyEmitted: false }).emit, false);
});

test('decideEmitRegistered: a rename of a slide the cloud already knows must propagate even while pending', async () => {
  const { decideEmitRegistered } = await import('./review-gate.js');
  const d = decideEmitRegistered({ reviewStatus: 'pending', alreadyEmitted: true });
  assert.equal(d.emit, true);
  assert.equal(d.reason, 'correction_of_synced_name');
});
