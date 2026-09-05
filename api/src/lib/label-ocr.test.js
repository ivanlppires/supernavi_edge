import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcrResponse, interpretOcrResponse, buildRequest, DEFAULT_OCR_MODEL } from './label-ocr.js';

describe('parseOcrResponse (alias of parseSlideName)', () => {
  it('parses full and abbreviated identifiers', () => {
    assert.deepStrictEqual(parseOcrResponse('AP26000388A1'), { fullName: 'AP26000388A1', caseBase: 'AP26000388', slideLabel: 'A1' });
    assert.deepStrictEqual(parseOcrResponse('26-2614A'), { fullName: 'AP26002614A', caseBase: 'AP26002614', slideLabel: 'A' });
    assert.deepStrictEqual(parseOcrResponse('PA26000019'), { fullName: 'AP26000019', caseBase: 'AP26000019', slideLabel: '' });
  });

  // Incident 2026-09-04: a truncated "26-2" must never become AP26000002
  it('rejects abbreviated answers with fewer than 3 digits', () => {
    assert.equal(parseOcrResponse('26-2'), null);
    assert.equal(parseOcrResponse('26_02'), null);
  });

  it('returns null for garbage', () => {
    assert.equal(parseOcrResponse('I cannot read this label'), null);
    assert.equal(parseOcrResponse(''), null);
    assert.equal(parseOcrResponse(null), null);
  });
});

describe('interpretOcrResponse', () => {
  it('accepts a complete answer (STOP)', () => {
    const r = interpretOcrResponse({ text: '26-2614A', finishReason: 'STOP' });
    assert.equal(r.status, 'ok');
    assert.equal(r.result.fullName, 'AP26002614A');
  });

  it('accepts an answer without finishReason', () => {
    assert.equal(interpretOcrResponse({ text: 'AP26002614A', finishReason: null }).status, 'ok');
  });

  it('never trusts a truncated answer, even if it would parse', () => {
    const r = interpretOcrResponse({ text: '26-2614', finishReason: 'MAX_TOKENS' });
    assert.equal(r.status, 'truncated');
    assert.equal(r.result, null);
    assert.equal(r.raw, '26-2614');
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
    const r = interpretOcrResponse({ text: '26-2', finishReason: 'STOP' });
    assert.equal(r.status, 'unparsed');
    assert.equal(r.raw, '26-2');
  });
});

describe('buildRequest (Gemini 3 via @google/genai)', () => {
  const images = [{ mediaType: 'image/jpeg', base64: 'AAAA' }];

  it('targets Gemini 3.1 Pro preview by default with low thinking, temperature 0 and a small output cap', () => {
    const req = buildRequest(images, 'read it', {});
    assert.equal(DEFAULT_OCR_MODEL, 'gemini-3.1-pro-preview');
    assert.equal(req.model, 'gemini-3.1-pro-preview');
    assert.equal(req.config.temperature, 0);
    assert.equal(req.config.maxOutputTokens, 256);
    assert.deepStrictEqual(req.config.thinkingConfig, { thinkingLevel: 'LOW' });
    assert.equal(req.contents.length, 1);
    assert.equal(req.contents[0].role, 'user');
    assert.deepStrictEqual(req.contents[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    assert.deepStrictEqual(req.contents[0].parts[1], { text: 'read it' });
  });

  it('honours OCR_MODEL, OCR_MAX_OUTPUT_TOKENS and OCR_THINKING_LEVEL', () => {
    const req = buildRequest(images, 'p', { OCR_MODEL: 'gemini-3.5-flash', OCR_MAX_OUTPUT_TOKENS: '64', OCR_THINKING_LEVEL: 'medium' });
    assert.equal(req.model, 'gemini-3.5-flash');
    assert.equal(req.config.maxOutputTokens, 64);
    assert.deepStrictEqual(req.config.thinkingConfig, { thinkingLevel: 'MEDIUM' });
  });

  it('omits thinkingConfig when OCR_THINKING_LEVEL is empty', () => {
    const req = buildRequest(images, 'p', { OCR_THINKING_LEVEL: '' });
    assert.equal('thinkingConfig' in req.config, false);
  });
});
