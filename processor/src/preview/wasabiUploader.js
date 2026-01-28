/**
 * Wasabi S3 Uploader - Remote Preview Upload
 *
 * Uploads preview assets (thumb, manifest, low-level tiles) to Wasabi S3.
 * Uses AWS SDK v3 with custom endpoint configuration.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFile, stat, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { createHash } from 'crypto';

// Configuration from environment
const config = {
  bucket: process.env.S3_BUCKET || 'supernavi-eu',
  endpoint: process.env.S3_ENDPOINT || 'https://s3.eu-central-1.wasabisys.com',
  region: process.env.S3_REGION || 'eu-central-1',
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  prefixBase: process.env.PREVIEW_PREFIX_BASE || 'previews',
  uploadConcurrency: parseInt(process.env.PREVIEW_UPLOAD_CONCURRENCY || '8', 10),
  maxRetries: 3,
  retryDelayMs: 1000
};

// Cache-Control headers
const CACHE_CONTROL = {
  thumb: 'public, max-age=31536000, immutable',
  tile: 'public, max-age=31536000, immutable',
  manifest: 'public, max-age=300'
};

// Content-Type mappings
const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  json: 'application/json'
};

let s3Client = null;

/**
 * Initialize S3 client (lazy)
 */
function getS3Client() {
  if (!s3Client) {
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY are required');
    }

    s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      },
      forcePathStyle: config.forcePathStyle
    });
  }
  return s3Client;
}

/**
 * Calculate SHA256 hash of file content
 */
export async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Calculate SHA256 hash of string/buffer
 */
export function hashContent(content) {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Sleep helper for retries
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Upload file with retry logic
 */
async function uploadWithRetry(params, attempt = 1) {
  const client = getS3Client();

  try {
    const command = new PutObjectCommand(params);
    await client.send(command);
    return { success: true, key: params.Key };
  } catch (err) {
    if (attempt < config.maxRetries) {
      const delay = config.retryDelayMs * Math.pow(2, attempt - 1);
      console.warn(`Upload retry ${attempt}/${config.maxRetries} for ${params.Key} after ${delay}ms: ${err.message}`);
      await sleep(delay);
      return uploadWithRetry(params, attempt + 1);
    }
    throw err;
  }
}

/**
 * Upload a single file to S3
 * @param {string} localPath - Local file path
 * @param {string} key - S3 object key
 * @param {string} contentType - MIME type
 * @param {string} cacheControl - Cache-Control header
 * @returns {Promise<{success: boolean, key: string, bytes: number}>}
 */
export async function uploadFile(localPath, key, contentType, cacheControl) {
  const body = await readFile(localPath);
  const stats = await stat(localPath);

  const params = {
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl
  };

  const result = await uploadWithRetry(params);
  return { ...result, bytes: stats.size };
}

/**
 * Upload JSON object to S3
 * @param {object} obj - JSON object to upload
 * @param {string} key - S3 object key
 * @returns {Promise<{success: boolean, key: string, bytes: number}>}
 */
export async function uploadJson(obj, key) {
  const body = JSON.stringify(obj, null, 2);
  const bytes = Buffer.byteLength(body, 'utf8');

  const params = {
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: CONTENT_TYPES.json,
    CacheControl: CACHE_CONTROL.manifest
  };

  const result = await uploadWithRetry(params);
  return { ...result, bytes };
}

/**
 * Upload thumbnail to S3
 * @param {string} localPath - Local thumb.jpg path
 * @param {string} slideId - Slide identifier
 * @returns {Promise<{success: boolean, key: string, bytes: number}>}
 */
export async function uploadThumb(localPath, slideId) {
  const key = `${config.prefixBase}/${slideId}/thumb.jpg`;
  return uploadFile(localPath, key, CONTENT_TYPES.jpg, CACHE_CONTROL.thumb);
}

/**
 * Upload manifest.json to S3
 * @param {object} manifest - Manifest object (will be modified for remote use)
 * @param {string} slideId - Slide identifier
 * @returns {Promise<{success: boolean, key: string, bytes: number}>}
 */
export async function uploadManifest(manifest, slideId) {
  const key = `${config.prefixBase}/${slideId}/manifest.json`;
  return uploadJson(manifest, key);
}

/**
 * Upload a single tile to S3
 * @param {string} localPath - Local tile path
 * @param {string} slideId - Slide identifier
 * @param {number} z - Zoom level
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {Promise<{success: boolean, key: string, bytes: number}>}
 */
export async function uploadTile(localPath, slideId, z, x, y) {
  const key = `${config.prefixBase}/${slideId}/tiles/${z}/${x}_${y}.jpg`;
  return uploadFile(localPath, key, CONTENT_TYPES.jpg, CACHE_CONTROL.tile);
}

/**
 * List all tiles in a level directory
 * @param {string} levelDir - Local tiles/{z} directory path
 * @param {boolean} verbose - Log details about each file found
 * @returns {Promise<Array<{path: string, x: number, y: number}>>}
 */
async function listTilesInLevel(levelDir, verbose = false) {
  try {
    const files = await readdir(levelDir);
    const tiles = [];
    const skipped = [];

    for (const file of files) {
      if (file.endsWith('.jpg')) {
        const match = file.match(/^(\d+)_(\d+)\.jpg$/);
        if (match) {
          tiles.push({
            path: join(levelDir, file),
            x: parseInt(match[1], 10),
            y: parseInt(match[2], 10)
          });
        } else {
          skipped.push(file);
        }
      }
    }

    if (verbose && skipped.length > 0) {
      console.warn(`    WARNING: Skipped ${skipped.length} files with unexpected format in ${levelDir}: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '...' : ''}`);
    }

    return tiles;
  } catch (err) {
    // DO NOT silently swallow errors - log them explicitly
    console.error(`    ERROR: Failed to read level directory ${levelDir}: ${err.message}`);
    return [];
  }
}

/**
 * Upload all tiles for levels 0..maxLevel with concurrency control
 * @param {string} tilesDir - Base tiles directory (e.g., $DERIVED_DIR/{slideId}/tiles)
 * @param {string} slideId - Slide identifier
 * @param {number} maxLevel - Maximum level to upload (0..maxLevel inclusive)
 * @param {number} concurrency - Max concurrent uploads
 * @returns {Promise<{totalTiles: number, totalBytes: number, byLevel: Object}>}
 */
export async function uploadTilesForLevels(tilesDir, slideId, maxLevel, concurrency = config.uploadConcurrency) {
  const stats = {
    totalTiles: 0,
    totalBytes: 0,
    byLevel: {}
  };

  // Collect all tiles to upload
  const uploadTasks = [];

  for (let z = 0; z <= maxLevel; z++) {
    const levelDir = join(tilesDir, String(z));
    const tiles = await listTilesInLevel(levelDir);

    stats.byLevel[z] = { tiles: tiles.length, bytes: 0 };

    for (const tile of tiles) {
      uploadTasks.push({ ...tile, z, slideId });
    }
  }

  // Process uploads with concurrency control
  const results = [];

  for (let i = 0; i < uploadTasks.length; i += concurrency) {
    const batch = uploadTasks.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (task) => {
        const result = await uploadTile(task.path, task.slideId, task.z, task.x, task.y);
        stats.byLevel[task.z].bytes += result.bytes;
        return result;
      })
    );

    results.push(...batchResults);

    // Progress logging
    const progress = Math.min(i + concurrency, uploadTasks.length);
    if (uploadTasks.length > 10 && progress % 50 === 0) {
      console.log(`  Upload progress: ${progress}/${uploadTasks.length} tiles`);
    }
  }

  stats.totalTiles = results.length;
  stats.totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);

  return stats;
}

/**
 * Create remote manifest from local manifest using REBASED dimensions
 *
 * The preview uses a "rebased" pyramid where:
 * - The original image is scaled so max(width,height) = PREVIEW_TARGET_MAX_DIM
 * - This scaled image has its own tile pyramid with levels 0..maxPreviewLevel
 * - width/height in the manifest are the REBASED dimensions
 * - OpenSeadragon will render a meaningful preview with proper zoom
 *
 * IMPORTANT: Tile paths use standard DZI convention: tiles/{z}/{x}_{y}.jpg
 * This matches viewer expectations and is the standard path format.
 *
 * @param {object} localManifest - Original local manifest
 * @param {string} slideId - Slide identifier
 * @param {number} maxPreviewLevel - Max level uploaded (0..N)
 * @param {number} rebasedWidth - Width of rebased preview image
 * @param {number} rebasedHeight - Height of rebased preview image
 * @returns {object} Remote manifest
 */
export function createRemoteManifest(localManifest, slideId, maxPreviewLevel, rebasedWidth, rebasedHeight) {
  return {
    protocol: 'dzi',
    // CRITICAL: Use REBASED dimensions, not original
    // This is the size of the preview image, NOT the original slide
    width: rebasedWidth,
    height: rebasedHeight,
    tileSize: 256,
    overlap: 0,
    format: 'jpg',
    levelMin: 0,
    // levelMax = maxPreviewLevel represents zoom levels of the REBASED image
    levelMax: maxPreviewLevel,
    // Keep original dimensions for reference (useful for coordinate mapping)
    originalWidth: localManifest.width,
    originalHeight: localManifest.height,
    originalLevelMax: localManifest.levelMax,
    // Remote-specific fields
    storage: {
      provider: 's3',
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint,
      prefix: `${config.prefixBase}/${slideId}/`
    },
    // FIXED: Use tiles/ not preview_tiles/ to match standard DZI and viewer expectation
    tilesPrefix: `${config.prefixBase}/${slideId}/tiles/`,
    maxPreviewLevel,
    // Standard DZI path pattern for tiles
    tilePathPattern: 'tiles/{z}/{x}_{y}.jpg',
    // Full URL template for direct tile access
    tileUrlTemplate: `${config.endpoint}/${config.bucket}/${config.prefixBase}/${slideId}/tiles/{z}/{x}_{y}.jpg`,
    // Preview is pre-generated, not on-demand
    onDemand: false
  };
}

/**
 * Upload rebased preview tiles for levels 0..maxLevel
 * These are in the preview_tiles/ subdirectory, not tiles/
 *
 * IMPORTANT: Tiles are uploaded to: {prefixBase}/{slideId}/tiles/{z}/{x}_{y}.jpg
 * This matches the viewer expectation and standard DZI path convention.
 *
 * @param {string} previewTilesDir - Base preview_tiles directory
 * @param {string} slideId - Slide identifier
 * @param {number} maxLevel - Maximum level to upload
 * @param {number} concurrency - Max concurrent uploads
 * @returns {Promise<{totalTiles: number, totalBytes: number, byLevel: Object, uploadedKeys: Array}>}
 */
export async function uploadRebasedTiles(previewTilesDir, slideId, maxLevel, concurrency = config.uploadConcurrency) {
  const stats = {
    totalTiles: 0,
    totalBytes: 0,
    byLevel: {},
    uploadedKeys: [],
    errors: []
  };

  console.log(`\n  [uploadRebasedTiles] Starting upload`);
  console.log(`    Source: ${previewTilesDir}`);
  console.log(`    Bucket: ${config.bucket}`);
  console.log(`    Endpoint: ${config.endpoint}`);
  console.log(`    Target prefix: ${config.prefixBase}/${slideId}/tiles/`);
  console.log(`    Max level: ${maxLevel}`);
  console.log(`    Concurrency: ${concurrency}`);

  // Collect all tiles to upload
  const uploadTasks = [];

  for (let z = 0; z <= maxLevel; z++) {
    const levelDir = join(previewTilesDir, String(z));
    const tiles = await listTilesInLevel(levelDir, true);

    stats.byLevel[z] = { localTiles: tiles.length, uploaded: 0, bytes: 0, errors: [] };

    if (tiles.length === 0) {
      console.warn(`    WARNING: No tiles found for level ${z} in ${levelDir}`);
    } else {
      console.log(`    Level ${z}: ${tiles.length} tiles to upload`);
    }

    for (const tile of tiles) {
      uploadTasks.push({ ...tile, z, slideId });
    }
  }

  console.log(`\n    Total: ${uploadTasks.length} tiles to upload`);

  if (uploadTasks.length === 0) {
    console.error(`    ERROR: No tiles found to upload!`);
    return stats;
  }

  // Log sample of keys that will be uploaded
  console.log(`\n    Sample S3 keys to upload:`);
  for (let z = 0; z <= Math.min(maxLevel, 6); z++) {
    const sample = uploadTasks.find(t => t.z === z);
    if (sample) {
      // FIXED: Upload to tiles/ not preview_tiles/ to match viewer expectation
      const key = `${config.prefixBase}/${sample.slideId}/tiles/${sample.z}/${sample.x}_${sample.y}.jpg`;
      console.log(`      Level ${z}: ${key}`);
    }
  }

  // Process uploads with concurrency control
  const results = [];
  const startTime = Date.now();

  for (let i = 0; i < uploadTasks.length; i += concurrency) {
    const batch = uploadTasks.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (task) => {
        // FIXED: Upload to tiles/ not preview_tiles/ to match standard DZI and viewer expectation
        const key = `${config.prefixBase}/${task.slideId}/tiles/${task.z}/${task.x}_${task.y}.jpg`;
        try {
          const result = await uploadFile(task.path, key, CONTENT_TYPES.jpg, CACHE_CONTROL.tile);
          stats.byLevel[task.z].uploaded++;
          stats.byLevel[task.z].bytes += result.bytes;
          stats.uploadedKeys.push(key);
          return { ...result, level: task.z, x: task.x, y: task.y };
        } catch (err) {
          const errorMsg = `Level ${task.z} (${task.x},${task.y}): ${err.message}`;
          stats.byLevel[task.z].errors.push(errorMsg);
          stats.errors.push(errorMsg);
          console.error(`    UPLOAD ERROR: ${errorMsg}`);
          return { success: false, key, error: err.message, level: task.z };
        }
      })
    );

    results.push(...batchResults);

    // Progress logging
    const progress = Math.min(i + concurrency, uploadTasks.length);
    const elapsed = Date.now() - startTime;
    const rate = progress / (elapsed / 1000);

    if (uploadTasks.length > 10) {
      // Log every 10% or every 20 tiles
      const logInterval = Math.max(Math.floor(uploadTasks.length / 10), 20);
      if (progress % logInterval === 0 || progress === uploadTasks.length) {
        console.log(`    Progress: ${progress}/${uploadTasks.length} (${(progress/uploadTasks.length*100).toFixed(0)}%) - ${rate.toFixed(1)} tiles/s`);
      }
    }
  }

  stats.totalTiles = results.filter(r => r.success !== false).length;
  stats.totalBytes = results.filter(r => r.bytes).reduce((sum, r) => sum + r.bytes, 0);

  // Summary by level
  console.log(`\n    Upload summary by level:`);
  for (let z = 0; z <= maxLevel; z++) {
    const level = stats.byLevel[z];
    const status = level.uploaded === level.localTiles ? 'OK' : 'INCOMPLETE';
    console.log(`      Level ${z}: ${level.uploaded}/${level.localTiles} uploaded (${level.bytes} bytes) [${status}]`);
    if (level.errors.length > 0) {
      console.log(`        Errors: ${level.errors.length}`);
    }
  }

  if (stats.errors.length > 0) {
    console.error(`\n    UPLOAD ERRORS: ${stats.errors.length} tiles failed`);
  }

  return stats;
}

/**
 * Get S3 key prefix for a slide
 */
export function getSlidePrefix(slideId) {
  return `${config.prefixBase}/${slideId}/`;
}

/**
 * Get configuration (for logging/debugging)
 */
export function getConfig() {
  return {
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    prefixBase: config.prefixBase,
    uploadConcurrency: config.uploadConcurrency
  };
}
