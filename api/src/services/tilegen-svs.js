/**
 * SVS Tile Generator - On-Demand Tile Generation
 *
 * Generates DeepZoom tiles from SVS/WSI files using vips/openslide.
 * Implements request coalescing to avoid duplicate generation.
 *
 * Uses SVS pyramid levels for efficient tile generation:
 * - SVS files contain pre-computed pyramid levels at different resolutions
 * - We map DeepZoom levels to the closest SVS pyramid level
 * - This avoids creating massive temp files for low zoom levels
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, access, readFile, unlink, writeFile } from 'fs/promises';
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
const GENERATION_TIMEOUT_MS = parseInt(process.env.TILE_GENERATION_TIMEOUT_MS || '60000', 10);
const MAX_CONCURRENT_GENERATIONS = parseInt(process.env.TILE_CONCURRENCY || '4', 10);

// In-memory lock map for request coalescing
// Key: "slideId/z/x/y" -> Promise that resolves when tile is ready
const pendingTiles = new Map();

// Simple semaphore for limiting concurrent vips processes
let activeGenerations = 0;
const generationQueue = [];

function acquireSemaphore() {
  if (activeGenerations < MAX_CONCURRENT_GENERATIONS) {
    activeGenerations++;
    return Promise.resolve();
  }
  return new Promise(resolve => generationQueue.push(resolve));
}

function releaseSemaphore() {
  activeGenerations--;
  if (generationQueue.length > 0) {
    activeGenerations++;
    const next = generationQueue.shift();
    next();
  }
}

// Cache for SVS pyramid level info
// Key: rawPath -> { levels: [{ width, height, downsample }] }
const pyramidInfoCache = new Map();

/**
 * Get tile key for locking
 */
function getTileKey(slideId, z, x, y) {
  return `${slideId}/${z}/${x}/${y}`;
}

/**
 * Get SVS pyramid level information using vipsheader
 * Returns array of levels with { width, height, downsample }
 */
async function getSvsPyramidInfo(rawPath) {
  // Check cache first
  if (pyramidInfoCache.has(rawPath)) {
    return pyramidInfoCache.get(rawPath);
  }

  try {
    // Get vips header info which includes OpenSlide properties
    const { stdout } = await execAsync(`vipsheader -a "${rawPath}"`, { timeout: 10000 });

    const levels = [];
    const levelCount = parseInt(stdout.match(/openslide\.level-count:\s*'?(\d+)'?/)?.[1] || '1');

    for (let i = 0; i < levelCount; i++) {
      const widthMatch = stdout.match(new RegExp(`openslide\\.level\\[${i}\\]\\.width:\\s*'?(\\d+)'?`));
      const heightMatch = stdout.match(new RegExp(`openslide\\.level\\[${i}\\]\\.height:\\s*'?(\\d+)'?`));
      const downsampleMatch = stdout.match(new RegExp(`openslide\\.level\\[${i}\\]\\.downsample:\\s*'?([\\d.]+)'?`));

      if (widthMatch && heightMatch && downsampleMatch) {
        levels.push({
          level: i,
          width: parseInt(widthMatch[1]),
          height: parseInt(heightMatch[1]),
          downsample: parseFloat(downsampleMatch[1]),
        });
      }
    }

    // If no OpenSlide levels found, fall back to single level (full resolution)
    if (levels.length === 0) {
      const widthMatch = stdout.match(/width:\s*(\d+)/);
      const heightMatch = stdout.match(/height:\s*(\d+)/);
      if (widthMatch && heightMatch) {
        levels.push({
          level: 0,
          width: parseInt(widthMatch[1]),
          height: parseInt(heightMatch[1]),
          downsample: 1,
        });
      }
    }

    const result = { levels };
    pyramidInfoCache.set(rawPath, result);
    return result;
  } catch (err) {
    console.error(`Failed to get SVS pyramid info: ${err.message}`);
    return { levels: [] };
  }
}

/**
 * Find the best SVS pyramid level for a given DeepZoom level
 * Returns the SVS level that is closest to (but not lower resolution than) what we need
 */
function findBestPyramidLevel(pyramidInfo, dzLevel, dzMaxLevel) {
  const { levels } = pyramidInfo;
  if (levels.length === 0) {
    return null;
  }

  // DeepZoom scale factor (how much smaller than full res)
  const dzScale = Math.pow(2, dzMaxLevel - dzLevel);

  // Find the best matching SVS level
  // We want the level with downsample <= dzScale (so we don't upscale)
  // If none found, use the highest resolution level (0)
  let bestLevel = levels[0];
  for (const level of levels) {
    if (level.downsample <= dzScale && level.downsample >= bestLevel.downsample) {
      bestLevel = level;
    }
  }

  return bestLevel;
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
 * Generate a single tile from SVS using vips with pyramid level optimization
 *
 * DeepZoom coordinate system:
 * - Level 0: smallest (1x1 or 2x2 pixels)
 * - Level maxLevel: full resolution
 * - Each level doubles the resolution
 *
 * SVS pyramid optimization:
 * - SVS files contain pre-computed pyramid levels
 * - We load from the best matching pyramid level to avoid processing full resolution
 * - This dramatically reduces memory usage and processing time for low zoom levels
 *
 * Strategy:
 * - For high zoom (near full resolution): use direct crop - OpenSlide reads tiles efficiently
 * - For low zoom (zoomed out): use pyramid loading - load from lower-res pre-computed level
 *
 * The threshold is based on the SVS pyramid level dimensions:
 * - If the best SVS level is small enough to load entirely (< 4000x4000), use pyramid approach
 * - Otherwise, use direct crop to avoid loading massive images into temp files
 */
async function generateTileVips(rawPath, tilePath, z, x, y, manifest) {
  const { width, height, levelMax, tileSize = TILE_SIZE } = manifest;

  // Get SVS pyramid info
  const pyramidInfo = await getSvsPyramidInfo(rawPath);
  const bestLevel = findBestPyramidLevel(pyramidInfo, z, levelMax);

  // Threshold for using pyramid loading vs direct crop
  // If the SVS level is smaller than this, it's efficient to load the whole level
  const MAX_PYRAMID_LOAD_DIM = 4000;

  // Use pyramid approach only if:
  // 1. We have pyramid info with multiple levels
  // 2. The best level is NOT level 0 (which would be full resolution)
  // 3. The level dimensions are manageable
  const usePyramid =
    bestLevel &&
    pyramidInfo.levels.length > 1 &&
    bestLevel.level > 0 &&
    bestLevel.width <= MAX_PYRAMID_LOAD_DIM &&
    bestLevel.height <= MAX_PYRAMID_LOAD_DIM;

  if (usePyramid) {
    return generateTileFromPyramid(rawPath, tilePath, z, x, y, manifest, bestLevel, pyramidInfo);
  }

  // Use direct crop for high zoom levels or when pyramid loading isn't efficient
  return generateTileDirectCrop(rawPath, tilePath, z, x, y, manifest);
}

/**
 * Generate tile using SVS pyramid level (optimized for large images)
 *
 * This loads from a pre-computed pyramid level and only needs to do
 * minimal additional scaling, dramatically reducing memory usage.
 *
 * For very small pyramid levels (like 863x1068), we can load the whole thing.
 * The temp file will only be a few MB, not gigabytes.
 */
async function generateTileFromPyramid(rawPath, tilePath, z, x, y, manifest, svsLevel, pyramidInfo) {
  const { width, height, levelMax, tileSize = TILE_SIZE } = manifest;

  // DeepZoom scale factor (relative to full resolution)
  const dzScale = Math.pow(2, levelMax - z);

  // The SVS level dimensions
  const svsWidth = svsLevel.width;
  const svsHeight = svsLevel.height;
  const svsDownsample = svsLevel.downsample;

  // Additional scale needed after loading from SVS level
  // If dzScale=64 and svsDownsample=64, additionalScale=1 (no resize needed)
  // If dzScale=128 and svsDownsample=64, additionalScale=2 (need to shrink 2x)
  const additionalScale = dzScale / svsDownsample;

  // Calculate tile position in SVS level coordinates
  // Tile (x,y) at DZ level z covers this region at the SVS level:
  const tileX = Math.floor((x * tileSize * dzScale) / svsDownsample);
  const tileY = Math.floor((y * tileSize * dzScale) / svsDownsample);

  // Size of region to extract from SVS level (before additional scaling)
  let extractWidth = Math.ceil(tileSize * additionalScale);
  let extractHeight = Math.ceil(tileSize * additionalScale);

  // For very low zoom levels, we might need the entire pyramid level
  // That's fine because we only use this approach for small levels (< 4000x4000)
  if (extractWidth > svsWidth) extractWidth = svsWidth;
  if (extractHeight > svsHeight) extractHeight = svsHeight;

  // Clamp to SVS level bounds
  if (tileX >= svsWidth || tileY >= svsHeight) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }
  if (tileX + extractWidth > svsWidth) {
    extractWidth = svsWidth - tileX;
  }
  if (tileY + extractHeight > svsHeight) {
    extractHeight = svsHeight - tileY;
  }

  if (extractWidth <= 0 || extractHeight <= 0) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }

  await mkdir(dirname(tilePath), { recursive: true });

  // Use JPEG temp files to reduce disk usage (pyramid levels are small anyway)
  const tempPath = tilePath.replace('.jpg', '.level.jpg');
  const cropTempPath = tilePath.replace('.jpg', '.crop.jpg');

  try {
    // Step 1: Load from SVS pyramid level
    // Using openslideload with --level to read from pre-computed pyramid
    // For small levels (< 4000x4000), this creates a manageable temp file
    const loadCmd = `vips openslideload "${rawPath}" "${tempPath}[Q=95]" --level ${svsLevel.level}`;
    await execAsync(loadCmd, { timeout: GENERATION_TIMEOUT_MS });

    // Step 2: Crop the tile region from the loaded level
    const cropCmd = `vips crop "${tempPath}" "${cropTempPath}[Q=95]" ${tileX} ${tileY} ${extractWidth} ${extractHeight}`;
    await execAsync(cropCmd, { timeout: GENERATION_TIMEOUT_MS });

    // Step 3: Resize if needed (when additionalScale > 1)
    if (additionalScale > 1.01) {
      // Need to shrink
      const resizeCmd = `vips resize "${cropTempPath}" "${tilePath}[Q=${TILE_QUALITY}]" ${1 / additionalScale}`;
      await execAsync(resizeCmd, { timeout: GENERATION_TIMEOUT_MS });
    } else {
      // No resize needed, just convert to final JPEG
      const copyCmd = `vips copy "${cropTempPath}" "${tilePath}[Q=${TILE_QUALITY}]"`;
      await execAsync(copyCmd, { timeout: GENERATION_TIMEOUT_MS });
    }

    return { generated: true, path: tilePath };
  } finally {
    await cleanupTemp(tempPath);
    await cleanupTemp(cropTempPath);
  }
}

/**
 * Direct crop approach for high zoom levels or non-pyramidal images
 * Works best when we're near full resolution
 */
async function generateTileDirectCrop(rawPath, tilePath, z, x, y, manifest) {
  const { width, height, levelMax, tileSize = TILE_SIZE } = manifest;

  const scale = Math.pow(2, levelMax - z);

  // Calculate source region in full resolution coordinates
  const srcX = x * tileSize * scale;
  const srcY = y * tileSize * scale;

  let srcWidth = Math.ceil(tileSize * scale);
  let srcHeight = Math.ceil(tileSize * scale);

  // Clamp to image bounds
  if (srcX >= width || srcY >= height) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }
  if (srcX + srcWidth > width) {
    srcWidth = width - srcX;
  }
  if (srcY + srcHeight > height) {
    srcHeight = height - srcY;
  }

  if (srcWidth <= 0 || srcHeight <= 0) {
    throw new Error(`Tile out of bounds: ${z}/${x}/${y}`);
  }

  await mkdir(dirname(tilePath), { recursive: true });
  const tempPath = tilePath.replace('.jpg', '.tmp.v');

  try {
    // Extract region using vips crop (with OpenSlide loader)
    const cropCmd = `vips crop "${rawPath}" "${tempPath}" ${srcX} ${srcY} ${srcWidth} ${srcHeight}`;
    await execAsync(cropCmd, { timeout: GENERATION_TIMEOUT_MS });

    // Resize to tile size
    if (scale > 1.01) {
      const resizeCmd = `vips resize "${tempPath}" "${tilePath}[Q=${TILE_QUALITY}]" ${1 / scale}`;
      await execAsync(resizeCmd, { timeout: GENERATION_TIMEOUT_MS });
    } else {
      const copyCmd = `vips copy "${tempPath}" "${tilePath}[Q=${TILE_QUALITY}]"`;
      await execAsync(copyCmd, { timeout: GENERATION_TIMEOUT_MS });
    }

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

  // Start new generation (with concurrency limit)
  const generationPromise = (async () => {
    await acquireSemaphore();
    try {
      // Re-check if tile was generated while waiting in queue
      if (await tileExists(tilePath)) {
        return { exists: true, path: tilePath };
      }

      const rawPath = await getRawPath(slideId);
      const manifest = await getSlideInfo(slideId);

      const result = await generateTileVips(rawPath, tilePath, z, x, y, manifest);

      // Emit tile generated event on success
      if (result.generated) {
        eventBus.emitTileGenerated(slideId, z, x, y);
      }

      return result;
    } finally {
      releaseSemaphore();
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
