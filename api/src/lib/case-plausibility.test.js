import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCaseBase, isImplausiblyLowCaseNumber } from './case-plausibility.js';

describe('parseCaseBase', () => {
  it('parses prefix, year and number', () => {
    assert.deepStrictEqual(parseCaseBase('AP26002614'), { prefix: 'AP', year: '26', number: 2614 });
    assert.deepStrictEqual(parseCaseBase('C26000588'), { prefix: 'C', year: '26', number: 588 });
    assert.deepStrictEqual(parseCaseBase('RE26000003'), { prefix: 'RE', year: '26', number: 3 });
  });

  it('normalizes PA to AP and lowercase input', () => {
    assert.deepStrictEqual(parseCaseBase('pa26000019'), { prefix: 'AP', year: '26', number: 19 });
  });

  it('returns null for garbage', () => {
    assert.equal(parseCaseBase('_20260904112919'), null);
    assert.equal(parseCaseBase(''), null);
    assert.equal(parseCaseBase(null), null);
  });
});

describe('isImplausiblyLowCaseNumber', () => {
  it('flags the incident case: "26-2" → AP26000002 while the lab is at ~2643', () => {
    assert.equal(isImplausiblyLowCaseNumber('AP26000002', 'AP26002643'), true);
  });

  it('accepts a proposal in the same range as recent cases', () => {
    assert.equal(isImplausiblyLowCaseNumber('AP26002614', 'AP26002643'), false);
    assert.equal(isImplausiblyLowCaseNumber('AP26002700', 'AP26002643'), false);
  });

  it('accepts small numbers early in the year (reference below minReference)', () => {
    assert.equal(isImplausiblyLowCaseNumber('AP26000002', 'AP26000015'), false);
  });

  it('cannot judge across prefixes or years', () => {
    assert.equal(isImplausiblyLowCaseNumber('C26000002', 'AP26002643'), false);
    // RE has its own sequence: RE26000003 is fine while AP is at 2643
    assert.equal(isImplausiblyLowCaseNumber('RE26000003', 'AP26002643'), false);
    assert.equal(isImplausiblyLowCaseNumber('AP25000002', 'AP26002643'), false);
  });

  it('is a no-op without a reference', () => {
    assert.equal(isImplausiblyLowCaseNumber('AP26000002', null), false);
  });

  it('honours custom ratio (smaller ratio = stricter: proposal must be >= reference/ratio)', () => {
    // 300 * 5 = 1500 < 2643 → flagged; 300 * 10 = 3000 >= 2643 → accepted
    assert.equal(isImplausiblyLowCaseNumber('AP26000300', 'AP26002643', { ratio: 5 }), true);
    assert.equal(isImplausiblyLowCaseNumber('AP26000300', 'AP26002643', { ratio: 10 }), false);
  });
});
