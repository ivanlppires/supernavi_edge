/**
 * BigTIFF Uploader — uploads a single pyramidal BigTIFF to Wasabi S3
 * via the cloud's presigned multipart upload API.
 *
 * NO S3 credentials on edge — all uploads via presigned URLs from cloud.
 *
 * S3 key structure:
 *   slides/{slideId}/slide.tif    — pyramidal BigTIFF
 *   slides/{slideId}/thumb.jpg    — thumbnail
 *   slides/{slideId}/label.jpg    — label photo (only when the scanner produced one)
 */

import { open, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { getEdgeKey, getCloudApiUrl } from './lib/config-reader.js';
import { findLabelPath } from './lib/label-asset.js';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const CLOUD_API_URL = getCloudApiUrl();
const EDGE_KEY = getEdgeKey();
const PART_SIZE = parseInt(process.env.BIGTIFF_PART_SIZE || String(50 * 1024 * 1024), 10); // 50MB
const PART_CONCURRENCY = parseInt(process.env.BIGTIFF_PART_CONCURRENCY || '4', 10);
const URL_BATCH_SIZE = 200;

function cloudHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-EDGE-KEY': EDGE_KEY,
  };
}

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

/**
 * Read a part from the file handle at the given offset.
 */
async function readPart(fd, partNumber, partSize, fileSize) {
  const offset = (partNumber - 1) * partSize;
  const length = Math.min(partSize, fileSize - offset);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

/**
 * Upload a BigTIFF file to Wasabi S3 via the cloud's presigned URL API.
 *
 * @param {string} slideId
 * @param {string} bigtiffPath - Local path to the BigTIFF file
 * @param {object} slideMetadata - { originalFilename, width, height, mpp, scanner, maxLevel }
 * @returns {{ status, s3Prefix, bigtiffKey, bigtiffSize, elapsed }}
 */
export async function uploadBigTIFF(slideId, bigtiffPath, slideMetadata) {
  const { originalFilename, width, height, mpp, scanner, maxLevel } = slideMetadata;
  const uploadStart = Date.now();

  if (!EDGE_KEY) {
    console.warn('[BIGTIFF-UPLOAD] EDGE_KEY not set, skipping');
    return { status: 'SKIPPED' };
  }

  // Step 1: Init with cloud (tells cloud we're uploading a BigTIFF)
  const initRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/slides/init`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({
      filename: originalFilename,
      sha256: slideId,
      width,
      height,
      mpp,
      scanner,
      tileSize: 256,
      expectedTileCount: 1,
      maxLevel,
      pipelineMode: 'bigtiff_iiif',
    }),
  });
  if (!initRes.ok) throw new Error(`Cloud init failed: ${initRes.status} ${await initRes.text()}`);

  const initData = await initRes.json();
  if (initData.alreadyReady) {
    console.log(`[BIGTIFF-UPLOAD] Already READY, skipping`);
    return { status: 'ALREADY_READY', s3Prefix: initData.s3Prefix };
  }

  const s3Prefix = initData.s3Prefix;
  const bigtiffKey = `${s3Prefix}slide.tif`;

  // Step 2: Get file size and calculate parts
  const fileStats = await stat(bigtiffPath);
  const fileSize = fileStats.size;
  const totalParts = Math.ceil(fileSize / PART_SIZE);

  console.log(`[BIGTIFF-UPLOAD] File: ${(fileSize / 1024 / 1024).toFixed(1)} MB → ${totalParts} parts of ${(PART_SIZE / 1024 / 1024).toFixed(0)} MB`);

  // Step 3: Initiate multipart upload
  const mpInitRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/multipart/init`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({
      slideId,
      archiveKey: bigtiffKey,
      contentType: 'image/tiff',
    }),
  });
  if (!mpInitRes.ok) throw new Error(`Multipart init failed: ${mpInitRes.status} ${await mpInitRes.text()}`);

  const { uploadId, partSize: serverPartSize } = await mpInitRes.json();
  const effectivePartSize = serverPartSize || PART_SIZE;

  console.log(`[BIGTIFF-UPLOAD] Multipart started: uploadId=${uploadId.substring(0, 16)}...`);

  // Step 4: Upload parts using file handle (memory-efficient)
  const completedParts = [];
  const fd = await open(bigtiffPath, 'r');

  try {
    for (let batchStart = 1; batchStart <= totalParts; batchStart += URL_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + URL_BATCH_SIZE - 1, totalParts);
      const partNumbers = Array.from(
        { length: batchEnd - batchStart + 1 },
        (_, i) => batchStart + i,
      );

      // Request presigned URLs for this batch
      const urlRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/multipart/part-urls`, {
        method: 'POST',
        headers: cloudHeaders(),
        body: JSON.stringify({ slideId, archiveKey: bigtiffKey, uploadId, parts: partNumbers }),
      });
      if (!urlRes.ok) throw new Error(`Part URLs failed: ${urlRes.status} ${await urlRes.text()}`);
      const { urls } = await urlRes.json();

      // Upload parts with concurrency limit
      for (let j = 0; j < partNumbers.length; j += PART_CONCURRENCY) {
        const concurrent = partNumbers.slice(j, j + PART_CONCURRENCY);
        const results = await Promise.all(
          concurrent.map(async (partNum) => {
            const data = await readPart(fd, partNum, effectivePartSize, fileSize);
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                let urlForAttempt = urls[partNum];
                // On retry, request a fresh presigned URL (may have expired)
                if (attempt > 1) {
                  try {
                    const refreshRes = await fetch(`${CLOUD_API_URL}/edge/multipart/part-urls`, {
                      method: 'POST',
                      headers: cloudHeaders(),
                      body: JSON.stringify({ slideId, archiveKey: bigtiffKey, uploadId, parts: [partNum] }),
                    });
                    if (refreshRes.ok) {
                      const j = await refreshRes.json();
                      if (j.urls && j.urls[partNum]) urlForAttempt = j.urls[partNum];
                    }
                  } catch { /* fall through with original URL */ }
                }
                const res = await fetch(urlForAttempt, {
                  method: 'PUT',
                  body: data,
                });
                if (!res.ok) {
                  // Capture S3 error body — it tells us *why* (Request has expired,
                  // SignatureDoesNotMatch, AccessDenied, etc.). Without this we
                  // only see "403" and can't diagnose. Truncate to keep messages
                  // bounded but keep the S3 error code visible.
                  const body = await res.text().catch(() => '');
                  const codeMatch = body.match(/<Code>([^<]+)<\/Code>/);
                  const msgMatch = body.match(/<Message>([^<]+)<\/Message>/);
                  const detail = codeMatch ? `${codeMatch[1]}: ${msgMatch ? msgMatch[1] : ''}`.trim() : body.substring(0, 200);
                  throw new Error(`PUT part ${partNum}: ${res.status}${detail ? ` ${detail}` : ''}`);
                }
                const etag = res.headers.get('etag');
                return { partNumber: partNum, etag };
              } catch (err) {
                if (attempt === 3) throw err;
                await new Promise(r => setTimeout(r, 1000 * attempt));
              }
            }
          }),
        );
        completedParts.push(...results);
      }

      const elapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
      const mbUploaded = ((completedParts.length * effectivePartSize) / 1024 / 1024).toFixed(0);
      console.log(`[BIGTIFF-UPLOAD] Parts: ${completedParts.length}/${totalParts} (${mbUploaded} MB, ${elapsed}s)`);
    }
  } finally {
    await fd.close();
  }

  // Step 5: Complete multipart upload
  const completeRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/multipart/complete`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({
      slideId,
      archiveKey: bigtiffKey,
      uploadId,
      parts: completedParts,
    }),
  });
  if (!completeRes.ok) throw new Error(`Complete failed: ${completeRes.status} ${await completeRes.text()}`);

  console.log(`[BIGTIFF-UPLOAD] Multipart complete: ${bigtiffKey}`);

  // Step 6: Upload thumbnail via presigned PUT URL
  const thumbKey = `${s3Prefix}thumb.jpg`;
  try {
    const thumbPath = join(DERIVED_DIR, slideId, 'thumb.jpg');
    const thumbData = await readFile(thumbPath);

    const urlRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/upload-urls`, {
      method: 'POST',
      headers: cloudHeaders(),
      body: JSON.stringify({
        slideId,
        items: [{ key: thumbKey, contentType: 'image/jpeg' }],
      }),
    });

    if (urlRes.ok) {
      const { putUrls } = await urlRes.json();
      await fetch(putUrls[thumbKey], {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
        body: thumbData,
      });
      console.log(`[BIGTIFF-UPLOAD] Thumbnail uploaded: ${thumbKey}`);
    }
  } catch (err) {
    console.warn(`[BIGTIFF-UPLOAD] Thumb upload failed (non-fatal): ${err.message}`);
  }

  // Step 6b: Upload the label photo when the slide has one (non-fatal)
  let labelKey = null;
  const labelPath = await findLabelPath(slideId);
  if (labelPath) {
    const candidateKey = `${s3Prefix}label.jpg`;
    try {
      const labelData = await readFile(labelPath);
      const urlRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/upload-urls`, {
        method: 'POST',
        headers: cloudHeaders(),
        body: JSON.stringify({
          slideId,
          items: [{ key: candidateKey, contentType: 'image/jpeg' }],
        }),
      });
      if (urlRes.ok) {
        const { putUrls } = await urlRes.json();
        const putRes = await fetch(putUrls[candidateKey], {
          method: 'PUT',
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'private, max-age=86400',
          },
          body: labelData,
        });
        if (putRes.ok) {
          labelKey = candidateKey;
          console.log(`[BIGTIFF-UPLOAD] Label photo uploaded: ${candidateKey}`);
        } else {
          console.warn(`[BIGTIFF-UPLOAD] Label PUT failed (non-fatal): ${putRes.status}`);
        }
      }
    } catch (err) {
      console.warn(`[BIGTIFF-UPLOAD] Label upload failed (non-fatal): ${err.message}`);
    }
  }

  // Step 7: Notify cloud that BigTIFF is ready
  const readyRes = await fetchWithRetry(`${CLOUD_API_URL}/edge/slides/${slideId}/ready`, {
    method: 'POST',
    headers: cloudHeaders(),
    body: JSON.stringify({
      bigtiff: true,
      bigtiffKey,
      bigtiffSize: fileSize,
      tileCount: 1,
    }),
  });
  if (!readyRes.ok) throw new Error(`Cloud ready failed: ${readyRes.status} ${await readyRes.text()}`);

  const elapsed = Date.now() - uploadStart;
  const throughputMBs = (fileSize / 1024 / 1024 / (elapsed / 1000)).toFixed(1);
  console.log(`[BIGTIFF-UPLOAD] Complete: ${(fileSize / 1024 / 1024).toFixed(1)} MB in ${(elapsed / 1000).toFixed(1)}s (${throughputMBs} MB/s)`);

  return {
    status: 'READY',
    s3Prefix,
    bigtiffKey,
    labelKey,
    bigtiffSize: fileSize,
    elapsed,
  };
}
