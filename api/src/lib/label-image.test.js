import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveLabelImagePath } from './label-image.js';

describe('resolveLabelImagePath', () => {
  let root;
  let derived;
  let dsmeta;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'label-image-'));
    derived = join(root, 'derived');
    dsmeta = join(root, 'scan', 'x.svs.dsmeta');
    await mkdir(join(derived, 'slide-both'), { recursive: true });
    await mkdir(dsmeta, { recursive: true });
    await writeFile(join(derived, 'slide-both', 'label.jpg'), 'derived-label');
    await writeFile(join(dsmeta, 'label.jpg'), 'dsmeta-label');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prefers the derived copy', async () => {
    assert.equal(await resolveLabelImagePath(derived, 'slide-both', dsmeta), join(derived, 'slide-both', 'label.jpg'));
  });

  it('falls back to the .dsmeta photo', async () => {
    assert.equal(await resolveLabelImagePath(derived, 'slide-dsmeta-only', dsmeta), join(dsmeta, 'label.jpg'));
  });

  it('returns null when there is no photo anywhere', async () => {
    assert.equal(await resolveLabelImagePath(derived, 'slide-none', join(root, 'missing.dsmeta')), null);
    assert.equal(await resolveLabelImagePath(derived, 'slide-none', null), null);
  });
});
