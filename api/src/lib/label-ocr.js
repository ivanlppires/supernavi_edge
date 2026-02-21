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
 *   IM = Imuno-histoquímico
 *
 * Pattern: [AP|IM][6-8 digits][letter][optional digit(s)]
 */

import { readFile } from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const OCR_RESPONSE_REGEX = /^((?:AP|IM)\d{6,12})([A-Z]\d*)?$/i;

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

  const caseBase = match[1];
  const slideLabel = match[2] || '';
  const fullName = caseBase + slideLabel;

  return { fullName, caseBase, slideLabel };
}

/**
 * OCR a label image and extract the case identifier.
 *
 * @param {string} imagePath - Path to label.jpg
 * @returns {Promise<{ fullName: string, caseBase: string, slideLabel: string } | null>}
 */
export async function ocrLabel(imagePath) {
  const imageData = await readFile(imagePath);
  const base64 = imageData.toString('base64');

  // Detect media type from extension
  const ext = imagePath.split('.').pop().toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: `This is a photo of a pathology slide label. Extract the case identifier.

The label may contain:
- A PRINTED case number starting with AP (Anatomopatológico) or IM (Imuno-histoquímico), followed by 6-8 digits.
- A HANDWRITTEN suffix indicating flask (A, B, C...) and optionally slide number (1, 2, 3...).
- Sometimes the label is ABBREVIATED with handwriting: "26_388A" means AP26000388A (zeros suppressed with underscore).

Examples of identifiers you may see:
  Full: AP26000388A1, AP26000388B, IM26000100A2
  Abbreviated: 26_388A, 26_388B2, 26_100A (write exactly as seen, e.g. "26_388A")

Ignore any other text on the label such as patient names, doctor names, "urgente", or other annotations. Only extract the case identifier.

Reply with ONLY the identifier as you read it (e.g., "AP26000388A1" or "26_388A"). No other text.
If you cannot read the label, reply with UNREADABLE.`,
          },
        ],
      },
    ],
  });

  const rawText = response.content?.[0]?.text || '';
  console.log(`[OCR] Raw response for ${imagePath}: "${rawText}"`);

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
  // Default: enabled if API key is present
  return !!process.env.ANTHROPIC_API_KEY;
}
