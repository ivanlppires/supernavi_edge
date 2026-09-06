/**
 * Label photo of a slide.
 *
 * Motic scanners write `<file>.svs.dsmeta/label.jpg` (a photo of the label,
 * usually with the handwritten case number) next to each SVS. We copy it into
 * derived/{slideId}/label.jpg at P0 so it survives scanner-folder cleanup and
 * so the uploaders can ship it to the cloud next to thumb.jpg. Everything here
 * is best-effort: a missing photo is normal (inbox uploads, other scanners).
 */

import { access, copyFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DEFAULT_DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

/**
 * @param {string} slideId
 * @param {string} [derivedDir]
 * @returns {Promise<string|null>} derived/{slideId}/label.jpg if present
 */
export async function findLabelPath(slideId, derivedDir = DEFAULT_DERIVED_DIR) {
  const dest = join(derivedDir, slideId, 'label.jpg');
  try {
    await access(dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Candidate locations of the original Motic photo, in order:
 *   1. `${dsmetaDir}/label.jpg` — the folder recorded in slides.dsmeta_path at
 *      registration (survives a re-ingest that moved raw_path into /data/raw)
 *   2. `${rawPath}.dsmeta/label.jpg` — the folder Motic writes next to the SVS
 *
 * @param {string|null|undefined} rawPath
 * @param {string|null|undefined} dsmetaDir
 * @returns {string[]}
 */
export function labelPhotoCandidates(rawPath, dsmetaDir) {
  const candidates = [];
  if (dsmetaDir) candidates.push(join(dsmetaDir, 'label.jpg'));
  if (rawPath) candidates.push(`${rawPath}.dsmeta/label.jpg`);
  return candidates;
}

/**
 * Copy the Motic label photo into derived/{slideId}/label.jpg.
 * Idempotent; never throws.
 *
 * @param {string} slideId
 * @param {string|null|undefined} rawPath path of the SVS as registered
 * @param {string} [derivedDir]
 * @param {string|null} [dsmetaDir] slides.dsmeta_path when known
 * @returns {Promise<string|null>} path of the derived copy, or null
 */
export async function copyLabelFromDsmeta(slideId, rawPath, derivedDir = DEFAULT_DERIVED_DIR, dsmetaDir = null) {
  const existing = await findLabelPath(slideId, derivedDir);
  if (existing) return existing;

  let source = null;
  for (const candidate of labelPhotoCandidates(rawPath, dsmetaDir)) {
    try {
      await access(candidate);
      source = candidate;
      break;
    } catch {
      // try the next location
    }
  }
  if (!source) return null;

  const dest = join(derivedDir, slideId, 'label.jpg');
  try {
    await mkdir(join(derivedDir, slideId), { recursive: true });
    await copyFile(source, dest);
    console.log(`[label] Copied label photo for ${slideId.substring(0, 12)} from ${source}`);
    return dest;
  } catch (err) {
    console.warn(`[label] Could not copy label photo for ${slideId.substring(0, 12)}: ${err.message}`);
    return null;
  }
}
