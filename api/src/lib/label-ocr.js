/**
 * Label OCR via Gemini (Google Gen AI SDK, Gemini 3 family).
 *
 * Single attempt per slide: sends slide2.jpg (photo of the whole slide, the
 * handwritten case number sits on the label at the top) and asks for the
 * identifier only. The answer is never trusted blindly:
 *   - finishReason other than STOP (truncated/blocked) → no name
 *   - UNREADABLE / empty → no name
 *   - anything the shared parser rejects (abbreviated form needs 3+ digits) → no name
 *   - callers additionally drop implausibly low case numbers (case-plausibility.js)
 * A slide without a proposal still uploads; it just waits in the review queue
 * with review_status='pending' (cloud keeps it out of PathoWeb until confirmed).
 *
 * Model and reasoning are configured by env:
 *   OCR_MODEL            default gemini-3.1-pro-preview (the Gemini 3 Pro line)
 *   OCR_THINKING_LEVEL   MINIMAL | LOW | MEDIUM | HIGH ("" = let the model decide); default LOW
 *   OCR_MAX_OUTPUT_TOKENS default 256 — the answer is a short identifier
 *   GOOGLE_GENAI_API_KEY, LABEL_OCR_ENABLED (see isOcrEnabled)
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import { parseSlideName } from './slide-name-parser.js';

export const DEFAULT_OCR_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const DEFAULT_THINKING_LEVEL = 'LOW';

/** Same parser as manual naming — one set of rules for every source. */
export const parseOcrResponse = parseSlideName;

let client = null;

async function getClient() {
  if (!client) {
    const apiKey = process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_GENAI_API_KEY not set');
    const { GoogleGenAI } = await import('@google/genai');
    client = new GoogleGenAI({ apiKey });
  }
  return client;
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
 * Build the generateContent request. Pure; exported for testing.
 * @param {{ mediaType: string, base64: string }[]} images
 * @param {string} prompt
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildRequest(images, prompt, env = process.env) {
  const model = env.OCR_MODEL || DEFAULT_OCR_MODEL;
  const maxOutputTokens = parseInt(env.OCR_MAX_OUTPUT_TOKENS || String(DEFAULT_MAX_OUTPUT_TOKENS), 10);
  const levelRaw = env.OCR_THINKING_LEVEL === undefined ? DEFAULT_THINKING_LEVEL : env.OCR_THINKING_LEVEL;
  const thinkingLevel = String(levelRaw || '').trim().toUpperCase();

  const config = {
    temperature: 0,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS,
    ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
  };

  return {
    model,
    contents: [{
      role: 'user',
      parts: [
        ...images.map(img => ({ inlineData: { mimeType: img.mediaType, data: img.base64 } })),
        { text: prompt },
      ],
    }],
    config,
  };
}

/**
 * Call Gemini with one or more images and a prompt.
 * Returns the raw text plus the candidate's finishReason so callers can tell a
 * complete answer (STOP) from a truncated one (MAX_TOKENS).
 */
async function callVision(images, prompt) {
  const ai = await getClient();
  const response = await ai.models.generateContent(buildRequest(images, prompt));
  const candidate = response?.candidates?.[0];
  let text = '';
  try {
    text = response?.text || '';
  } catch {
    text = ''; // blocked / empty candidate — treated as unreadable by the caller
  }
  return { text, finishReason: candidate?.finishReason || null };
}

/**
 * Turn a raw model answer + finishReason into a decision.
 * Exported for testing.
 *
 * @returns {{ status: 'ok'|'unreadable'|'truncated'|'blocked'|'unparsed', raw: string, finishReason: string|null, result: object|null }}
 */
export function interpretOcrResponse({ text, finishReason }) {
  const raw = (text || '').trim();
  const reason = finishReason || null;

  if (reason && reason !== 'STOP' && reason !== 'FINISH_REASON_UNSPECIFIED') {
    // MAX_TOKENS = the identifier was cut off. A partial identifier is worse
    // than no answer (incident 2026-09-04): never trust it.
    return { status: reason === 'MAX_TOKENS' ? 'truncated' : 'blocked', raw, finishReason: reason, result: null };
  }
  if (!raw || raw.toUpperCase() === 'UNREADABLE') {
    return { status: 'unreadable', raw, finishReason: reason, result: null };
  }
  const result = parseSlideName(raw);
  if (!result) return { status: 'unparsed', raw, finishReason: reason, result: null };
  return { status: 'ok', raw, finishReason: reason, result };
}

/**
 * OCR a slide's label from its .dsmeta directory.
 * @param {string} dsmetaDir
 * @returns {Promise<{ fullName: string, caseBase: string, slideLabel: string } | null>}
 */
export async function ocrLabel(dsmetaDir) {
  const detailed = await ocrLabelDetailed(dsmetaDir);
  return detailed.result;
}

/**
 * Same as ocrLabel() but returns the full decision (status, raw text,
 * finishReason) so callers can record WHY no name was proposed.
 * @param {string} dsmetaDir
 * @returns {Promise<{ status: string, raw: string|null, finishReason: string|null, result: object|null }>}
 */
export async function ocrLabelDetailed(dsmetaDir) {
  const slide2Path = join(dsmetaDir, 'slide2.jpg');
  try {
    await access(slide2Path, constants.R_OK);
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'no_image', raw: null, finishReason: null, result: null };
    throw err;
  }

  const slide2Image = await readImage(slide2Path);
  const { text, finishReason } = await callVision([slide2Image], SLIDE_OVERVIEW_PROMPT);
  const decision = interpretOcrResponse({ text, finishReason });
  console.log(`[OCR] slide2.jpg response for ${dsmetaDir}: "${text}" (finishReason=${finishReason || 'n/a'}, status=${decision.status})`);
  return decision;
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
