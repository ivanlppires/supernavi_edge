import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { hashFile } from './hash.js';

const TMP_DIR = join(import.meta.dirname, '__test_tmp_hash__');

before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('returns SHA256 hex for known content', async () => {
    const content = 'hello supernavi';
    const filePath = join(TMP_DIR, 'known.txt');
    writeFileSync(filePath, content);

    const expected = createHash('sha256').update(content).digest('hex');
    const result = await hashFile(filePath);

    assert.equal(result, expected);
  });

  it('is deterministic (same content = same hash)', async () => {
    const content = 'deterministic-test-content';
    const file1 = join(TMP_DIR, 'det1.txt');
    const file2 = join(TMP_DIR, 'det2.txt');
    writeFileSync(file1, content);
    writeFileSync(file2, content);

    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);

    assert.equal(hash1, hash2);
  });

  it('produces different hashes for different content', async () => {
    const file1 = join(TMP_DIR, 'diff1.txt');
    const file2 = join(TMP_DIR, 'diff2.txt');
    writeFileSync(file1, 'content-a');
    writeFileSync(file2, 'content-b');

    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);

    assert.notEqual(hash1, hash2);
  });

  it('returns a 64-character hex string', async () => {
    const filePath = join(TMP_DIR, 'format.txt');
    writeFileSync(filePath, 'format-check');

    const result = await hashFile(filePath);

    assert.equal(result.length, 64);
    assert.match(result, /^[0-9a-f]{64}$/);
  });

  it('rejects for non-existent file', async () => {
    const filePath = join(TMP_DIR, 'does-not-exist.txt');

    await assert.rejects(
      () => hashFile(filePath),
      (err) => {
        assert.equal(err.code, 'ENOENT');
        return true;
      }
    );
  });
});
