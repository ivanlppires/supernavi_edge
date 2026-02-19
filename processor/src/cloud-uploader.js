/**
 * Cloud Uploader - uploads full DZI tile pyramid to Wasabi S3
 * and notifies cloud API when ready.
 *
 * Flow: buildManifest → cloudInit → uploadTiles → uploadManifest → uploadThumb → cloudReady
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:3001';
const EDGE_KEY = process.env.EDGE_KEY || '';
const UPLOAD_CONCURRENCY = parseInt(process.env.UPLOAD_CONCURRENCY || '8', 10);

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
 * Build tile manifest: counts per level + total
 */
async function buildTileManifest(slideId) {
  const tilesDir = join(DERIVED_DIR, slideId, 'tiles');
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
 * Upload all tiles to S3 with concurrency control
 */
async function uploadTiles(slideId, s3Prefix, s3Client, bucket) {
  const tilesDir = join(DERIVED_DIR, slideId, 'tiles');
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

  console.log(`[UPLOAD] ${uploadQueue.length} tiles to upload`);

  let uploaded = 0;
  const startTime = Date.now();

  for (let i = 0; i < uploadQueue.length; i += UPLOAD_CONCURRENCY) {
    const batch = uploadQueue.slice(i, i + UPLOAD_CONCURRENCY);
    await Promise.all(batch.map(async ({ localPath, s3Key }) => {
      const body = await readFile(localPath);
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: body,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      uploaded++;
      if (uploaded % 100 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`[UPLOAD] ${uploaded}/${uploadQueue.length} (${(uploaded / elapsed).toFixed(0)} tiles/s)`);
      }
    }));
  }

  return uploaded;
}

/**
 * Main upload flow: called after TILEGEN completes.
 *
 * @param {string} slideId - SHA256 hash of the slide
 * @param {object} slideMetadata - { originalFilename, width, height, mpp, scanner, maxLevel }
 * @returns {{ status: string, tileCount?: number }}
 */
export async function uploadSlideToCloud(slideId, slideMetadata) {
  const { originalFilename, width, height, mpp, scanner, maxLevel } = slideMetadata;
  const bucket = process.env.S3_BUCKET;

  if (!EDGE_KEY) {
    console.warn('[UPLOAD] EDGE_KEY not set, skipping cloud upload');
    return { status: 'SKIPPED' };
  }

  // Step 1: Build tile manifest
  console.log(`[UPLOAD] Building tile manifest for ${slideId.substring(0, 12)}`);
  const manifest = await buildTileManifest(slideId);

  // Step 2: Call cloud init
  console.log(`[UPLOAD] Calling cloud init for ${slideId.substring(0, 12)}`);
  const initRes = await fetch(`${CLOUD_API_URL}/edge/slides/init`, {
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

  const { s3Prefix, alreadyReady } = await initRes.json();
  if (alreadyReady) {
    console.log(`[UPLOAD] Slide ${slideId.substring(0, 12)} already READY, skipping upload`);
    return { status: 'ALREADY_READY' };
  }

  console.log(`[UPLOAD] s3Prefix: ${s3Prefix}`);

  // Step 3: Upload tiles
  const s3 = getS3Client();
  const tileCount = await uploadTiles(slideId, s3Prefix, s3, bucket);

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

  // Step 6: Notify cloud READY
  console.log(`[UPLOAD] Notifying cloud READY for ${slideId.substring(0, 12)}`);
  const readyRes = await fetch(`${CLOUD_API_URL}/edge/slides/${slideId}/ready`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-EDGE-KEY': EDGE_KEY,
    },
    body: JSON.stringify({
      tileCount,
      levelCounts: manifest.levelCounts,
    }),
  });

  if (!readyRes.ok) {
    const err = await readyRes.text();
    throw new Error(`Cloud ready failed: ${readyRes.status} ${err}`);
  }

  console.log(`[UPLOAD] Slide ${slideId.substring(0, 12)} marked READY (${tileCount} tiles)`);
  return { status: 'READY', tileCount };
}
