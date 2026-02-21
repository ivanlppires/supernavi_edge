import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcrResponse } from './label-ocr.js';

describe('parseOcrResponse', () => {
  it('parses a clean AP response', () => {
    const result = parseOcrResponse('AP26000388A1');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A1',
      caseBase: 'AP26000388',
      slideLabel: 'A1',
    });
  });

  it('parses IM response', () => {
    const result = parseOcrResponse('IM26000100B2');
    assert.deepStrictEqual(result, {
      fullName: 'IM26000100B2',
      caseBase: 'IM26000100',
      slideLabel: 'B2',
    });
  });

  it('handles response with extra whitespace', () => {
    const result = parseOcrResponse('  AP26000388A1  ');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A1',
      caseBase: 'AP26000388',
      slideLabel: 'A1',
    });
  });

  it('handles response with no suffix (bare case number)', () => {
    const result = parseOcrResponse('AP26000388');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388',
      caseBase: 'AP26000388',
      slideLabel: '',
    });
  });

  it('returns null for garbage response', () => {
    assert.strictEqual(parseOcrResponse('I cannot read this label'), null);
    assert.strictEqual(parseOcrResponse(''), null);
    assert.strictEqual(parseOcrResponse(null), null);
  });

  it('handles lowercase response', () => {
    const result = parseOcrResponse('ap26000388a1');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A1',
      caseBase: 'AP26000388',
      slideLabel: 'A1',
    });
  });

  it('strips separators from response', () => {
    const result = parseOcrResponse('AP 26000388 A1');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A1',
      caseBase: 'AP26000388',
      slideLabel: 'A1',
    });
  });

  it('normalizes PA prefix to AP', () => {
    const result = parseOcrResponse('PA26000019');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000019',
      caseBase: 'AP26000019',
      slideLabel: '',
    });
  });

  it('normalizes PA prefix with suffix to AP', () => {
    const result = parseOcrResponse('PA26000019A1');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000019A1',
      caseBase: 'AP26000019',
      slideLabel: 'A1',
    });
  });

  it('parses C (Citologia) prefix', () => {
    const result = parseOcrResponse('C26000588A');
    assert.deepStrictEqual(result, {
      fullName: 'C26000588A',
      caseBase: 'C26000588',
      slideLabel: 'A',
    });
  });

  // Abbreviated format tests (lab convention: underscore suppresses zeros)
  it('expands abbreviated 26_388A to AP26000388A', () => {
    const result = parseOcrResponse('26_388A');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A',
      caseBase: 'AP26000388',
      slideLabel: 'A',
    });
  });

  it('expands abbreviated 26_388B2 to AP26000388B2', () => {
    const result = parseOcrResponse('26_388B2');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388B2',
      caseBase: 'AP26000388',
      slideLabel: 'B2',
    });
  });

  it('expands abbreviated 26_100A to AP26000100A', () => {
    const result = parseOcrResponse('26_100A');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000100A',
      caseBase: 'AP26000100',
      slideLabel: 'A',
    });
  });

  it('expands abbreviated without suffix 26_388 to AP26000388', () => {
    const result = parseOcrResponse('26_388');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388',
      caseBase: 'AP26000388',
      slideLabel: '',
    });
  });

  it('handles abbreviated lowercase 26_388a', () => {
    const result = parseOcrResponse('26_388a');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A',
      caseBase: 'AP26000388',
      slideLabel: 'A',
    });
  });
});
