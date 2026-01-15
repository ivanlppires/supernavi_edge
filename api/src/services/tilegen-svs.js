/**
 * SVS Tile Generator - On-Demand Tile Generation
 *
 * Generates DeepZoom tiles from SVS/WSI files using vips/openslide.
 * Implements request coalescing to avoid duplicate generation.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, access, readFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { query } from '../db/index.js';
import { eventBus } from './events.js';

const execAsync = promisify(exec);

/**
 * Clean up temp file if it exists
 */
async function cleanupTemp(path) {
  try {
    await unlink(path);
  } catch {}
}

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILE_SIZE = 256;
const TILE_QUALITY = 90;
const GENERATION_TIMEOUT_MS = 30000; // 30 seconds max for tile generation

// In-memory lock map for request coalescing
// Key: "slideId/z/x/y" -> Promise that resolves when tile is ready
const pendingTiles = new Map();

/**
 * Get tile key for locking
 */
function getTileKey(slideId, z, x, y) {
  return `${slideId}/${z}/${x}/${y}`;
}

/**
 * Check if tile already exists on disk
 */
async function tileExists(tilePath) {
  try {
    await access(tilePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get slide info from manifest
 */
async function getSlideInfo(slideId) {
  const manifestPath = join(DERIVED_DIR, slideId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return manifest;
}

/**
 * Get raw path from database
 */
async function getRawPath(slideId) {
  const result = await query('SELECT raw_path FROM slides WHERE id = $1', [slideId]);
  if (result.rows.length === 0) {
    throw new Error(`Slide not found: ${slideId}`);
  }
  return result.rows[0].raw_path;
}

/**
 * Generate a single tile from SVS using vips
 *
 * DeepZoom coordinate system:
 * - Level 0: smallest (1x1 or 2x2 pixels)
 * - Level maxLevel: full resolution
 * - Each level doubles the resolution
 *
 * For tile at (z, x, y):
 * - scale = 2^(maxLevel - z)
 * - srcX = x * tileSize * scale
 * - srcY = y * tileSize * scale
 * - extract region and shrink by scale factor
 */
async function generateTileVips(rawPath, tilePath, z, x, y, manifest) {
  const { width, height, levelMax, tileSize = TILE_SIZE } = manifest;

  // Calculate scale factor (how much to shrink)
  const scale = Math.pow(2, levelMax - z);

  // Calculate source region in full resolution coordinates
  const srcX = x * tileSize * scale;
  const srcY = y * tileSize * scale;

  // Calculate source dimensions (clamped to image bounds)
  let srcWidth = tileSize * scale;
  let srcHeight = tileSize * scale;

  // Clamp to image bounds
  if (srcX + srcWidth > width) {
    srcWidth = width - srcX;
  }
  if (srcY + srcHeight > height) {
    srcHeight = height - srcY;
  }

  // If completely out of bounds, skip
  if (srcX >= width || srcY >= height || srcWidth <= 0 || srcHeight <= 0) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }

  // Ensure output directory exists
  await mkdir(dirname(tilePath), { recursive: true });

  // Use temp file since vips piping doesn't work reliably in all environments
  const tempPath = tilePath.replace('.jpg', '.tmp.v');

  try {
    // Step 1: Extract region to temp file
    const cropCmd = `vips crop "${rawPath}" "${tempPath}" ${srcX} ${srcY} ${srcWidth} ${srcHeight}`;
    await execAsync(cropCmd, { timeout: GENERATION_TIMEOUT_MS });

    // Step 2: Resize temp file to final JPEG
    const resizeCmd = `vips resize "${tempPath}" "${tilePath}[Q=${TILE_QUALITY}]" ${1 / scale}`;
    await execAsync(resizeCmd, { timeout: GENERATION_TIMEOUT_MS });

    return { generated: true, path: tilePath };
  } catch (err) {
    // If vips crop fails, try alternative approach using shrink-on-load
    console.error(`vips crop failed, trying alternative: ${err.message}`);
    return generateTileVipsAlt(rawPath, tilePath, z, x, y, manifest);
  } finally {
    await cleanupTemp(tempPath);
  }
}

/**
 * Alternative tile generation using vips shrink with temp file
 */
async function generateTileVipsAlt(rawPath, tilePath, z, x, y, manifest) {
  const { width, height, levelMax, tileSize = TILE_SIZE } = manifest;

  const scale = Math.pow(2, levelMax - z);

  // Calculate the level dimension at this zoom
  const levelWidth = Math.ceil(width / scale);
  const levelHeight = Math.ceil(height / scale);

  // Tile position in level coordinates
  const tileX = x * tileSize;
  const tileY = y * tileSize;

  // Calculate actual tile size (edge tiles may be smaller)
  const actualWidth = Math.min(tileSize, levelWidth - tileX);
  const actualHeight = Math.min(tileSize, levelHeight - tileY);

  if (actualWidth <= 0 || actualHeight <= 0) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }

  await mkdir(dirname(tilePath), { recursive: true });

  // Use temp file since vips piping doesn't work reliably
  const tempPath = tilePath.replace('.jpg', '.tmp.v');

  try {
    // Step 1: Shrink SVS to target level
    const shrinkCmd = `vips shrink "${rawPath}" "${tempPath}" ${scale} ${scale}`;
    await execAsync(shrinkCmd, { timeout: GENERATION_TIMEOUT_MS });

    // Step 2: Crop tile region and save as JPEG
    const cropCmd = `vips crop "${tempPath}" "${tilePath}[Q=${TILE_QUALITY}]" ${tileX} ${tileY} ${actualWidth} ${actualHeight}`;
    await execAsync(cropCmd, { timeout: GENERATION_TIMEOUT_MS });

    return { generated: true, path: tilePath };
  } finally {
    await cleanupTemp(tempPath);
  }
}

/**
 * Generate tile with request coalescing
 *
 * If the same tile is requested multiple times simultaneously,
 * only generate it once and return the same promise to all callers.
 */
export async function generateTile(slideId, z, x, y) {
  const tileKey = getTileKey(slideId, z, x, y);
  const tilePath = join(DERIVED_DIR, slideId, 'tiles', String(z), `${x}_${y}.jpg`);

  // Check if tile already exists
  if (await tileExists(tilePath)) {
    return { exists: true, path: tilePath };
  }

  // Check if generation is already in progress
  if (pendingTiles.has(tileKey)) {
    // Wait for existing generation to complete
    return pendingTiles.get(tileKey);
  }

  // Emit tile pending event
  eventBus.emitTilePending(slideId, z, x, y);

  // Start new generation
  const generationPromise = (async () => {
    try {
      const rawPath = await getRawPath(slideId);
      const manifest = await getSlideInfo(slideId);

      const result = await generateTileVips(rawPath, tilePath, z, x, y, manifest);

      // Emit tile generated event on success
      if (result.generated) {
        eventBus.emitTileGenerated(slideId, z, x, y);
      }

      return result;
    } finally {
      // Clean up lock after generation completes (success or failure)
      pendingTiles.delete(tileKey);
    }
  })();

  pendingTiles.set(tileKey, generationPromise);
  return generationPromise;
}

/**
 * Check if tile generation is pending
 */
export function isTilePending(slideId, z, x, y) {
  return pendingTiles.has(getTileKey(slideId, z, x, y));
}

/**
 * Get count of pending tile generations
 */
export function getPendingCount() {
  return pendingTiles.size;
}
