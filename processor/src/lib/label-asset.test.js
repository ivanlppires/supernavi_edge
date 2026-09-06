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

  it('uses the recorded .dsmeta folder when the raw file no longer sits next to it', async () => {
    // Slides re-ingested through the inbox keep raw_path in /data/raw while
    // dsmeta_path still points at the scanner folder.
    const scan = join(root, 'scanner', '2026', '0309');
    const dsmetaDir = join(scan, 'c.svs.dsmeta');
    await mkdir(dsmetaDir, { recursive: true });
    await writeFile(join(dsmetaDir, 'label.jpg'), 'label-c');
    const movedRaw = join(root, 'raw', 'c.svs');
    const dest = await copyLabelFromDsmeta('slide-c2', movedRaw, derived, dsmetaDir);
    assert.equal(dest, join(derived, 'slide-c2', 'label.jpg'));
    assert.equal(await readFile(dest, 'utf8'), 'label-c');
  });

  it('falls back to the raw-path sibling when the recorded .dsmeta folder is gone', async () => {
    const dest = await copyLabelFromDsmeta('slide-a2', rawWithLabel, derived, join(root, 'gone.svs.dsmeta'));
    assert.equal(dest, join(derived, 'slide-a2', 'label.jpg'));
  });

  it('returns null when neither location has a photo, even without rawPath', async () => {
    assert.equal(await copyLabelFromDsmeta('slide-d', null, derived, join(root, 'nope.svs.dsmeta')), null);
    assert.equal(await copyLabelFromDsmeta('slide-d', rawWithout, derived, join(root, 'nope.svs.dsmeta')), null);
  });

  it('findLabelPath reports the derived copy or null', async () => {
    assert.equal(await findLabelPath('slide-a', derived), join(derived, 'slide-a', 'label.jpg'));
    assert.equal(await findLabelPath('slide-b', derived), null);
  });
});
