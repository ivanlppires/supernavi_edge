/**
 * Label OCR via Claude Vision API.
 *
 * Sends a photo of a slide label to Claude and extracts the case identifier.
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
import { dirname, join } from 'path';
import { constants } from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const OCR_RESPONSE_REGEX = /^((?:AP|PA|IM|C)\d{6,12})([A-Z]\d*)?$/i;

// Abbreviated format: digits_digits + optional suffix (e.g., 26_388A, 26_388B2)
// The underscore replaces suppressed zeros: 26_388 → 26000388
const ABBREVIATED_REGEX = /^(\d{2})[_](\d{1,6})([A-Z]\d*)?$/i;

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic();  // Uses ANTHROPIC_API_KEY env var
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
    const left = abbrMatch[1];                     // e.g., "26"
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

const LABEL_PROMPT = `This is a photo of a pathology slide label. Extract the case identifier.

The label may contain:
- A PRINTED case number starting with AP or PA (Anatomopatológico), C (Citologia), or IM (Imuno-histoquímico), followed by 6-8 digits.
- A HANDWRITTEN suffix indicating flask (A, B, C...) and optionally slide number (1, 2, 3...).
- Sometimes the label is ABBREVIATED with handwriting: "26_388A" means AP26000388A (zeros suppressed with underscore).

Examples of identifiers you may see:
  Full: AP26000388A1, AP26000388B, PA26000019, C26000588A, IM26000100A2
  Abbreviated: 26_388A, 26_388B2, 26_100A (write exactly as seen, e.g. "26_388A")

Ignore any other text on the label such as patient names, doctor names, "urgente", or other annotations. Only extract the case identifier.

Reply with ONLY the identifier as you read it (e.g., "AP26000388A1" or "26_388A"). No other text.
If you cannot read the label, reply with UNREADABLE.`;

const LABEL_WITH_SLIDE_PROMPT = `The label on this pathology slide was difficult to read. Here are TWO images:
1. The label photo (may be blurry, damaged, or partially obscured)
2. A thumbnail of the entire slide (may show printed text, barcodes, or markings on the glass)

Extract the case identifier from EITHER image — whichever is more legible.

The identifier format:
- Starts with AP or PA (Anatomopatológico), C (Citologia), or IM (Imuno-histoquímico), followed by 6-8 digits.
- May have a handwritten suffix: flask letter (A, B, C...) and optional slide number (1, 2, 3...).
- May be ABBREVIATED: "26_388A" means AP26000388A (zeros suppressed with underscore).

Examples:
  Full: AP26000388A1, AP26000388B, PA26000019, C26000588A, IM26000100A2
  Abbreviated: 26_388A, 26_388B2, 26_100A

Ignore patient names, doctor names, "urgente", or other annotations. Only extract the case identifier.

Reply with ONLY the identifier (e.g., "AP26000388A1" or "26_388A"). No other text.
If you cannot read the identifier from either image, reply with UNREADABLE.`;

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
 * Call Claude Vision with one or more images and a prompt.
 */
async function callVision(images, prompt) {
  const content = [
    ...images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    })),
    { type: 'text', text: prompt },
  ];

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [{ role: 'user', content }],
  });

  return response.content?.[0]?.text || '';
}

/**
 * OCR a label image and extract the case identifier.
 * Falls back to sending both label.jpg + slide.jpg if the label alone is unreadable.
 *
 * @param {string} imagePath - Path to label.jpg
 * @returns {Promise<{ fullName: string, caseBase: string, slideLabel: string } | null>}
 */
export async function ocrLabel(imagePath) {
  const labelImage = await readImage(imagePath);

  // First attempt: label only
  const rawText = await callVision([labelImage], LABEL_PROMPT);
  console.log(`[OCR] Raw response for ${imagePath}: "${rawText}"`);

  const isUnreadable = rawText.trim().toUpperCase() === 'UNREADABLE';
  if (!isUnreadable) {
    const result = parseOcrResponse(rawText);
    if (result) return result;
  }

  // Fallback: try with slide.jpg from same directory
  const dsmetaDir = dirname(imagePath);
  const slidePath = join(dsmetaDir, 'slide.jpg');

  try {
    await access(slidePath, constants.R_OK);
  } catch {
    console.log(`[OCR] No slide.jpg fallback available at ${slidePath}`);
    return null;
  }

  console.log(`[OCR] Label unreadable, retrying with slide.jpg from ${dsmetaDir}`);
  const slideImage = await readImage(slidePath);
  const retryText = await callVision([labelImage, slideImage], LABEL_WITH_SLIDE_PROMPT);
  console.log(`[OCR] Retry response (label+slide): "${retryText}"`);

  if (retryText.trim().toUpperCase() === 'UNREADABLE') return null;

  return parseOcrResponse(retryText);
}

/**
 * Check if label OCR is enabled.
 */
export function isOcrEnabled() {
  const envFlag = process.env.LABEL_OCR_ENABLED;
  if (envFlag === 'false') return false;
  if (envFlag === 'true') return true;
  // Default: enabled if API key is present
  return !!process.env.ANTHROPIC_API_KEY;
}
