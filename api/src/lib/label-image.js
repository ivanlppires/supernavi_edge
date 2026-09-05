import { access } from 'fs/promises';
import { join } from 'path';

/**
 * Where the label photo of a slide lives, if anywhere:
 *   1. derived/{slideId}/label.jpg — copied by the processor at P0 (survives
 *      scanner folder cleanup and is what gets uploaded to the cloud)
 *   2. {dsmeta_path}/label.jpg     — the original Motic photo
 *
 * @param {string} derivedDir
 * @param {string} slideId
 * @param {string|null} dsmetaPath
 * @returns {Promise<string|null>}
 */
export async function resolveLabelImagePath(derivedDir, slideId, dsmetaPath) {
  const candidates = [join(derivedDir, slideId, 'label.jpg')];
  if (dsmetaPath) candidates.push(join(dsmetaPath, 'label.jpg'));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}
