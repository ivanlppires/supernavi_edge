/**
 * Rebased Preview Generator
 *
 * Generates a "rebased" tile pyramid for remote preview.
 * Instead of using tiles from the original pyramid levels,
 * this creates a NEW pyramid where:
 *   - The base image is scaled so max(width,height) = PREVIEW_TARGET_MAX_DIM
 *   - Tiles are generated from this scaled base image
 *   - levelMax = PREVIEW_MAX_LEVEL represents zoom levels of the SCALED image
 *
 * This allows OpenSeadragon to render a meaningful preview with proper zoom.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, access, readFile, readdir, unlink, rm, stat } from 'fs/promises';
import { join, dirname } from 'path';
import pg from 'pg';

const execAsync = promisify(exec);
const { Pool } = pg;

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const RAW_DIR = process.env.RAW_DIR || '/data/raw';
const TILE_SIZE = 256;
const TILE_QUALITY = 90;
const GENERATION_TIMEOUT_MS = 300000; // 5 minutes for large operations
const DEFAULT_TARGET_MAX_DIM = parseInt(process.env.PREVIEW_TARGET_MAX_DIM || '2048', 10);
const DEFAULT_MAX_PREVIEW_LEVEL = parseInt(process.env.PREVIEW_MAX_LEVEL || '6', 10);

/**
 * Check if file/directory exists
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up temp file/directory if it exists
 */
async function cleanup(path) {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {}
}

/**
 * Load manifest for a slide
 */
async function loadManifest(slideId) {
  const manifestPath = join(DERIVED_DIR, slideId, 'manifest.json');
  const content = await readFile(manifestPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Get raw file path for a slide.
 * Checks RAW_DIR first, falls back to raw_path from DB (scanner adapter case).
 */
async function findRawPath(slideId) {
  // Try RAW_DIR first (watcher flow: /data/raw/{slideId}_{filename})
  try {
    const files = await readdir(RAW_DIR);
    for (const file of files) {
      if (file.startsWith(slideId)) {
        return join(RAW_DIR, file);
      }
    }
  } catch { /* RAW_DIR may not exist */ }

  // Fallback: query DB for raw_path (scanner adapter stores /scanner/... path)
  const dbUrl = process.env.DATABASE_URL || 'postgres://supernavi:supernavi@db:5432/supernavi';
  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    const result = await pool.query('SELECT raw_path FROM slides WHERE id = $1', [slideId]);
    if (result.rows.length > 0 && result.rows[0].raw_path) {
      const dbPath = result.rows[0].raw_path;
      await stat(dbPath); // verify file exists
      return dbPath;
    }
  } finally {
    await pool.end();
  }

  throw new Error(`Raw file not found for slide: ${slideId}`);
}

/**
 * Calculate rebased dimensions
 * Scales the original image so max dimension = targetMaxDim
 *
 * @param {number} originalWidth - Original image width
 * @param {number} originalHeight - Original image height
 * @param {number} targetMaxDim - Target max dimension (e.g., 2048)
 * @returns {{width: number, height: number, scale: number}}
 */
export function calculateRebasedDimensions(originalWidth, originalHeight, targetMaxDim = DEFAULT_TARGET_MAX_DIM) {
  const maxDim = Math.max(originalWidth, originalHeight);

  // Never upscale: if targetMaxDim >= original, use original dimensions
  if (targetMaxDim >= maxDim) {
    return { width: originalWidth, height: originalHeight, scale: 1 };
  }

  const scale = maxDim / targetMaxDim;

  return {
    width: Math.round(originalWidth / scale),
    height: Math.round(originalHeight / scale),
    scale
  };
}

/**
 * Calculate tiles needed for a rebased level
 *
 * @param {number} rebasedWidth - Width of rebased image
 * @param {number} rebasedHeight - Height of rebased image
 * @param {number} z - Zoom level (0 = smallest)
 * @param {number} maxLevel - Maximum zoom level (where image is full rebased size)
 * @returns {Array<{x: number, y: number}>}
 */
export function calculateRebasedTilesForLevel(rebasedWidth, rebasedHeight, z, maxLevel) {
  const scale = Math.pow(2, maxLevel - z);
  const levelWidth = Math.ceil(rebasedWidth / scale);
  const levelHeight = Math.ceil(rebasedHeight / scale);

  const tilesX = Math.ceil(levelWidth / TILE_SIZE);
  const tilesY = Math.ceil(levelHeight / TILE_SIZE);

  const tiles = [];
  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      tiles.push({ x, y });
    }
  }

  return tiles;
}

/**
 * Count total tiles for rebased preview
 */
export function countRebasedTiles(rebasedWidth, rebasedHeight, maxLevel) {
  let total = 0;
  for (let z = 0; z <= maxLevel; z++) {
    const tiles = calculateRebasedTilesForLevel(rebasedWidth, rebasedHeight, z, maxLevel);
    total += tiles.length;
  }
  return total;
}

/**
 * Generate rebased base image from original
 * Creates a downsampled version of the original at rebased dimensions
 *
 * @param {string} rawPath - Path to original image
 * @param {string} basePath - Path to save rebased base image
 * @param {number} rebasedWidth - Target width
 * @param {number} rebasedHeight - Target height
 */
async function generateRebasedBase(rawPath, basePath, rebasedWidth, rebasedHeight) {
  await mkdir(dirname(basePath), { recursive: true });

  // Use vips thumbnail which is optimized for downscaling large images
  // It uses the pyramid levels if available
  const cmd = `vips thumbnail "${rawPath}" "${basePath}[Q=${TILE_QUALITY}]" ${rebasedWidth} --height ${rebasedHeight} --size force`;
  await execAsync(cmd, { timeout: GENERATION_TIMEOUT_MS });
}

/**
 * Generate DZI tiles from rebased base image using vips dzsave
 *
 * @param {string} basePath - Path to rebased base image
 * @param {string} outputDir - Directory to save tiles (will create tiles/ subfolder)
 * @param {number} maxLevel - Max level to generate
 */
async function generateDziFromBase(basePath, outputDir, maxLevel) {
  const tmpDir = join(outputDir, 'preview_tmp');

  // Clean up any existing temp dir
  await cleanup(tmpDir);
  await mkdir(tmpDir, { recursive: true });

  // Use vips dzsave to generate DZI pyramid into preview_tmp/
  const cmd = `vips dzsave "${basePath}" "${tmpDir}/pyramid" --suffix .jpg[Q=${TILE_QUALITY}] --tile-size ${TILE_SIZE} --overlap 0`;
  await execAsync(cmd, { timeout: GENERATION_TIMEOUT_MS });

  return tmpDir;
}

/**
 * Move tiles from DZI structure to our flat structure
 * vips dzsave creates: pyramid_files/{level}/{col}_{row}.jpg
 * We need: preview_tiles/{level}/{x}_{y}.jpg
 *
 * IMPORTANT: vips dzsave levels are numbered from 0 (smallest/1x1) to N (full size).
 * Our levels are: 0 (smallest) to maxLevel (rebased full size).
 * We need to map: our level z -> vips level (vipsMaxLevel - maxLevel + z)
 *
 * Example with 1796x2048 rebased image:
 * - vips creates levels 0-11 (level 11 = 1796x2048)
 * - we want levels 0-6 where level 6 = 1796x2048
 * - mapping: our 6 -> vips 11, our 5 -> vips 10, ..., our 0 -> vips 5
 *
 * @param {string} dziDir - Directory with DZI output (pyramid_files)
 * @param {string} targetDir - Target directory for tiles
 * @param {number} maxLevel - Max level we want (our numbering)
 */
async function reorganizeDziTiles(dziDir, targetDir, maxLevel) {
  const pyramidFilesDir = join(dziDir, 'pyramid_files');

  // Find all level directories from vips
  const levelDirs = await readdir(pyramidFilesDir);
  const vipsLevels = levelDirs
    .filter(d => /^\d+$/.test(d))
    .map(d => parseInt(d, 10))
    .sort((a, b) => a - b);

  if (vipsLevels.length === 0) {
    throw new Error('No level directories found in DZI output');
  }

  const vipsMaxLevel = Math.max(...vipsLevels);

  // Map our levels to vips levels
  // Our level z (where maxLevel = full size) maps to vips level (vipsMaxLevel - maxLevel + z)
  const { copyFile } = await import('fs/promises');

  for (let ourLevel = 0; ourLevel <= maxLevel; ourLevel++) {
    const vipsLevel = vipsMaxLevel - maxLevel + ourLevel;

    if (vipsLevel < 0 || !vipsLevels.includes(vipsLevel)) {
      console.log(`    Skipping our level ${ourLevel} (vips level ${vipsLevel} not available)`);
      continue;
    }

    const srcLevelDir = join(pyramidFilesDir, String(vipsLevel));
    const dstLevelDir = join(targetDir, String(ourLevel));

    await mkdir(dstLevelDir, { recursive: true });

    const files = await readdir(srcLevelDir);
    let copied = 0;
    for (const file of files) {
      if (file.endsWith('.jpg') || file.endsWith('.jpeg')) {
        const srcPath = join(srcLevelDir, file);
        const dstPath = join(dstLevelDir, file);
        await copyFile(srcPath, dstPath);
        copied++;
      }
    }
    console.log(`    Level ${ourLevel} (from vips ${vipsLevel}): ${copied} tiles`);
  }

  return vipsMaxLevel;
}

/**
 * Generate rebased preview tiles
 *
 * Creates a complete tile pyramid for the preview based on a downscaled
 * version of the original image.
 *
 * @param {string} slideId - Slide identifier
 * @param {number} maxLevel - Maximum preview level (default from env)
 * @param {number} targetMaxDim - Target max dimension for rebased image
 * @returns {Promise<{
 *   rebasedWidth: number,
 *   rebasedHeight: number,
 *   scale: number,
 *   totalTiles: number,
 *   byLevel: Object,
 *   generated: number
 * }>}
 */
export async function generateRebasedPreviewTiles(
  slideId,
  maxLevel = DEFAULT_MAX_PREVIEW_LEVEL,
  targetMaxDim = DEFAULT_TARGET_MAX_DIM
) {
  const startTime = Date.now();

  console.log(`[generateRebasedPreviewTiles] slideId=${slideId} maxLevel=${maxLevel} targetMaxDim=${targetMaxDim}`);

  // Load manifest to get original dimensions
  const manifest = await loadManifest(slideId);
  const { width: originalWidth, height: originalHeight } = manifest;

  // Calculate rebased dimensions
  const rebased = calculateRebasedDimensions(originalWidth, originalHeight, targetMaxDim);
  console.log(`  Original: ${originalWidth}x${originalHeight}`);
  console.log(`  Rebased: ${rebased.width}x${rebased.height} (scale=${rebased.scale.toFixed(3)})`);

  // Cap maxLevel at the natural level count for the image
  const naturalMaxLevel = Math.ceil(Math.log2(Math.max(rebased.width, rebased.height)));
  if (maxLevel > naturalMaxLevel) {
    console.log(`  Capping maxLevel from ${maxLevel} to ${naturalMaxLevel} (natural for ${rebased.width}x${rebased.height})`);
    maxLevel = naturalMaxLevel;
  }

  // Calculate expected tiles
  const totalTiles = countRebasedTiles(rebased.width, rebased.height, maxLevel);
  console.log(`  Total tiles expected for levels 0..${maxLevel}: ${totalTiles}`);

  // Paths
  const slideDir = join(DERIVED_DIR, slideId);
  const rawPath = await findRawPath(slideId);
  const basePath = join(slideDir, 'preview_base.jpg');
  const previewTilesDir = join(slideDir, 'preview_tiles');

  // Step 1: Generate rebased base image (skip if no downscaling needed)
  let dzsavePath;
  if (rebased.scale <= 1) {
    console.log(`  No downscaling needed - using original file directly for dzsave`);
    dzsavePath = rawPath;
  } else {
    console.log(`  Generating rebased base image...`);
    await generateRebasedBase(rawPath, basePath, rebased.width, rebased.height);
    console.log(`    Base image created: ${rebased.width}x${rebased.height}`);
    dzsavePath = basePath;
  }

  // Step 2: Generate DZI tiles into preview_tmp/
  console.log(`  Generating DZI tiles...`);
  const tmpDir = await generateDziFromBase(dzsavePath, slideDir, maxLevel);

  // Step 3: Reorganize tiles from preview_tmp/ to preview_tiles/
  console.log(`  Reorganizing tiles...`);
  await cleanup(previewTilesDir);
  await mkdir(previewTilesDir, { recursive: true });
  const actualMaxLevel = await reorganizeDziTiles(tmpDir, previewTilesDir, maxLevel);
  console.log(`    Actual max level from DZI: ${actualMaxLevel}`);

  // Step 4: Count generated tiles per level
  const byLevel = {};
  let generated = 0;

  for (let z = 0; z <= maxLevel; z++) {
    const levelDir = join(previewTilesDir, String(z));
    try {
      const files = await readdir(levelDir);
      const jpgFiles = files.filter(f => f.endsWith('.jpg'));
      byLevel[z] = { tiles: jpgFiles.length };
      generated += jpgFiles.length;
    } catch {
      byLevel[z] = { tiles: 0 };
    }
  }

  // Clean up temp files
  await cleanup(basePath);
  await cleanup(tmpDir);

  const elapsed = Date.now() - startTime;
  console.log(`[generateRebasedPreviewTiles] complete: generated=${generated} expected=${totalTiles} elapsed=${elapsed}ms`);

  return {
    rebasedWidth: rebased.width,
    rebasedHeight: rebased.height,
    scale: rebased.scale,
    maxLevel,
    totalTiles,
    byLevel,
    generated,
    actualMaxLevel: Math.min(actualMaxLevel, maxLevel)
  };
}

/**
 * Get rebased preview configuration
 */
export function getRebasedConfig() {
  return {
    targetMaxDim: DEFAULT_TARGET_MAX_DIM,
    maxLevel: DEFAULT_MAX_PREVIEW_LEVEL,
    tileSize: TILE_SIZE
  };
}

/**
 * Check if rebased preview tiles exist
 */
export async function hasRebasedPreviewTiles(slideId) {
  const previewTilesDir = join(DERIVED_DIR, slideId, 'preview_tiles');
  return exists(previewTilesDir);
}
