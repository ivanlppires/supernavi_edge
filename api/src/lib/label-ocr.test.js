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
});
