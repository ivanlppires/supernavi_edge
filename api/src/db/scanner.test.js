import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsertScannerFile, buildCheckExists } from './scanner.js';

describe('scanner DB helpers', () => {
  it('buildCheckExists returns correct SQL', () => {
    const { sql, params } = buildCheckExists('/scanner/2026/0120/GUID/file.svs');
    assert.ok(sql.includes('SELECT'));
    assert.ok(sql.includes('scanner_files'));
    assert.ok(sql.includes('file_path'));
    assert.deepStrictEqual(params, ['/scanner/2026/0120/GUID/file.svs']);
  });

  it('buildInsertScannerFile returns correct SQL and params', () => {
    const { sql, params } = buildInsertScannerFile({
      filePath: '/scanner/path/to/file.svs',
      slideId: 'abc123',
      scannerBarcode: '485948',
      scannerGuid: 'F278D360',
      scanDatetime: '20251212151927',
    });
    assert.ok(sql.includes('INSERT INTO scanner_files'));
    assert.ok(sql.includes('ON CONFLICT'));
    assert.equal(params.length, 5);
    assert.equal(params[0], '/scanner/path/to/file.svs');
    assert.equal(params[1], 'abc123');
    assert.equal(params[2], '485948');
  });
});
