import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePathologyFilename } from './filename-parser.js';

describe('parsePathologyFilename', () => {
  it('parses AP filename with suffix', () => {
    const result = parsePathologyFilename('AP26000388A1.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000388',
      label: 'A1',
      externalCaseId: 'pathoweb:AP26000388',
      externalCaseBase: 'AP26000388',
    });
  });

  it('parses IM filename without suffix', () => {
    const result = parsePathologyFilename('IM26000100.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'IM26000100',
      label: '1',
      externalCaseId: 'pathoweb:IM26000100',
      externalCaseBase: 'IM26000100',
    });
  });

  it('parses IM filename with suffix', () => {
    const result = parsePathologyFilename('IM26000100B2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'IM26000100',
      label: 'B2',
      externalCaseId: 'pathoweb:IM26000100',
      externalCaseBase: 'IM26000100',
    });
  });

  it('parses IM filename with separators', () => {
    const result = parsePathologyFilename('IM-26000100-A1.tiff');
    assert.deepStrictEqual(result, {
      caseBase: 'IM26000100',
      label: 'A1',
      externalCaseId: 'pathoweb:IM26000100',
      externalCaseBase: 'IM26000100',
    });
  });

  it('returns null for unrecognized filenames', () => {
    assert.strictEqual(parsePathologyFilename('random_file.svs'), null);
    assert.strictEqual(parsePathologyFilename('09443_20260219090407.svs'), null);
  });
});
