/**
 * Ensure Low Level Tiles - Materialize tiles for preview
 *
 * Guarantees that tiles for levels 0..N exist on disk.
 * For WSI (on-demand) slides, generates missing tiles using vips.
 * For image slides (pre-generated), tiles should already exist.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, access, readFile, readdir, unlink, stat } from 'fs/promises';
import { join, dirname } from 'path';
import pg from 'pg';

const execAsync = promisify(exec);
const { Pool } = pg;

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const RAW_DIR = process.env.RAW_DIR || '/data/raw';
const TILE_SIZE = 256;
const TILE_QUALITY = 90;
const GENERATION_TIMEOUT_MS = 60000; // 60 seconds for batch generation
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
 * Clean up temp file if it exists
 */
async function cleanupTemp(path) {
  try {
    await unlink(path);
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
 * Calculate tiles needed for a given level
 * @param {number} width - Full image width
 * @param {number} height - Full image height
 * @param {number} z - Zoom level
 * @param {number} maxLevel - Maximum zoom level
 * @returns {Array<{x: number, y: number}>} List of tile coordinates
 */
function calculateTilesForLevel(width, height, z, maxLevel) {
  const scale = Math.pow(2, maxLevel - z);
  const levelWidth = Math.ceil(width / scale);
  const levelHeight = Math.ceil(height / scale);

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
 * Check which tiles are missing for a level
 */
async function getMissingTiles(slideId, z, neededTiles) {
  const levelDir = join(DERIVED_DIR, slideId, 'tiles', String(z));
  const missing = [];

  for (const tile of neededTiles) {
    const tilePath = join(levelDir, `${tile.x}_${tile.y}.jpg`);
    if (!(await exists(tilePath))) {
      missing.push(tile);
    }
  }

  return missing;
}

/**
 * Generate a single tile using vips
 * Similar to tilegen-svs.js logic but without DB/events dependency
 */
async function generateTile(rawPath, tilePath, z, x, y, manifest) {
  const { width, height, levelMax } = manifest;

  const scale = Math.pow(2, levelMax - z);

  // Source region in full resolution
  const srcX = x * TILE_SIZE * scale;
  const srcY = y * TILE_SIZE * scale;
  let srcWidth = TILE_SIZE * scale;
  let srcHeight = TILE_SIZE * scale;

  // Clamp to bounds
  if (srcX + srcWidth > width) srcWidth = width - srcX;
  if (srcY + srcHeight > height) srcHeight = height - srcY;

  if (srcX >= width || srcY >= height || srcWidth <= 0 || srcHeight <= 0) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }

  await mkdir(dirname(tilePath), { recursive: true });

  const tempPath = tilePath.replace('.jpg', '.tmp.v');

  try {
    // Extract region
    const cropCmd = `vips crop "${rawPath}" "${tempPath}" ${srcX} ${srcY} ${srcWidth} ${srcHeight}`;
    await execAsync(cropCmd, { timeout: GENERATION_TIMEOUT_MS });

    // Resize to tile
    const resizeCmd = `vips resize "${tempPath}" "${tilePath}[Q=${TILE_QUALITY}]" ${1 / scale}`;
    await execAsync(resizeCmd, { timeout: GENERATION_TIMEOUT_MS });

    return true;
  } catch (err) {
    // Fallback: shrink then crop
    return generateTileFallback(rawPath, tilePath, z, x, y, manifest);
  } finally {
    await cleanupTemp(tempPath);
  }
}

/**
 * Fallback tile generation (shrink full image, then crop)
 */
async function generateTileFallback(rawPath, tilePath, z, x, y, manifest) {
  const { width, height, levelMax } = manifest;

  const scale = Math.pow(2, levelMax - z);
  const levelWidth = Math.ceil(width / scale);
  const levelHeight = Math.ceil(height / scale);

  const tileX = x * TILE_SIZE;
  const tileY = y * TILE_SIZE;
  const actualWidth = Math.min(TILE_SIZE, levelWidth - tileX);
  const actualHeight = Math.min(TILE_SIZE, levelHeight - tileY);

  if (actualWidth <= 0 || actualHeight <= 0) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }

  await mkdir(dirname(tilePath), { recursive: true });

  const tempPath = tilePath.replace('.jpg', '.tmp.v');

  try {
    // Shrink to level size
    const shrinkCmd = `vips shrink "${rawPath}" "${tempPath}" ${scale} ${scale}`;
    await execAsync(shrinkCmd, { timeout: GENERATION_TIMEOUT_MS });

    // Crop tile
    const cropCmd = `vips crop "${tempPath}" "${tilePath}[Q=${TILE_QUALITY}]" ${tileX} ${tileY} ${actualWidth} ${actualHeight}`;
    await execAsync(cropCmd, { timeout: GENERATION_TIMEOUT_MS });

    return true;
  } finally {
    await cleanupTemp(tempPath);
  }
}

/**
 * Generate missing tiles for a single level with concurrency
 */
async function generateMissingTilesForLevel(rawPath, slideId, z, missingTiles, manifest, concurrency = 4) {
  let generated = 0;

  for (let i = 0; i < missingTiles.length; i += concurrency) {
    const batch = missingTiles.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (tile) => {
        const tilePath = join(DERIVED_DIR, slideId, 'tiles', String(z), `${tile.x}_${tile.y}.jpg`);
        await generateTile(rawPath, tilePath, z, tile.x, tile.y, manifest);
        generated++;
      })
    );
  }

  return generated;
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
 * Validate all tiles exist for a level
 * Returns list of any tiles that are still missing after generation attempt
 */
async function validateLevelComplete(slideId, z, neededTiles) {
  const levelDir = join(DERIVED_DIR, slideId, 'tiles', String(z));
  const stillMissing = [];

  for (const tile of neededTiles) {
    const tilePath = join(levelDir, `${tile.x}_${tile.y}.jpg`);
    if (!(await exists(tilePath))) {
      stillMissing.push(tile);
    }
  }

  return stillMissing;
}

/**
 * Ensure all tiles for levels 0..maxLevel exist
 *
 * IMPORTANT: This function guarantees a COMPLETE tile pyramid.
 * It will retry generation for any missing tiles and throw an error
 * if the pyramid cannot be completed.
 *
 * @param {string} slideId - Slide identifier
 * @param {number} maxLevel - Maximum level to ensure (default from env)
 * @returns {Promise<{generated: number, existing: number, byLevel: Object, totalExpected: number}>}
 */
export async function ensureLowLevelTiles(slideId, maxLevel = DEFAULT_MAX_PREVIEW_LEVEL) {
  const startTime = Date.now();

  console.log(`[ensureLowLevelTiles] slideId=${slideId} maxLevel=${maxLevel}`);

  // Load manifest to get dimensions
  const manifest = await loadManifest(slideId);
  const { width, height, levelMax } = manifest;

  // Clamp maxLevel to actual slide levels
  const effectiveMaxLevel = Math.min(maxLevel, levelMax);

  console.log(`  Slide: ${width}x${height}, maxLevel=${levelMax}, effective=${effectiveMaxLevel}`);

  const stats = {
    generated: 0,
    existing: 0,
    byLevel: {},
    totalExpected: 0
  };

  // Calculate total expected tiles
  for (let z = 0; z <= effectiveMaxLevel; z++) {
    const neededTiles = calculateTilesForLevel(width, height, z, levelMax);
    stats.totalExpected += neededTiles.length;
  }

  console.log(`  Total tiles expected for levels 0..${effectiveMaxLevel}: ${stats.totalExpected}`);

  // Find raw path only if we might need to generate
  let rawPath = null;

  for (let z = 0; z <= effectiveMaxLevel; z++) {
    const neededTiles = calculateTilesForLevel(width, height, z, levelMax);
    const missingTiles = await getMissingTiles(slideId, z, neededTiles);

    stats.byLevel[z] = {
      total: neededTiles.length,
      missing: missingTiles.length,
      generated: 0
    };

    if (missingTiles.length === 0) {
      stats.existing += neededTiles.length;
      console.log(`  Level ${z}: ${neededTiles.length}/${neededTiles.length} tiles exist`);
      continue;
    }

    // Need to generate missing tiles
    if (!rawPath) {
      rawPath = await findRawPath(slideId);
      console.log(`  Raw path: ${rawPath}`);
    }

    console.log(`  Level ${z}: generating ${missingTiles.length}/${neededTiles.length} tiles...`);

    const generated = await generateMissingTilesForLevel(
      rawPath,
      slideId,
      z,
      missingTiles,
      manifest
    );

    stats.byLevel[z].generated = generated;
    stats.generated += generated;
    stats.existing += neededTiles.length - missingTiles.length;

    // VALIDATION: Verify all tiles now exist for this level
    const stillMissing = await validateLevelComplete(slideId, z, neededTiles);
    if (stillMissing.length > 0) {
      const missingList = stillMissing.slice(0, 5).map(t => `${t.x}_${t.y}`).join(', ');
      const moreCount = stillMissing.length > 5 ? ` (and ${stillMissing.length - 5} more)` : '';
      throw new Error(
        `Level ${z} incomplete: ${stillMissing.length} tiles still missing after generation: ${missingList}${moreCount}`
      );
    }

    console.log(`  Level ${z}: COMPLETE (${neededTiles.length} tiles verified)`);
  }

  // Final validation: count all tiles
  let totalVerified = 0;
  for (let z = 0; z <= effectiveMaxLevel; z++) {
    totalVerified += stats.byLevel[z].total;
  }

  const elapsed = Date.now() - startTime;
  console.log(`[ensureLowLevelTiles] complete: generated=${stats.generated} existing=${stats.existing} total=${totalVerified} elapsed=${elapsed}ms`);

  if (totalVerified !== stats.totalExpected) {
    throw new Error(`Tile count mismatch: expected ${stats.totalExpected}, verified ${totalVerified}`);
  }

  return stats;
}

/**
 * Count total tiles for levels 0..maxLevel
 * Useful for progress estimation
 */
export function countTilesForLevels(width, height, maxLevel, levelMax) {
  let total = 0;

  for (let z = 0; z <= maxLevel; z++) {
    const scale = Math.pow(2, levelMax - z);
    const levelWidth = Math.ceil(width / scale);
    const levelHeight = Math.ceil(height / scale);
    const tilesX = Math.ceil(levelWidth / TILE_SIZE);
    const tilesY = Math.ceil(levelHeight / TILE_SIZE);
    total += tilesX * tilesY;
  }

  return total;
}

/**
 * Get default max preview level from environment
 */
export function getDefaultMaxLevel() {
  return DEFAULT_MAX_PREVIEW_LEVEL;
}
