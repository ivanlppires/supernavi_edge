import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcrResponse, interpretOcrResponse } from './label-ocr.js';

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

  // Hyphen-separated abbreviated format (handwritten labels)
  it('expands hyphen-separated 26-621 to AP26000621', () => {
    const result = parseOcrResponse('26-621');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000621',
      caseBase: 'AP26000621',
      slideLabel: '',
    });
  });

  it('expands hyphen-separated with suffix 26-388A to AP26000388A', () => {
    const result = parseOcrResponse('26-388A');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A',
      caseBase: 'AP26000388',
      slideLabel: 'A',
    });
  });

  // Year correction: handwritten "2" misread as "9"
  it('corrects misread year 96→26 in 96-621', () => {
    const result = parseOcrResponse('96-621');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000621',
      caseBase: 'AP26000621',
      slideLabel: '',
    });
  });

  it('corrects misread year 96→26 in 96_388A', () => {
    const result = parseOcrResponse('96_388A');
    assert.deepStrictEqual(result, {
      fullName: 'AP26000388A',
      caseBase: 'AP26000388',
      slideLabel: 'A',
    });
  });

  it('keeps valid year 24 as-is', () => {
    const result = parseOcrResponse('24-500');
    assert.deepStrictEqual(result, {
      fullName: 'AP24000500',
      caseBase: 'AP24000500',
      slideLabel: '',
    });
  });
});

// Incident 2026-09-04: a truncated answer ("26-2" cut from "26-2614A") parses
// to a real-looking case (AP26000002). finishReason tells us the answer was cut.
describe('interpretOcrResponse', () => {
  it('accepts a complete answer (STOP)', () => {
    const r = interpretOcrResponse({ text: '26-2614A', finishReason: 'STOP' });
    assert.equal(r.status, 'ok');
    assert.equal(r.result.fullName, 'AP26002614A');
  });

  it('accepts an answer without finishReason (older API responses)', () => {
    const r = interpretOcrResponse({ text: 'AP26002614A', finishReason: null });
    assert.equal(r.status, 'ok');
  });

  it('never trusts a truncated answer, even if it parses', () => {
    const r = interpretOcrResponse({ text: '26-2', finishReason: 'MAX_TOKENS' });
    assert.equal(r.status, 'truncated');
    assert.equal(r.result, null);
    assert.equal(r.raw, '26-2');
  });

  it('treats safety/other blocks as blocked', () => {
    const r = interpretOcrResponse({ text: '', finishReason: 'SAFETY' });
    assert.equal(r.status, 'blocked');
    assert.equal(r.result, null);
  });

  it('maps UNREADABLE and empty text to unreadable', () => {
    assert.equal(interpretOcrResponse({ text: 'UNREADABLE', finishReason: 'STOP' }).status, 'unreadable');
    assert.equal(interpretOcrResponse({ text: '  ', finishReason: 'STOP' }).status, 'unreadable');
  });

  it('flags text that does not parse as unparsed (keeps raw for the log)', () => {
    const r = interpretOcrResponse({ text: 'I cannot read this', finishReason: 'STOP' });
    assert.equal(r.status, 'unparsed');
    assert.equal(r.raw, 'I cannot read this');
  });
});
