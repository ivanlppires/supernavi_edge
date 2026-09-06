/**
 * Sanity check for OCR-proposed case numbers.
 *
 * Incident 2026-09-04: the model answered "26-2" for a label that read
 * "26-2614A"; the abbreviated-format parser dutifully expanded it to
 * AP26000002 — a real case of another patient. Case numbers within a year are
 * sequential, so a proposal far below what the lab has been scanning lately is
 * almost certainly a truncated/misread label. Such proposals are dropped and
 * the slide goes to the review queue without a name (technician types it).
 *
 * Self-calibrating: early in the year the reference is small too, so "26-2"
 * in January is accepted.
 */

const CASE_BASE_RE = /^(AP|PA|IM|C|RE)(\d{2})(\d{4,10})$/i;

/**
 * @param {string} caseBase e.g. "AP26002614"
 * @returns {{ prefix: string, year: string, number: number } | null}
 */
export function parseCaseBase(caseBase) {
  if (!caseBase || typeof caseBase !== 'string') return null;
  const m = caseBase.trim().toUpperCase().match(CASE_BASE_RE);
  if (!m) return null;
  return {
    prefix: m[1] === 'PA' ? 'AP' : m[1],
    year: m[2],
    number: parseInt(m[3], 10),
  };
}

/**
 * True when `caseBase` is implausibly low compared to `referenceCaseBase`
 * (the highest case number registered recently for the same prefix + year).
 *
 * @param {string} caseBase           proposed case base (e.g. AP26000002)
 * @param {string|null} referenceCaseBase recent max (e.g. AP26002643); null = no data
 * @param {{ ratio?: number, minReference?: number }} [opts]
 *   ratio        proposal must be at least reference/ratio (default 10)
 *   minReference below this reference we cannot judge (default 100)
 */
export function isImplausiblyLowCaseNumber(caseBase, referenceCaseBase, opts = {}) {
  const ratio = opts.ratio ?? 10;
  const minReference = opts.minReference ?? 100;

  const a = parseCaseBase(caseBase);
  const b = parseCaseBase(referenceCaseBase);
  if (!a || !b) return false;
  if (a.prefix !== b.prefix || a.year !== b.year) return false;
  if (b.number < minReference) return false;
  return a.number * ratio < b.number;
}
