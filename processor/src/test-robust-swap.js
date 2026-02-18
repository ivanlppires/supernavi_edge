/**
 * Unit test for robustSwapDirs (pipeline-svs.js)
 *
 * Run: node processor/src/test-robust-swap.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { robustSwapDirs } from './pipeline-svs.js';

const TEST_ROOT = join(tmpdir(), `supernavi-test-${randomUUID()}`);

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

before(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe('robustSwapDirs', () => {
  it('swaps srcDir into tilesDir when tilesDir does not exist', async () => {
    const base = join(TEST_ROOT, 'case1');
    const srcDir = join(base, 'src');
    const tilesDir = join(base, 'tiles');
    const oldDir = join(base, 'tiles_old');

    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, '0_0.jpg'), 'tile-data');

    await robustSwapDirs(srcDir, tilesDir, oldDir);

    assert.ok(await exists(tilesDir), 'tilesDir should exist');
    assert.ok(!(await exists(srcDir)), 'srcDir should be gone');
    assert.ok(!(await exists(oldDir)), 'oldDir should be gone');

    const content = await readFile(join(tilesDir, '0_0.jpg'), 'utf8');
    assert.equal(content, 'tile-data');
  });

  it('replaces existing tilesDir atomically', async () => {
    const base = join(TEST_ROOT, 'case2');
    const srcDir = join(base, 'src');
    const tilesDir = join(base, 'tiles');
    const oldDir = join(base, 'tiles_old');

    // Create existing tilesDir with old data
    await mkdir(tilesDir, { recursive: true });
    await writeFile(join(tilesDir, 'old.jpg'), 'old-data');

    // Create srcDir with new data
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'new.jpg'), 'new-data');

    await robustSwapDirs(srcDir, tilesDir, oldDir);

    assert.ok(await exists(tilesDir), 'tilesDir should exist');
    assert.ok(!(await exists(srcDir)), 'srcDir should be gone');
    assert.ok(!(await exists(oldDir)), 'oldDir should be cleaned up');

    const files = await readdir(tilesDir);
    assert.deepEqual(files, ['new.jpg']);
    const content = await readFile(join(tilesDir, 'new.jpg'), 'utf8');
    assert.equal(content, 'new-data');
  });

  it('cleans up stale oldDir before swapping', async () => {
    const base = join(TEST_ROOT, 'case3');
    const srcDir = join(base, 'src');
    const tilesDir = join(base, 'tiles');
    const oldDir = join(base, 'tiles_old');

    // Simulate stale oldDir from a previous crash
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, 'stale.jpg'), 'stale');

    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, '0_0.jpg'), 'fresh');

    await robustSwapDirs(srcDir, tilesDir, oldDir);

    assert.ok(await exists(tilesDir));
    assert.ok(!(await exists(oldDir)));
    const content = await readFile(join(tilesDir, '0_0.jpg'), 'utf8');
    assert.equal(content, 'fresh');
  });
});
