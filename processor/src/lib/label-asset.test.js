import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { copyLabelFromDsmeta, findLabelPath } from './label-asset.js';

describe('label-asset', () => {
  let root;
  let derived;
  let rawWithLabel;
  let rawWithout;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'label-asset-'));
    derived = join(root, 'derived');
    const scan = join(root, 'scanner', '2026', '0904');
    await mkdir(join(scan, 'a.svs.dsmeta'), { recursive: true });
    rawWithLabel = join(scan, 'a.svs');
    rawWithout = join(scan, 'b.svs');
    await writeFile(rawWithLabel, 'svs-a');
    await writeFile(rawWithout, 'svs-b');
    await writeFile(join(scan, 'a.svs.dsmeta', 'label.jpg'), 'label-photo');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies label.jpg from the .dsmeta folder into derived/{slideId}', async () => {
    const dest = await copyLabelFromDsmeta('slide-a', rawWithLabel, derived);
    assert.equal(dest, join(derived, 'slide-a', 'label.jpg'));
    assert.equal(await readFile(dest, 'utf8'), 'label-photo');
  });

  it('is idempotent: a second call returns the existing copy without failing', async () => {
    const dest = await copyLabelFromDsmeta('slide-a', rawWithLabel, derived);
    assert.equal(dest, join(derived, 'slide-a', 'label.jpg'));
  });

  it('returns null when the SVS has no .dsmeta label', async () => {
    assert.equal(await copyLabelFromDsmeta('slide-b', rawWithout, derived), null);
  });

  it('returns null for a missing rawPath instead of throwing', async () => {
    assert.equal(await copyLabelFromDsmeta('slide-c', null, derived), null);
    assert.equal(await copyLabelFromDsmeta('slide-c', join(root, 'nope.svs'), derived), null);
  });

  it('findLabelPath reports the derived copy or null', async () => {
    assert.equal(await findLabelPath('slide-a', derived), join(derived, 'slide-a', 'label.jpg'));
    assert.equal(await findLabelPath('slide-b', derived), null);
  });
});
