import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseDsmeta, parseMoticPath } from './dsmeta-parser.js';

describe('parseDsmeta', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsmeta-test-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses a valid info.txt', async () => {
    const dsmetaDir = join(tempDir, 'test.svs.dsmeta');
    await mkdir(dsmetaDir, { recursive: true });
    await writeFile(join(dsmetaDir, 'info.txt'), [
      '[info]',
      'Guid=F278D360-BCCB-42D0-9F64-0587B91DEB50',
      'mifwidth=55333',
      'mifheight=22294',
      'Barcode=485948',
    ].join('\r\n'));

    const result = await parseDsmeta(dsmetaDir);
    assert.deepStrictEqual(result, {
      guid: 'F278D360-BCCB-42D0-9F64-0587B91DEB50',
      width: 55333,
      height: 22294,
      barcode: '485948',
    });
  });

  it('returns null when info.txt missing', async () => {
    const emptyDir = join(tempDir, 'empty.svs.dsmeta');
    await mkdir(emptyDir, { recursive: true });
    const result = await parseDsmeta(emptyDir);
    assert.strictEqual(result, null);
  });

  it('returns null when directory does not exist', async () => {
    const result = await parseDsmeta(join(tempDir, 'nonexistent.svs.dsmeta'));
    assert.strictEqual(result, null);
  });

  it('handles missing fields gracefully', async () => {
    const partialDir = join(tempDir, 'partial.svs.dsmeta');
    await mkdir(partialDir, { recursive: true });
    await writeFile(join(partialDir, 'info.txt'), [
      '[info]',
      'Guid=ABC123',
      'Barcode=999',
    ].join('\n'));

    const result = await parseDsmeta(partialDir);
    assert.deepStrictEqual(result, {
      guid: 'ABC123',
      width: null,
      height: null,
      barcode: '999',
    });
  });
});

describe('parseMoticPath', () => {
  it('extracts barcode, datetime, guid from scanner path', () => {
    const result = parseMoticPath(
      '/scanner/2026/0120/F278D360-BCCB-42D0-9F64-0587B91DEB50/485948_20251212151927/485948_20251212151927.svs'
    );
    assert.deepStrictEqual(result, {
      year: '2026',
      monthday: '0120',
      guid: 'F278D360-BCCB-42D0-9F64-0587B91DEB50',
      barcode: '485948',
      scanDatetime: '20251212151927',
      filename: '485948_20251212151927.svs',
    });
  });

  it('returns null for non-scanner paths', () => {
    assert.strictEqual(parseMoticPath('/data/raw/abc123_slide.svs'), null);
    assert.strictEqual(parseMoticPath('/scanner/orphan.svs'), null);
  });

  it('handles paths with different GUID formats', () => {
    const result = parseMoticPath(
      '/scanner/2025/1114/AAAABBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF/123456_20251114090000/123456_20251114090000.svs'
    );
    assert.ok(result);
    assert.equal(result.barcode, '123456');
    assert.equal(result.guid, 'AAAABBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF');
  });
});
