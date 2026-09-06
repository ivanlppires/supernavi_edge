/**
 * Slide name parser — validates and normalizes the case identifier a PERSON
 * types (dashboard "Identificar lâmina" or a rename forwarded by the cloud
 * viewer). Deterministic, no AI. Replaces the parsing half of the retired
 * label-ocr.js; the OCR call itself is gone.
 *
 * Accepted formats:
 *   Full:        AP26000388A1, PA26000019 (PA → AP), C26000588A, IM26000100B2,
 *                RE26000003 (revisão externa: slide from another lab, numbered by the clinic)
 *   Abbreviated: 26-388A / 26_388A — the separator stands for suppressed zeros
 *                and the right side needs 3 to 6 digits. "26-2" is rejected:
 *                on 2026-09-04 a truncated "26-2" became AP26000002, another
 *                patient's real case.
 *
 * Handwritten "2" is often read as "9": a 2-digit year outside 20..current
 * year is corrected by swapping 2↔9 (96 → 26).
 */

import { isImplausiblyLowCaseNumber } from './case-plausibility.js';

const FULL_REGEX = /^((?:AP|PA|IM|C|RE)\d{6,12})([A-Z]\d*)?$/i;
const ABBREVIATED_REGEX = /^(\d{2})[-_](\d{3,6})([A-Z]\d*)?$/i;
const DIGIT_CORRECTIONS = { '9': '2', '2': '9' };
const CASE_DIGITS = 8;

export const INVALID_FORMAT_MESSAGE =
  'Formato inválido. Use o nome completo (AP26000388A1, C26000588A, RE26000003) ou abreviado com pelo menos 3 dígitos após o traço (26-388A).';

function correctYear(yearStr) {
  const currentYear = new Date().getFullYear() % 100;
  const year = parseInt(yearStr, 10);
  if (year >= 20 && year <= currentYear) return yearStr;

  for (let i = 0; i < yearStr.length; i++) {
    const replacement = DIGIT_CORRECTIONS[yearStr[i]];
    if (!replacement) continue;
    const candidate = yearStr.substring(0, i) + replacement + yearStr.substring(i + 1);
    const candidateYear = parseInt(candidate, 10);
    if (candidateYear >= 20 && candidateYear <= currentYear) return candidate;
  }
  return yearStr;
}

/**
 * @param {string|null|undefined} text
 * @returns {{ fullName: string, caseBase: string, slideLabel: string } | null}
 */
export function parseSlideName(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim().toUpperCase();
  if (!trimmed) return null;

  const abbr = trimmed.match(ABBREVIATED_REGEX);
  if (abbr) {
    const left = correctYear(abbr[1]);
    const right = abbr[2];
    const suffix = (abbr[3] || '').toUpperCase();
    const zeros = Math.max(0, CASE_DIGITS - left.length - right.length);
    const caseBase = 'AP' + left + '0'.repeat(zeros) + right;
    return { fullName: caseBase + suffix, caseBase, slideLabel: suffix };
  }

  const cleaned = trimmed.replace(/[\s\-_.]/g, '');
  if (!cleaned) return null;

  const match = cleaned.match(FULL_REGEX);
  if (!match) return null;

  const caseBase = match[1].replace(/^PA/, 'AP');
  const slideLabel = match[2] || '';
  return { fullName: caseBase + slideLabel, caseBase, slideLabel };
}

/**
 * Format + plausibility check for a typed name.
 *
 * @param {string} text
 * @param {string|null} [referenceCaseBase] highest case base registered recently
 *   for the same prefix/year (see getRecentMaxCaseBase); null = no data, skip.
 * @returns {{ ok: true, parsed: { fullName: string, caseBase: string, slideLabel: string } }
 *         | { ok: false, code: 'invalid_format' | 'implausible_case_number', message: string }}
 */
export function validateSlideName(text, referenceCaseBase = null) {
  const parsed = parseSlideName(text);
  if (!parsed) {
    return { ok: false, code: 'invalid_format', message: INVALID_FORMAT_MESSAGE };
  }
  if (referenceCaseBase && isImplausiblyLowCaseNumber(parsed.caseBase, referenceCaseBase)) {
    return {
      ok: false,
      code: 'implausible_case_number',
      message: `Número de caso ${parsed.caseBase} muito abaixo dos casos recentes (${referenceCaseBase}). Confira a etiqueta e digite o número completo.`,
    };
  }
  return { ok: true, parsed };
}
