import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlideName, validateSlideName } from './slide-name-parser.js';

describe('parseSlideName — full form', () => {
  it('parses a clean AP name', () => {
    assert.deepStrictEqual(parseSlideName('AP26000388A1'), {
      fullName: 'AP26000388A1', caseBase: 'AP26000388', slideLabel: 'A1',
    });
  });

  it('parses IM and C prefixes', () => {
    assert.deepStrictEqual(parseSlideName('IM26000100B2'), {
      fullName: 'IM26000100B2', caseBase: 'IM26000100', slideLabel: 'B2',
    });
    assert.deepStrictEqual(parseSlideName('C26000588A'), {
      fullName: 'C26000588A', caseBase: 'C26000588', slideLabel: 'A',
    });
  });

  it('normalizes PA → AP, lowercase, whitespace and separators', () => {
    assert.deepStrictEqual(parseSlideName('pa26000019a1'), {
      fullName: 'AP26000019A1', caseBase: 'AP26000019', slideLabel: 'A1',
    });
    assert.deepStrictEqual(parseSlideName('  AP 26000388 A1  '), {
      fullName: 'AP26000388A1', caseBase: 'AP26000388', slideLabel: 'A1',
    });
  });

  it('accepts a bare case number (no suffix)', () => {
    assert.deepStrictEqual(parseSlideName('AP26000388'), {
      fullName: 'AP26000388', caseBase: 'AP26000388', slideLabel: '',
    });
  });

  it('accepts an explicit full low case number', () => {
    assert.deepStrictEqual(parseSlideName('AP26000002'), {
      fullName: 'AP26000002', caseBase: 'AP26000002', slideLabel: '',
    });
  });

  it('returns null for garbage', () => {
    assert.equal(parseSlideName('I cannot read this label'), null);
    assert.equal(parseSlideName(''), null);
    assert.equal(parseSlideName(null), null);
    assert.equal(parseSlideName(undefined), null);
  });
});

describe('parseSlideName — abbreviated form (separator = suppressed zeros)', () => {
  it('expands underscore and hyphen forms', () => {
    assert.deepStrictEqual(parseSlideName('26_388A'), {
      fullName: 'AP26000388A', caseBase: 'AP26000388', slideLabel: 'A',
    });
    assert.deepStrictEqual(parseSlideName('26-621'), {
      fullName: 'AP26000621', caseBase: 'AP26000621', slideLabel: '',
    });
    assert.deepStrictEqual(parseSlideName('26_388b2'), {
      fullName: 'AP26000388B2', caseBase: 'AP26000388', slideLabel: 'B2',
    });
  });

  it('expands the label from the 2026-09-04 incident correctly', () => {
    assert.deepStrictEqual(parseSlideName('26-2614A'), {
      fullName: 'AP26002614A', caseBase: 'AP26002614', slideLabel: 'A',
    });
  });

  it('accepts a 3-digit right side for genuinely low case numbers', () => {
    assert.deepStrictEqual(parseSlideName('26-005'), {
      fullName: 'AP26000005', caseBase: 'AP26000005', slideLabel: '',
    });
  });

  // Incident 2026-09-04: "26-2" (a truncated "26-2614A") expanded to AP26000002,
  // a real case of another patient. Fewer than 3 digits is never accepted.
  it('rejects fewer than 3 digits on the right', () => {
    assert.equal(parseSlideName('26-2'), null);
    assert.equal(parseSlideName('26_2'), null);
    assert.equal(parseSlideName('26-02'), null);
    assert.equal(parseSlideName('26-2A'), null);
  });

  it('corrects a misread year (96 → 26) and keeps a valid year', () => {
    assert.deepStrictEqual(parseSlideName('96-621'), {
      fullName: 'AP26000621', caseBase: 'AP26000621', slideLabel: '',
    });
    assert.deepStrictEqual(parseSlideName('24-500'), {
      fullName: 'AP24000500', caseBase: 'AP24000500', slideLabel: '',
    });
  });
});

describe('validateSlideName', () => {
  it('returns the parsed name when the format is valid and no reference is known', () => {
    const r = validateSlideName('26-2614A', null);
    assert.equal(r.ok, true);
    assert.equal(r.parsed.fullName, 'AP26002614A');
  });

  it('flags an invalid format with a human-readable message', () => {
    const r = validateSlideName('26-2', 'AP26002643');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid_format');
    assert.match(r.message, /3 dígitos/);
  });

  it('flags a case number implausibly below the recent maximum', () => {
    const r = validateSlideName('26-002', 'AP26002643');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'implausible_case_number');
    assert.match(r.message, /AP26002643/);
  });

  it('accepts a low case number when there is no recent reference (early in the year)', () => {
    const r = validateSlideName('26-002', null);
    assert.equal(r.ok, true);
    assert.equal(r.parsed.caseBase, 'AP26000002');
  });

  it('accepts a plausible name against the reference', () => {
    const r = validateSlideName('AP26002700B', 'AP26002643');
    assert.equal(r.ok, true);
  });
});
