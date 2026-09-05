/**
 * Cloud Uploader - uploads full DZI tile pyramid via presigned URLs.
 *
 * Two upload modes:
 *   1. TAR archive (default): presigned multipart upload
 *   2. Individual tiles (fallback): presigned PUT URLs
 *
 * NO S3 credentials required — all uploads via presigned URLs from cloud.
 */

import { spawn } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { getEdgeKey, getCloudApiUrl } from './lib/config-reader.js';
import { findLabelPath } from './lib/label-asset.js';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILES_HOT_DIR = process.env.TILES_HOT_DIR || '/data/tiles_hot';
const CLOUD_API_URL = getCloudApiUrl();
const EDGE_KEY = getEdgeKey();
const UPLOAD_CONCURRENCY = parseInt(process.env.UPLOAD_CONCURRENCY || '16', 10);
const PART_CONCURRENCY = parseInt(process.env.PART_UPLOAD_CONCURRENCY || '6', 10);
const PART_SIZE = 50 * 1024 * 1024; // 50MB — must match cloud
const URL_BATCH_SIZE = 200; // max parts per part-urls request

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

function cloudHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-EDGE-KEY': EDGE_KEY,
  };
}

async function resolveTilesDir(slideId) {
  const hotDir = join(TILES_HOT_DIR, slideId, 'tiles');
  try { await readdir(hotDir); return hotDir; } catch {}
  return join(DERIVED_DIR, slideId, 'tiles');
}

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
 * Collect tar output into buffers of PART_SIZE, upload each via presigned URL.
 */
async function uploadTarViaMultipart(slideId, s3Prefix) {
  const tilesDir = await resolveTilesDir(slideId);
  const archiveKey = `${s3Prefix}tiles.tar`;

  // Step 1: Init multipart
  const initRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/multipart/init`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({ slideId, archiveKey, contentType: 'application/x-tar' }),
  });
  if (!initRes.ok) throw new Error(`Multipart init failed: ${initRes.status} ${await initRes.text()}`);
  const { uploadId, partSize } = await initRes.json();
  const effectivePartSize = partSize || PART_SIZE;

  console.log(`[UPLOAD] Multipart started: uploadId=${uploadId.substring(0, 16)}...`);

  // Step 2: Stream tar, buffer into parts
  const tarProc = spawn('tar', ['-cf', '-', '-C', tilesDir, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const completedParts = [];
  let currentPart = [];
  let currentSize = 0;
  let partNumber = 1;

  // Collect parts from tar stream
  const parts = [];

  await new Promise((resolve, reject) => {
    tarProc.stdout.on('data', (chunk) => {
      currentPart.push(chunk);
      currentSize += chunk.length;

      while (currentSize >= effectivePartSize) {
        // Flush current part
        const combined = Buffer.concat(currentPart);
        parts.push({ number: partNumber, data: combined.subarray(0, effectivePartSize) });
        partNumber++;

        // Keep remainder
        const remainder = combined.subarray(effectivePartSize);
        currentPart = remainder.length > 0 ? [remainder] : [];
        currentSize = remainder.length;
      }
    });
    tarProc.stdout.on('end', () => {
      // Flush final part
      if (currentSize > 0) {
        parts.push({ number: partNumber, data: Buffer.concat(currentPart) });
      }
      resolve();
    });
    tarProc.stdout.on('error', reject);
    tarProc.on('error', reject);
  });

  console.log(`[UPLOAD] Tar produced ${parts.length} parts`);

  // Step 3: Upload parts with presigned URLs in batches
  for (let i = 0; i < parts.length; i += URL_BATCH_SIZE) {
    const batch = parts.slice(i, i + URL_BATCH_SIZE);
    const partNumbers = batch.map(p => p.number);

    // Request presigned URLs for this batch
    const urlRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/multipart/part-urls`, {
      method: 'POST',
      headers: cloudHeaders(),
      body: JSON.stringify({ slideId, archiveKey, uploadId, parts: partNumbers }),
    });
    if (!urlRes.ok) throw new Error(`Part URLs failed: ${urlRes.status} ${await urlRes.text()}`);
    const { urls } = await urlRes.json();

    // Upload parts with concurrency limit
    for (let j = 0; j < batch.length; j += PART_CONCURRENCY) {
      const concurrentBatch = batch.slice(j, j + PART_CONCURRENCY);
      const results = await Promise.all(
        concurrentBatch.map(async (part) => {
          const url = urls[part.number];
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await fetch(url, {
                method: 'PUT',
                body: part.data,
              });
              if (!res.ok) throw new Error(`PUT part ${part.number}: ${res.status}`);
              const etag = res.headers.get('etag');
              return { partNumber: part.number, etag };
            } catch (err) {
              if (attempt === 3) throw err;
              await new Promise(r => setTimeout(r, 1000 * attempt));
            }
          }
        }),
      );
      completedParts.push(...results);
    }

    console.log(`[UPLOAD] Parts uploaded: ${completedParts.length}/${parts.length}`);
  }

  // Step 4: Complete multipart
  const completeRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/multipart/complete`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({ slideId, archiveKey, uploadId, parts: completedParts }),
  });
  if (!completeRes.ok) throw new Error(`Complete failed: ${completeRes.status} ${await completeRes.text()}`);

  console.log(`[UPLOAD] Multipart complete: ${archiveKey}`);
  return { archiveKey };
}

/**
 * Upload tiles individually via presigned PUT URLs (fallback mode).
 */
async function uploadTilesIndividual(slideId, s3Prefix) {
  const tilesDir = await resolveTilesDir(slideId);
  const levels = await readdir(tilesDir);
  const items = [];

  for (const level of levels) {
    if (!/^\d+$/.test(level)) continue;
    const levelDir = join(tilesDir, level);
    const files = await readdir(levelDir);
    for (const file of files) {
      if (!file.endsWith('.jpg')) continue;
      items.push({
        key: `${s3Prefix}${level}/${file}`,
        contentType: 'image/jpeg',
        localPath: join(levelDir, file),
      });
    }
  }

  console.log(`[UPLOAD] ${items.length} tiles to upload individually`);

  // Request presigned URLs in batches of 500
  const allUrls = {};
  for (let i = 0; i < items.length; i += 500) {
    const batch = items.slice(i, i + 500);
    const res = await fetchWithRetry(`${CLOUD_API_URL}/edge/upload-urls`, {
      method: 'POST',
      headers: cloudHeaders(),
      body: JSON.stringify({
        slideId,
        items: batch.map(it => ({ key: it.key, contentType: it.contentType })),
      }),
    });
    if (!res.ok) throw new Error(`Upload URLs failed: ${res.status}`);
    const data = await res.json();
    Object.assign(allUrls, data.putUrls);
  }

  // Upload with concurrency
  let uploaded = 0;
  for (let i = 0; i < items.length; i += UPLOAD_CONCURRENCY) {
    const batch = items.slice(i, i + UPLOAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        const body = await readFile(item.localPath);
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await fetch(allUrls[item.key], {
              method: 'PUT',
              headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=31536000, immutable',
              },
              body,
            });
            if (!res.ok) throw new Error(`${res.status}`);
            uploaded++;
            return;
          } catch (err) {
            if (attempt === 3) console.error(`[UPLOAD] Failed: ${item.key}`);
            else await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        }
      }),
    );
    if (uploaded % 500 === 0 && uploaded > 0) {
      console.log(`[UPLOAD] ${uploaded}/${items.length} tiles`);
    }
  }
  return uploaded;
}

/**
 * Upload tile_manifest.json, thumb.jpg and (when present) label.jpg via presigned URLs.
 * @returns {Promise<{ labelKey: string|null }>}
 */
async function uploadMetadata(slideId, s3Prefix, manifest) {
  const thumbPath = join(DERIVED_DIR, slideId, 'thumb.jpg');
  const labelPath = await findLabelPath(slideId);
  const labelKey = labelPath ? `${s3Prefix}label.jpg` : null;

  const items = [
    { key: `${s3Prefix}tile_manifest.json`, contentType: 'application/json' },
    { key: `${s3Prefix}thumb.jpg`, contentType: 'image/jpeg' },
    ...(labelKey ? [{ key: labelKey, contentType: 'image/jpeg' }] : []),
  ];

  const res = await fetchWithRetry(`${CLOUD_API_URL}/edge/upload-urls`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({ slideId, items }),
  });
  if (!res.ok) throw new Error(`Metadata URL request failed: ${res.status}`);
  const { putUrls } = await res.json();

  // Upload manifest
  await fetch(putUrls[items[0].key], {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(manifest),
  });

  // Upload thumb
  try {
    const thumbData = await readFile(thumbPath);
    await fetch(putUrls[items[1].key], {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
      body: thumbData,
    });
  } catch {
    console.warn(`[UPLOAD] No thumb.jpg for ${slideId.substring(0, 12)}`);
  }

  // Upload label photo (non-fatal)
  if (labelKey) {
    try {
      const labelData = await readFile(labelPath);
      const putRes = await fetch(putUrls[labelKey], {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
        body: labelData,
      });
      if (!putRes.ok) {
        console.warn(`[UPLOAD] Label PUT failed (non-fatal): ${putRes.status}`);
        return { labelKey: null };
      }
      console.log(`[UPLOAD] Label photo uploaded: ${labelKey}`);
    } catch (err) {
      console.warn(`[UPLOAD] Label upload failed (non-fatal): ${err.message}`);
      return { labelKey: null };
    }
  }

  return { labelKey };
}

/**
 * Main upload flow (same public API as before).
 */
export async function uploadSlideToCloud(slideId, slideMetadata) {
  const { originalFilename, width, height, mpp, scanner, maxLevel } = slideMetadata;
  const uploadStart = Date.now();

  if (!EDGE_KEY) {
    console.warn('[UPLOAD] EDGE_KEY not set, skipping');
    return { status: 'SKIPPED' };
  }

  const manifest = await buildTileManifest(slideId);

  // Cloud init (existing endpoint)
  const initRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/slides/init`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({
      filename: originalFilename, sha256: slideId,
      width, height, mpp, scanner, tileSize: 256,
      expectedTileCount: manifest.totalCount, maxLevel,
    }),
  });
  if (!initRes.ok) throw new Error(`Cloud init failed: ${initRes.status} ${await initRes.text()}`);

  const initData = await initRes.json();
  const { s3Prefix, alreadyReady, supportedUploadModes } = initData;

  if (alreadyReady) {
    console.log(`[UPLOAD] Already READY, skipping`);
    return { status: 'ALREADY_READY', s3Prefix };
  }

  const useTarMode = (supportedUploadModes || []).includes('tar');
  const uploadMode = useTarMode ? 'tar' : 'individual';
  console.log(`[UPLOAD] Mode: ${uploadMode} | tiles: ${manifest.totalCount}`);

  let tileCount;
  let archiveKey;

  if (useTarMode) {
    const result = await uploadTarViaMultipart(slideId, s3Prefix);
    archiveKey = result.archiveKey;
    tileCount = manifest.totalCount;
  } else {
    tileCount = await uploadTilesIndividual(slideId, s3Prefix);
  }

  // Upload metadata
  const { labelKey } = await uploadMetadata(slideId, s3Prefix, manifest);

  // Notify cloud READY
  const readyBody = { tileCount, levelCounts: manifest.levelCounts };
  if (useTarMode) {
    readyBody.archive = true;
    readyBody.archiveKey = archiveKey;
  }

  const readyRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/slides/${slideId}/ready`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify(readyBody),
  });
  if (!readyRes.ok) throw new Error(`Cloud ready failed: ${readyRes.status} ${await readyRes.text()}`);

  const elapsed = Date.now() - uploadStart;
  console.log(`[UPLOAD] Complete: ${tileCount} tiles in ${(elapsed / 1000).toFixed(1)}s (${uploadMode})`);

  return { status: 'READY', mode: uploadMode, tileCount, elapsed, s3Prefix, labelKey };
}
