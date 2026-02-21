/**
 * Cloud Uploader - uploads full DZI tile pyramid to Wasabi S3
 * and notifies cloud API when ready.
 *
 * Two upload modes:
 *   1. TAR archive (default when cloud supports it):
 *      - Streams tiles into a tar → S3 multipart upload (single object)
 *      - Cloud extracts tiles server-side (intra-region, fast)
 *      - ~55s for 182K tiles at 100 Mbps (vs ~5 min individual)
 *
 *   2. Individual tiles (legacy fallback):
 *      - Concurrent pool with retry (improved from batch pattern)
 *      - Used when cloud doesn't advertise 'tar' support
 *
 * Flow: buildManifest → cloudInit → uploadTiles/Archive → uploadManifest → uploadThumb → cloudReady
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { spawn } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILES_HOT_DIR = process.env.TILES_HOT_DIR || '/data/tiles_hot';
const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:3001';
const EDGE_KEY = process.env.EDGE_KEY || '';
const UPLOAD_CONCURRENCY = parseInt(process.env.UPLOAD_CONCURRENCY || '64', 10);

// S3 multipart config for tar archive upload
const ARCHIVE_PART_SIZE = parseInt(process.env.ARCHIVE_PART_SIZE_MB || '20', 10) * 1024 * 1024;
const ARCHIVE_QUEUE_SIZE = parseInt(process.env.ARCHIVE_QUEUE_SIZE || '8', 10);

let _s3 = null;

function getS3Client() {
  if (!_s3) {
    if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
      throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY are required for cloud upload');
    }
    _s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
  }
  return _s3;
}

/**
 * Resolve tiles directory: check hot (tmpfs) first, then persistent (bind mount).
 */
async function resolveTilesDir(slideId) {
  const hotDir = join(TILES_HOT_DIR, slideId, 'tiles');
  try {
    await readdir(hotDir);
    return hotDir;
  } catch {}
  return join(DERIVED_DIR, slideId, 'tiles');
}

/**
 * Build tile manifest: counts per level + total
 */
async function buildTileManifest(slideId) {
  const tilesDir = await resolveTilesDir(slideId);
  const levelCounts = {};
  let totalCount = 0;

  const levels = await readdir(tilesDir);
  for (const level of levels) {
    if (!/^\d+$/.test(level)) continue;
    const files = await readdir(join(tilesDir, level));
    const jpgFiles = files.filter(f => f.endsWith('.jpg'));
    levelCounts[level] = jpgFiles.length;
    totalCount += jpgFiles.length;
  }

  return { levelCounts, totalCount, tileSize: 256, format: 'jpg' };
}

/**
 * Fetch with retry for cloud API calls. Retries on 5xx and network errors.
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && attempt < maxRetries) {
        console.warn(`[UPLOAD] API ${res.status} on attempt ${attempt}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`[UPLOAD] API error on attempt ${attempt}: ${err.message}, retrying...`);
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

/**
 * Upload tiles as a tar archive via S3 multipart upload.
 * Streams tar from child process directly to S3 — no temp files.
 */
async function uploadTilesArchive(slideId, s3Prefix, s3Client, bucket) {
  const tilesDir = await resolveTilesDir(slideId);
  const archiveKey = `${s3Prefix}tiles.tar`;

  console.log(`[UPLOAD] Creating tar stream from ${tilesDir}`);

  const tarProc = spawn('tar', ['-cf', '-', '-C', tilesDir, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tarStderr = '';
  tarProc.stderr.on('data', chunk => {
    tarStderr += chunk.toString().slice(-2000);
  });

  // Track tar process exit
  let tarExited = false;
  let tarExitCode = null;
  tarProc.on('close', code => {
    tarExited = true;
    tarExitCode = code;
  });

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: archiveKey,
      Body: tarProc.stdout,
      ContentType: 'application/x-tar',
    },
    partSize: ARCHIVE_PART_SIZE,
    queueSize: ARCHIVE_QUEUE_SIZE,
  });

  let lastLoggedMB = 0;
  upload.on('httpUploadProgress', (progress) => {
    const mb = (progress.loaded || 0) / (1024 * 1024);
    if (mb - lastLoggedMB >= 50) {
      console.log(`[UPLOAD] Archive progress: ${mb.toFixed(0)} MB uploaded`);
      lastLoggedMB = mb;
    }
  });

  try {
    await upload.done();
  } catch (uploadErr) {
    // Kill tar process if still running
    if (!tarExited) tarProc.kill('SIGTERM');
    throw new Error(`Archive upload failed: ${uploadErr.message}`);
  }

  // Verify tar exited cleanly
  if (tarExitCode !== null && tarExitCode !== 0) {
    throw new Error(`tar process exited with code ${tarExitCode}: ${tarStderr}`);
  }

  console.log(`[UPLOAD] Archive uploaded: ${archiveKey}`);
  return { archiveKey };
}

/**
 * Upload tiles individually with concurrent pool and retry.
 * Fallback mode when cloud doesn't support tar archives.
 */
async function uploadTilesPool(slideId, s3Prefix, s3Client, bucket) {
  const tilesDir = await resolveTilesDir(slideId);
  const levels = await readdir(tilesDir);
  const uploadQueue = [];

  for (const level of levels) {
    if (!/^\d+$/.test(level)) continue;
    const levelDir = join(tilesDir, level);
    const files = await readdir(levelDir);
    for (const file of files) {
      if (!file.endsWith('.jpg')) continue;
      uploadQueue.push({
        localPath: join(levelDir, file),
        s3Key: `${s3Prefix}${level}/${file}`,
      });
    }
  }

  console.log(`[UPLOAD] ${uploadQueue.length} tiles to upload (concurrency: ${UPLOAD_CONCURRENCY})`);

  let uploaded = 0;
  let failed = 0;
  const startTime = Date.now();

  // Use a shared queue that workers consume from safely
  const queue = [...uploadQueue];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { localPath, s3Key } = item;
      let success = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const body = await readFile(localPath);
          await s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: body,
            ContentType: 'image/jpeg',
            CacheControl: 'public, max-age=31536000, immutable',
          }));
          success = true;
          uploaded++;
          break;
        } catch (err) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
          }
        }
      }

      if (!success) {
        failed++;
        console.error(`[UPLOAD] Failed tile ${s3Key} after 3 attempts`);
      }

      if (uploaded % 500 === 0 && uploaded > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = uploaded / elapsed;
        const remaining = uploadQueue.length - uploaded - failed;
        const eta = remaining / rate;
        console.log(`[UPLOAD] ${uploaded}/${uploadQueue.length} (${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));

  if (failed > 0) {
    console.warn(`[UPLOAD] ${failed}/${uploadQueue.length} tiles failed`);
  }

  return uploaded;
}

/**
 * Main upload flow: called after TILEGEN completes.
 *
 * @param {string} slideId - SHA256 hash of the slide
 * @param {object} slideMetadata - { originalFilename, width, height, mpp, scanner, maxLevel }
 * @returns {{ status: string, mode?: string, tileCount?: number, elapsed?: number }}
 */
export async function uploadSlideToCloud(slideId, slideMetadata) {
  const { originalFilename, width, height, mpp, scanner, maxLevel } = slideMetadata;
  const bucket = process.env.S3_BUCKET;
  const uploadStart = Date.now();

  if (!EDGE_KEY) {
    console.warn('[UPLOAD] EDGE_KEY not set, skipping cloud upload');
    return { status: 'SKIPPED' };
  }

  // Step 1: Build tile manifest
  console.log(`[UPLOAD] Building tile manifest for ${slideId.substring(0, 12)}`);
  const manifest = await buildTileManifest(slideId);

  // Step 2: Call cloud init (with retry)
  console.log(`[UPLOAD] Calling cloud init for ${slideId.substring(0, 12)}`);
  const initRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/slides/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-EDGE-KEY': EDGE_KEY,
    },
    body: JSON.stringify({
      filename: originalFilename,
      sha256: slideId,
      width, height, mpp, scanner,
      tileSize: 256,
      expectedTileCount: manifest.totalCount,
      maxLevel,
    }),
  });

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`Cloud init failed: ${initRes.status} ${err}`);
  }

  const initData = await initRes.json();
  const { s3Prefix, alreadyReady, supportedUploadModes } = initData;

  if (alreadyReady) {
    console.log(`[UPLOAD] Slide ${slideId.substring(0, 12)} already READY, skipping upload`);
    return { status: 'ALREADY_READY', s3Prefix };
  }

  const useTarMode = (supportedUploadModes || []).includes('tar');
  const uploadMode = useTarMode ? 'tar' : 'individual';

  console.log(`[UPLOAD] s3Prefix: ${s3Prefix} | mode: ${uploadMode} | tiles: ${manifest.totalCount}`);
  if (useTarMode) {
    console.log(`[UPLOAD] Archive config: partSize=${ARCHIVE_PART_SIZE / (1024 * 1024)}MB, queueSize=${ARCHIVE_QUEUE_SIZE}`);
  } else {
    console.log(`[UPLOAD] Pool config: concurrency=${UPLOAD_CONCURRENCY}`);
  }

  // Step 3: Upload tiles
  const s3 = getS3Client();
  let tileCount;
  let archiveKey;

  if (useTarMode) {
    console.log(`[UPLOAD] Using TAR archive mode`);
    const result = await uploadTilesArchive(slideId, s3Prefix, s3, bucket);
    archiveKey = result.archiveKey;
    tileCount = manifest.totalCount;
  } else {
    console.log(`[UPLOAD] Using individual tile upload (concurrency: ${UPLOAD_CONCURRENCY})`);
    tileCount = await uploadTilesPool(slideId, s3Prefix, s3, bucket);
  }

  // Step 4: Upload tile_manifest.json
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${s3Prefix}tile_manifest.json`,
    Body: JSON.stringify(manifest),
    ContentType: 'application/json',
    CacheControl: 'no-cache',
  }));

  // Step 5: Upload thumb.jpg
  const thumbPath = join(DERIVED_DIR, slideId, 'thumb.jpg');
  try {
    const thumbData = await readFile(thumbPath);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${s3Prefix}thumb.jpg`,
      Body: thumbData,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
    }));
  } catch {
    console.warn(`[UPLOAD] No thumb.jpg found for ${slideId.substring(0, 12)}`);
  }

  // Step 6: Notify cloud READY (with retry)
  console.log(`[UPLOAD] Notifying cloud for ${slideId.substring(0, 12)}`);
  const readyBody = {
    tileCount,
    levelCounts: manifest.levelCounts,
  };
  if (useTarMode) {
    readyBody.archive = true;
    readyBody.archiveKey = archiveKey;
  }

  const readyRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/slides/${slideId}/ready`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-EDGE-KEY': EDGE_KEY,
    },
    body: JSON.stringify(readyBody),
  });

  if (!readyRes.ok) {
    const err = await readyRes.text();
    throw new Error(`Cloud ready failed: ${readyRes.status} ${err}`);
  }

  const elapsed = Date.now() - uploadStart;
  console.log(`[UPLOAD] Complete for ${slideId.substring(0, 12)}: ${tileCount} tiles in ${(elapsed / 1000).toFixed(1)}s (${uploadMode} mode)`);

  return { status: 'READY', mode: uploadMode, tileCount, elapsed, s3Prefix };
}
