/**
 * Motic .dsmeta parser and scanner path parser.
 *
 * Parses the info.txt metadata file that accompanies each SVS file
 * from Motic scanners, and extracts structured data from the
 * Motic directory hierarchy.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Parse a .dsmeta directory's info.txt file.
 *
 * @param {string} dsmetaDir - Path to the .dsmeta directory
 * @returns {Promise<{guid: string, width: number|null, height: number|null, barcode: string} | null>}
 */
export async function parseDsmeta(dsmetaDir) {
  try {
    const content = await readFile(join(dsmetaDir, 'info.txt'), 'utf8');
    const lines = content.split(/\r?\n/);

    let guid = null;
    let width = null;
    let height = null;
    let barcode = null;

    for (const line of lines) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (!match) continue;
      const [, key, value] = match;

      switch (key) {
        case 'Guid': guid = value.trim(); break;
        case 'mifwidth': width = parseInt(value.trim(), 10) || null; break;
        case 'mifheight': height = parseInt(value.trim(), 10) || null; break;
        case 'Barcode': barcode = value.trim(); break;
      }
    }

    if (!guid && !barcode) return null;

    return { guid, width, height, barcode };
  } catch {
    return null;
  }
}

/**
 * Parse a Motic scanner file path to extract structured metadata.
 *
 * Expected path format:
 *   /scanner/{year}/{monthday}/{GUID}/{barcode_datetime}/{barcode_datetime}.svs
 *
 * @param {string} filePath
 * @returns {{ year: string, monthday: string, guid: string, barcode: string, scanDatetime: string, filename: string } | null}
 */
export function parseMoticPath(filePath) {
  const regex = /\/scanner\/(\d{4})\/(\d{4})\/([A-F0-9-]{36})\/(\d+)_(\d{14})\/(.+\.svs)$/i;
  const match = filePath.match(regex);
  if (!match) return null;

  return {
    year: match[1],
    monthday: match[2],
    guid: match[3].toUpperCase(),
    barcode: match[4],
    scanDatetime: match[5],
    filename: match[6],
  };
}
