/**
 * Pathology filename parser for PathoWeb integration.
 *
 * Extracts case base (AP/PA/IM/C/RE number) and slide label from filenames.
 * RE = revisão externa: slide from another lab, numbered by the clinic in PathoWeb.
 * PA (Patologia Anatômica) is normalized to AP (Anatomopatológico).
 * C is for cytology and remains as C.
 *
 * Supported patterns:
 *   AP26000230.svs           -> { caseBase: 'AP26000230', label: '1' }
 *   PA26000230.svs           -> { caseBase: 'AP26000230', label: '1' }
 *   AP26000230A2.svs         -> { caseBase: 'AP26000230', label: 'A2' }
 *   AP26000230_A2.svs        -> { caseBase: 'AP26000230', label: 'A2' }
 *   AP-26000230-A2.svs       -> { caseBase: 'AP26000230', label: 'A2' }
 *   AP26000230 A2.svs        -> { caseBase: 'AP26000230', label: 'A2' }
 *   AP26000230.A2.tiff       -> { caseBase: 'AP26000230', label: 'A2' }
 *   C26000588A.svs           -> { caseBase: 'C26000588', label: 'A' }
 *   random_file.svs          -> null
 */

const CASE_BASE_REGEX = /^((?:AP|PA|IM|C|RE)[\s\-_.]*\d{6,12})/i;

/**
 * Normalize a string by removing common separators (space, dash, underscore, dot).
 */
function removeSeparators(str) {
  return str.replace(/[\s\-_.]/g, '');
}

/**
 * Parse a pathology filename to extract case base and slide label.
 *
 * @param {string} filename - Original filename including extension
 * @returns {{ caseBase: string, label: string, externalCaseId: string, externalCaseBase: string } | null}
 */
export function parsePathologyFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;

  // Remove extension
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
  if (!nameWithoutExt) return null;

  // Normalize: remove separators for matching the AP pattern
  const normalized = removeSeparators(nameWithoutExt);

  // Match case base pattern
  const match = normalized.match(/^((?:AP|PA|IM|C|RE)\d{6,12})/i);
  if (!match) return null;

  // Normalize PA → AP (same department, different label convention)
  // C stays as C (cytology, different department)
  const caseBase = match[1].toUpperCase().replace(/^PA/, 'AP');

  // Extract suffix: everything after caseBase in the normalized string
  const rawSuffix = normalized.slice(match[0].length).trim();
  const label = rawSuffix ? rawSuffix.toUpperCase() : '1'; // Default label when no suffix

  return {
    caseBase,
    label,
    externalCaseId: `pathoweb:${caseBase}`,
    externalCaseBase: caseBase,
  };
}
