/**
 * Label OCR via Gemini Vision API.
 *
 * Sends slide images to Gemini and extracts the case identifier.
 * Primary source: slide2.jpg (full slide overview, code visible at top).
 * Fallback: label.jpg + slide2.jpg cross-reference.
 *
 * Labels contain:
 *   - Printed text: case number (e.g., AP26000388 or IM26000100)
 *   - Handwritten text: flask/slide suffix (e.g., A1, B, A2)
 *
 * Prefixes:
 *   AP = Anatomopatológico
 *   PA = Patologia Anatômica (alias for AP)
 *   C  = Citologia
 *   IM = Imuno-histoquímico
 *
 * Pattern: [AP|PA|C|IM][6-8 digits][letter][optional digit(s)]
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';

const OCR_MODEL = process.env.OCR_MODEL || 'gemini-2.5-flash';

const OCR_RESPONSE_REGEX = /^((?:AP|PA|IM|C)\d{6,12})([A-Z]\d*)?$/i;

// Abbreviated format: digits[-_]digits + optional suffix (e.g., 26_388A, 96-621)
// The separator (underscore or hyphen) replaces suppressed zeros: 26_388 → 26000388
const ABBREVIATED_REGEX = /^(\d{2})[-_](\d{1,6})([A-Z]\d*)?$/i;

// Common handwritten digit misreads: 2↔9 (curved 2 looks like 9)
const DIGIT_CORRECTIONS = { '9': '2', '2': '9' };

/**
 * Correct the year part of abbreviated format when it's outside a plausible range.
 * Pathology slides use YY (2-digit year). Valid range: 20–current year.
 * If the OCR'd year is implausible, try common digit substitutions.
 */
function correctYear(yearStr) {
  const currentYear = new Date().getFullYear() % 100; // e.g., 26
  const year = parseInt(yearStr, 10);
  if (year >= 20 && year <= currentYear) return yearStr;

  // Try correcting each digit with common misreads
  for (let i = 0; i < yearStr.length; i++) {
    const replacement = DIGIT_CORRECTIONS[yearStr[i]];
    if (!replacement) continue;
    const candidate = yearStr.substring(0, i) + replacement + yearStr.substring(i + 1);
    const candidateYear = parseInt(candidate, 10);
    if (candidateYear >= 20 && candidateYear <= currentYear) return candidate;
  }

  return yearStr; // no correction found, keep original
}

let client = null;

async function getClient() {
  if (!client) {
    const apiKey = process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_GENAI_API_KEY not set');
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    client = new GoogleGenerativeAI(apiKey);
  }
  return client;
}

/**
 * Parse the raw OCR text response into structured data.
 * Exported for testing.
 *
 * @param {string|null} text - Raw text from OCR
 * @returns {{ fullName: string, caseBase: string, slideLabel: string } | null}
 */
export function parseOcrResponse(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim().toUpperCase();
  if (!trimmed) return null;

  // First try abbreviated format: 26_388A → AP26000388A
  // Lab convention: underscore replaces suppressed zeros, default prefix is AP
  const abbrMatch = trimmed.match(ABBREVIATED_REGEX);
  if (abbrMatch) {
    const prefix = 'AP'; // default to AP unless explicitly IM
    const left = correctYear(abbrMatch[1]);        // e.g., "96" → "26"
    const right = abbrMatch[2];                    // e.g., "388"
    const suffix = (abbrMatch[3] || '').toUpperCase(); // e.g., "A"
    // Pad with zeros between left and right to reach 8 digits total
    const totalDigits = 8;
    const zerosNeeded = totalDigits - left.length - right.length;
    const caseBase = prefix + left + '0'.repeat(Math.max(0, zerosNeeded)) + right;
    const fullName = caseBase + suffix;
    return { fullName, caseBase, slideLabel: suffix };
  }

  // Standard format: AP26000388A1 or IM26000100B2
  const cleaned = trimmed.replace(/[\s\-_.]/g, '');
  if (!cleaned) return null;

  const match = cleaned.match(OCR_RESPONSE_REGEX);
  if (!match) return null;

  // Normalize PA → AP (same department, different label convention)
  const caseBase = match[1].replace(/^PA/, 'AP');
  const slideLabel = match[2] || '';
  const fullName = caseBase + slideLabel;

  return { fullName, caseBase, slideLabel };
}

const SLIDE_OVERVIEW_PROMPT = `This is a photo of an entire pathology slide. The case identifier is usually HANDWRITTEN on the TOP PORTION of the slide (the label area).

Look at the upper part of the image to find the identifier.

The identifier format:
- Starts with AP or PA (Anatomopatológico), C (Citologia), or IM (Imuno-histoquímico), followed by 6-8 digits.
- May have a handwritten suffix: flask letter (A, B, C...) and optional slide number (1, 2, 3...).
- May be ABBREVIATED: "26-388A" or "26_388A" means AP26000388A (zeros suppressed, separator is hyphen or underscore).

IMPORTANT: The first two digits are the YEAR. Current year is ${new Date().getFullYear()} (abbreviated: ${String(new Date().getFullYear()).slice(-2)}). Handwritten "2" often looks like "9" — if you see what looks like "96", it is almost certainly "26".

Examples:
  Full: AP26000388A1, AP26000388B, PA26000019, C26000588A, IM26000100A2
  Abbreviated: 26-388A, 26_388B2, 26-621, 26_100A

Ignore patient names, doctor names, "urgente", or other annotations. Only extract the case identifier.

Reply with ONLY the identifier (e.g., "AP26000388A1" or "26-388A"). No other text.
If you cannot read the identifier, reply with UNREADABLE.`;

/**
 * Read an image file and return base64 + media type.
 */
async function readImage(imagePath) {
  const data = await readFile(imagePath);
  const ext = imagePath.split('.').pop().toLowerCase();
  return {
    base64: data.toString('base64'),
    mediaType: ext === 'png' ? 'image/png' : 'image/jpeg',
  };
}

/**
 * Call Gemini Vision with one or more images and a prompt.
 */
async function callVision(images, prompt) {
  const parts = [
    ...images.map(img => ({
      inlineData: { mimeType: img.mediaType, data: img.base64 },
    })),
    { text: prompt },
  ];

  const genai = await getClient();
  const model = genai.getGenerativeModel({
    model: OCR_MODEL,
    generationConfig: { maxOutputTokens: 100, temperature: 0 },
  });
  const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
  return result.response.text() || '';
}

/**
 * OCR a slide's label from its .dsmeta directory.
 * Single-attempt: tries slide2.jpg (full slide with the code on top).
 * Returns null on UNREADABLE / missing slide2 / parse failure.
 * The technician confirms or overrides the result via the review queue.
 *
 * @param {string} dsmetaDir - Path to the .dsmeta directory
 * @returns {Promise<{ fullName: string, caseBase: string, slideLabel: string } | null>}
 */
export async function ocrLabel(dsmetaDir) {
  const slide2Path = join(dsmetaDir, 'slide2.jpg');
  try {
    await access(slide2Path, constants.R_OK);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  const slide2Image = await readImage(slide2Path);
  const rawText = await callVision([slide2Image], SLIDE_OVERVIEW_PROMPT);
  console.log(`[OCR] slide2.jpg response for ${dsmetaDir}: "${rawText}"`);

  if (rawText.trim().toUpperCase() === 'UNREADABLE') return null;
  return parseOcrResponse(rawText);
}

/**
 * Check if label OCR is enabled.
 */
export function isOcrEnabled() {
  const envFlag = process.env.LABEL_OCR_ENABLED;
  if (envFlag === 'false') return false;
  if (envFlag === 'true') return true;
  return !!process.env.GOOGLE_GENAI_API_KEY;
}
