/**
 * SVS/WSI Pipeline - Edge-First Architecture
 *
 * P0: Quick metadata extraction + thumbnail (instant viewer access)
 * Post-P0: Pre-generate low-level tiles (0-N) for fast initial viewing
 * High-zoom tiles: Generated on-demand by API
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, unlink, access } from 'fs/promises';
import { join, basename } from 'path';

const execAsync = promisify(exec);

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILE_SIZE = 256;
const TILE_OVERLAP = 0;

/**
 * Get slide properties using openslide-show-properties
 */
async function getSlideProperties(rawPath) {
  try {
    const { stdout } = await execAsync(`openslide-show-properties "${rawPath}"`);
    const props = {};

    for (const line of stdout.split('\n')) {
      const match = line.match(/^(.+?):\s*(.+)$/);
      if (match) {
        // Strip quotes from values (openslide outputs values like '10961')
        let value = match[2].trim();
        if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        props[match[1].trim()] = value;
      }
    }

    // Extract dimensions
    const width = parseInt(props['openslide.level[0].width'] || props['width'] || '0', 10);
    const height = parseInt(props['openslide.level[0].height'] || props['height'] || '0', 10);

    // Extract magnification metadata (Aperio format)
    const appMag = parseFloat(props['aperio.AppMag'] || '0') || null;
    const mpp = parseFloat(props['aperio.MPP'] || '0') || null;

    return { width, height, appMag, mpp, props };
  } catch (err) {
    console.error('openslide-show-properties failed, trying vipsheader...');
    return getSlidePropertiesVips(rawPath);
  }
}

/**
 * Fallback: get dimensions using vipsheader
 */
async function getSlidePropertiesVips(rawPath) {
  const { stdout } = await execAsync(`vipsheader -a "${rawPath}"`);
  const lines = stdout.split('\n');

  let width = 0, height = 0;
  for (const line of lines) {
    if (line.includes('width:')) {
      width = parseInt(line.split(':')[1].trim(), 10);
    }
    if (line.includes('height:')) {
      height = parseInt(line.split(':')[1].trim(), 10);
    }
  }

  return { width, height, appMag: null, mpp: null, props: {} };
}

/**
 * Calculate max level for DeepZoom (DZI standard)
 * vips dzsave uses: maxLevel = ceil(log2(maxDim))
 * Level 0 = 1x1 pixel, Level maxLevel = full resolution
 */
function calculateMaxLevel(width, height) {
  const maxDim = Math.max(width, height);
  return Math.ceil(Math.log2(maxDim));
}

/**
 * Generate thumbnail using vips
 */
async function generateThumbnail(rawPath, outputPath) {
  // Generate a 640x400 (16:10) centre-cropped thumbnail.
  // This matches the dashboard card aspect ratio and avoids low-res
  // stretched thumbnails for elongated slides (e.g. 100000x20000).
  await execAsync(
    `vips thumbnail "${rawPath}" "${outputPath}" 640 --height 400 --crop centre`
  );
  console.log(`Generated thumbnail: ${outputPath}`);
}

/**
 * Process SVS/WSI file (P0 phase) - Edge-First
 *
 * Only extracts metadata and generates thumbnail.
 * Tiles are generated on-demand by the API.
 */
export async function processSVS_P0(job) {
  const { slideId, rawPath } = job;
  const slideDir = join(DERIVED_DIR, slideId);

  await mkdir(slideDir, { recursive: true });

  console.log(`Processing SVS P0 (edge-first): ${basename(rawPath)}`);

  // Get slide dimensions and magnification metadata
  const { width, height, appMag, mpp } = await getSlideProperties(rawPath);
  console.log(`Slide dimensions: ${width}x${height}`);
  console.log(`Magnification: ${appMag}x, MPP: ${mpp} µm/pixel`);

  if (!width || !height) {
    throw new Error('Could not determine slide dimensions');
  }

  const maxLevel = calculateMaxLevel(width, height);
  console.log(`Max level: ${maxLevel}`);

  // Generate thumbnail (quick)
  const thumbPath = join(slideDir, 'thumb.jpg');
  await generateThumbnail(rawPath, thumbPath);

  // Create tiles directory (tiles generated on-demand)
  const tilesDir = join(slideDir, 'tiles');
  await mkdir(tilesDir, { recursive: true });

  // Generate manifest immediately (viewer can start)
  const manifest = {
    protocol: 'dzi',
    tileSize: TILE_SIZE,
    overlap: TILE_OVERLAP,
    format: 'jpg',
    width,
    height,
    levelMin: 0,
    levelMax: maxLevel,
    tilePathPattern: 'tiles/{z}/{x}_{y}.jpg',
    tileUrlTemplate: `/v1/slides/${slideId}/tiles/{z}/{x}/{y}.jpg`,
    onDemand: true,  // Tiles generated on-demand
    // Magnification metadata for proper zoom display
    appMag: appMag,  // Native scan magnification (e.g., 20, 40)
    mpp: mpp         // Microns per pixel
  };

  const manifestPath = join(slideDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Generated manifest: ${manifestPath}`);

  console.log(`SVS P0 complete - viewer ready (tiles on-demand)`);

  return {
    width,
    height,
    maxLevel,
    p0MaxLevel: 0,        // No tiles pre-generated
    levelReadyMax: 0,     // Tiles generated on-demand
    thumbPath,
    manifestPath,
    appMag,               // Native scan magnification
    mpp                   // Microns per pixel
  };
}

/**
 * Pre-generate low-level tiles for faster initial viewing.
 *
 * Called AFTER the slide is already marked "ready" (viewer can open immediately).
 * Generates tiles for levels 0 through maxPregenLevel using vips thumbnail + crop.
 *
 * For each level:
 *   1. Create a thumbnail of the whole image at the level's pixel dimensions
 *   2. Split into 256x256 tiles (most low levels fit in a single tile)
 *   3. Save to tiles/{z}/{x}_{y}.jpg (same path as on-demand tiles)
 */
export async function pregenerateLowLevelTiles(slideId, rawPath, width, height, maxLevel, maxPregenLevel) {
  const effectiveMax = Math.min(maxPregenLevel, maxLevel);
  const startTime = Date.now();
  let tileCount = 0;
  const tilesDir = join(DERIVED_DIR, slideId, 'tiles');

  console.log(`[Pregen] Starting tile pre-generation for levels 0-${effectiveMax}...`);

  for (let z = 0; z <= effectiveMax; z++) {
    const scale = Math.pow(2, maxLevel - z);
    const levelWidth = Math.max(1, Math.ceil(width / scale));
    const levelHeight = Math.max(1, Math.ceil(height / scale));

    const tilesX = Math.ceil(levelWidth / TILE_SIZE);
    const tilesY = Math.ceil(levelHeight / TILE_SIZE);

    const levelDir = join(tilesDir, String(z));
    await mkdir(levelDir, { recursive: true });

    // For single-tile levels (most low levels), generate directly as the tile
    if (tilesX === 1 && tilesY === 1) {
      const tilePath = join(levelDir, '0_0.jpg');
      // Skip if already exists (idempotent)
      if (await fileExists(tilePath)) {
        tileCount++;
        continue;
      }
      await execAsync(
        `vips thumbnail "${rawPath}" "${tilePath}[Q=90]" ${levelWidth} --height ${levelHeight} --size force`,
        { timeout: 30000 }
      );
      tileCount++;
      continue;
    }

    // Multi-tile level: create full level image, then crop into tiles
    const levelTempPath = join(tilesDir, `_level_${z}_temp.jpg`);
    try {
      await execAsync(
        `vips thumbnail "${rawPath}" "${levelTempPath}[Q=95]" ${levelWidth} --height ${levelHeight} --size force`,
        { timeout: 60000 }
      );

      for (let x = 0; x < tilesX; x++) {
        for (let y = 0; y < tilesY; y++) {
          const tilePath = join(levelDir, `${x}_${y}.jpg`);
          if (await fileExists(tilePath)) {
            tileCount++;
            continue;
          }

          const cropX = x * TILE_SIZE;
          const cropY = y * TILE_SIZE;
          const cropW = Math.min(TILE_SIZE, levelWidth - cropX);
          const cropH = Math.min(TILE_SIZE, levelHeight - cropY);

          await execAsync(
            `vips crop "${levelTempPath}" "${tilePath}[Q=90]" ${cropX} ${cropY} ${cropW} ${cropH}`,
            { timeout: 10000 }
          );
          tileCount++;
        }
      }
    } finally {
      await unlink(levelTempPath).catch(() => {});
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[Pregen] Complete: ${tileCount} tiles (levels 0-${effectiveMax}) in ${elapsed}ms`);

  return { tileCount, elapsed, levelReadyMax: effectiveMax };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * P1 for SVS is a no-op (tiles are generated on-demand by API)
 */
export async function processSVS_P1(job) {
  console.log(`SVS P1: No-op (tiles generated on-demand)`);
  return { completed: true, levelReadyMax: 0 };
}
