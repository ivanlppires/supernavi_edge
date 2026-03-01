/**
 * Presigned URL Uploader - Remote Preview Upload
 *
 * Uploads preview assets to Wasabi S3 via presigned PUT URLs
 * obtained from the cloud API. NO S3 credentials on edge.
 */

import { readFile, stat, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getEdgeKey, getCloudApiUrl } from '../lib/config-reader.js';

// Configuration (NO S3 credentials)
const config = {
  cloudApiUrl: getCloudApiUrl(),
  edgeKey: getEdgeKey(),
  bucket: process.env.S3_BUCKET || 'supernavi',         // only for manifest metadata
  endpoint: process.env.S3_ENDPOINT || 'https://s3.wasabisys.com',  // only for manifest metadata
  region: process.env.S3_REGION || 'us-east-1',          // only for manifest metadata
  prefixBase: process.env.PREVIEW_PREFIX_BASE || 'previews',
  uploadConcurrency: parseInt(process.env.PREVIEW_UPLOAD_CONCURRENCY || '16', 10),
  maxRetries: 3,
  retryDelayMs: 1000,
  urlBatchSize: 500,  // max keys per presigned URL request
};

// Cache-Control headers
const CACHE_CONTROL = {
  thumb: 'public, max-age=31536000, immutable',
  tile: 'public, max-age=31536000, immutable',
  manifest: 'public, max-age=300',
};

const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  json: 'application/json',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function hashContent(content) {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(data).digest('hex');
}

export async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Request presigned PUT URLs from cloud API
 */
async function requestPresignedUrls(slideId, items) {
  if (!config.edgeKey) {
    throw new Error('EDGE_KEY is required for presigned URL uploads');
  }

  const urls = {};

  // Batch requests to respect 1000-item limit
  for (let i = 0; i < items.length; i += config.urlBatchSize) {
    const batch = items.slice(i, i + config.urlBatchSize);

    const res = await fetch(`${config.cloudApiUrl}/edge/upload-urls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EDGE-KEY': config.edgeKey,
      },
      body: JSON.stringify({ slideId, items: batch }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get presigned URLs: ${res.status} ${err}`);
    }

    const data = await res.json();
    Object.assign(urls, data.putUrls);
  }

  return urls;
}

/**
 * Upload data to a presigned URL with retry
 */
async function uploadWithPresignedUrl(url, body, contentType, cacheControl, attempt = 1) {
  try {
    const headers = { 'Content-Type': contentType };
    if (cacheControl) headers['Cache-Control'] = cacheControl;

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body,
    });

    if (!res.ok) {
      throw new Error(`PUT failed: ${res.status} ${res.statusText}`);
    }

    return { success: true };
  } catch (err) {
    if (attempt < config.maxRetries) {
      const delay = config.retryDelayMs * Math.pow(2, attempt - 1);
      console.warn(`Upload retry ${attempt}/${config.maxRetries}: ${err.message} (${delay}ms)`);
      await sleep(delay);
      return uploadWithPresignedUrl(url, body, contentType, cacheControl, attempt + 1);
    }
    throw err;
  }
}

/**
 * Upload a single file using presigned URL
 */
export async function uploadFile(presignedUrl, localPath, contentType, cacheControl) {
  const body = await readFile(localPath);
  const stats = await stat(localPath);
  await uploadWithPresignedUrl(presignedUrl, body, contentType, cacheControl);
  return { success: true, bytes: stats.size };
}

/**
 * Upload JSON using presigned URL
 */
export async function uploadJson(presignedUrl, obj) {
  const body = JSON.stringify(obj, null, 2);
  const bytes = Buffer.byteLength(body, 'utf8');
  await uploadWithPresignedUrl(presignedUrl, body, CONTENT_TYPES.json, CACHE_CONTROL.manifest);
  return { success: true, bytes };
}

/**
 * Upload thumb, manifest, and rebased tiles for a slide.
 * Orchestrates: collect keys → request presigned URLs → upload all.
 */
export async function uploadPreviewAssets(slideId, thumbPath, manifest, previewTilesDir, maxLevel) {
  const thumbKey = `${config.prefixBase}/${slideId}/thumb.jpg`;
  const manifestKey = `${config.prefixBase}/${slideId}/manifest.json`;

  // Collect all items to upload
  const items = [
    { key: thumbKey, contentType: CONTENT_TYPES.jpg },
    { key: manifestKey, contentType: CONTENT_TYPES.json },
  ];

  // Collect tile keys
  const tileEntries = [];
  for (let z = 0; z <= maxLevel; z++) {
    const levelDir = join(previewTilesDir, String(z));
    try {
      const files = await readdir(levelDir);
      for (const file of files) {
        if (!file.endsWith('.jpg')) continue;
        const match = file.match(/^(\d+)_(\d+)\.jpg$/);
        if (!match) continue;
        const key = `${config.prefixBase}/${slideId}/tiles/${z}/${file}`;
        items.push({ key, contentType: CONTENT_TYPES.jpg });
        tileEntries.push({ key, path: join(levelDir, file), z, file });
      }
    } catch {
      console.warn(`  No tiles for level ${z}`);
    }
  }

  console.log(`  Requesting presigned URLs for ${items.length} objects...`);
  const presignedUrls = await requestPresignedUrls(slideId, items);

  // Upload thumb
  console.log(`  Uploading thumb.jpg...`);
  const thumbResult = await uploadFile(presignedUrls[thumbKey], thumbPath, CONTENT_TYPES.jpg, CACHE_CONTROL.thumb);

  // Upload manifest
  console.log(`  Uploading manifest.json...`);
  const manifestResult = await uploadJson(presignedUrls[manifestKey], manifest);

  // Upload tiles with concurrency control
  console.log(`  Uploading ${tileEntries.length} tiles (concurrency: ${config.uploadConcurrency})...`);
  let uploaded = 0;
  let totalBytes = 0;
  const errors = [];
  const startTime = Date.now();

  for (let i = 0; i < tileEntries.length; i += config.uploadConcurrency) {
    const batch = tileEntries.slice(i, i + config.uploadConcurrency);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          const result = await uploadFile(
            presignedUrls[entry.key],
            entry.path,
            CONTENT_TYPES.jpg,
            CACHE_CONTROL.tile,
          );
          uploaded++;
          totalBytes += result.bytes;
          return result;
        } catch (err) {
          errors.push(`${entry.key}: ${err.message}`);
          return { success: false };
        }
      }),
    );

    const progress = Math.min(i + config.uploadConcurrency, tileEntries.length);
    if (tileEntries.length > 20 && progress % Math.max(Math.floor(tileEntries.length / 10), 20) === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`    Progress: ${progress}/${tileEntries.length} (${(uploaded / elapsed).toFixed(1)} tiles/s)`);
    }
  }

  return {
    totalTiles: uploaded,
    totalBytes: thumbResult.bytes + manifestResult.bytes + totalBytes,
    thumbBytes: thumbResult.bytes,
    manifestBytes: manifestResult.bytes,
    errors,
  };
}

/**
 * Create remote manifest (unchanged — no S3 dependency)
 */
export function createRemoteManifest(localManifest, slideId, maxPreviewLevel, rebasedWidth, rebasedHeight) {
  return {
    protocol: 'dzi',
    width: rebasedWidth,
    height: rebasedHeight,
    tileSize: 256,
    overlap: 0,
    format: 'jpg',
    levelMin: 0,
    levelMax: maxPreviewLevel,
    originalWidth: localManifest.width,
    originalHeight: localManifest.height,
    originalLevelMax: localManifest.levelMax,
    storage: {
      provider: 's3',
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint,
      prefix: `${config.prefixBase}/${slideId}/`,
    },
    tilesPrefix: `${config.prefixBase}/${slideId}/tiles/`,
    maxPreviewLevel,
    tilePathPattern: 'tiles/{z}/{x}_{y}.jpg',
    tileUrlTemplate: `${config.endpoint}/${config.bucket}/${config.prefixBase}/${slideId}/tiles/{z}/{x}_{y}.jpg`,
    onDemand: false,
  };
}

export function getSlidePrefix(slideId) {
  return `${config.prefixBase}/${slideId}/`;
}

export function getConfig() {
  return {
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    prefixBase: config.prefixBase,
    uploadConcurrency: config.uploadConcurrency,
  };
}
