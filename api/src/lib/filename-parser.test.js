import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePathologyFilename } from './filename-parser.js';

describe('parsePathologyFilename', () => {
  it('parses AP number without suffix', () => {
    const result = parsePathologyFilename('AP26000230.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: '1',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses AP number with letter suffix', () => {
    const result = parsePathologyFilename('AP26000230A.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses AP number with alphanumeric suffix', () => {
    const result = parsePathologyFilename('AP26000230A2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses AP number with underscore separator', () => {
    const result = parsePathologyFilename('AP26000230_A2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses AP number with dash separators', () => {
    const result = parsePathologyFilename('AP-26000230-A2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses AP number with space separator', () => {
    const result = parsePathologyFilename('AP26000230 A2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses AP number with dot separator before suffix', () => {
    const result = parsePathologyFilename('AP26000230.A2.tiff');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses AP number with B suffix', () => {
    const result = parsePathologyFilename('AP26000230B.ndpi');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'B',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses lowercase ap prefix', () => {
    const result = parsePathologyFilename('ap26000230a2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('parses long AP numbers (12 digits)', () => {
    const result = parsePathologyFilename('AP260002301234.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP260002301234',
      label: '1',
      externalCaseId: 'pathoweb:AP260002301234',
      externalCaseBase: 'AP260002301234',
    });
  });

  it('returns null for non-AP filenames', () => {
    assert.strictEqual(parsePathologyFilename('random_file.svs'), null);
    assert.strictEqual(parsePathologyFilename('IMG_0001.jpg'), null);
    assert.strictEqual(parsePathologyFilename('sample.tiff'), null);
  });

  it('returns null for empty or invalid input', () => {
    assert.strictEqual(parsePathologyFilename(''), null);
    assert.strictEqual(parsePathologyFilename(null), null);
    assert.strictEqual(parsePathologyFilename(undefined), null);
  });

  it('returns null for AP with too few digits', () => {
    assert.strictEqual(parsePathologyFilename('AP12345.svs'), null);
  });

  it('parses AP number with B2 suffix', () => {
    const result = parsePathologyFilename('AP26000230B2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'B2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });

  it('handles mixed separators', () => {
    const result = parsePathologyFilename('AP_26000230_A2.svs');
    assert.deepStrictEqual(result, {
      caseBase: 'AP26000230',
      label: 'A2',
      externalCaseId: 'pathoweb:AP26000230',
      externalCaseBase: 'AP26000230',
    });
  });
});
