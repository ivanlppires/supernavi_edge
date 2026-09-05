/**
 * Label photo publishing — shared by the BigTIFF uploader (new slides) and the
 * LABEL_PUBLISH job (backfill for slides uploaded before label support).
 *
 * The photo lives in derived/{slideId}/label.jpg (see lib/label-asset.js); it is
 * uploaded next to thumb.jpg through the cloud's presigned URLs and announced
 * to the cloud with `label_key` inside a preview/published event.
 */

import { readFile } from 'fs/promises';
import { dirname } from 'path';
import { getEdgeKey, getCloudApiUrl } from './lib/config-reader.js';
import { findLabelPath } from './lib/label-asset.js';

/**
 * S3 prefix of a BigTIFF slide from its slide.tif key:
 * slides/{slideId}/slide.tif → slides/{slideId}/
 * @param {string|null|undefined} s3BigtiffKey
 * @returns {string|null}
 */
export function bigtiffPrefix(s3BigtiffKey) {
  if (!s3BigtiffKey || typeof s3BigtiffKey !== 'string' || !s3BigtiffKey.includes('/')) return null;
  return dirname(s3BigtiffKey) + '/';
}

/**
 * Upload derived/{slideId}/label.jpg to `${s3Prefix}label.jpg` via a presigned
 * URL from the cloud. Non-fatal: returns the key on success, null otherwise.
 *
 * @param {string} slideId
 * @param {string} s3Prefix e.g. slides/{slideId}/
 * @param {{ fetch?: Function, labelPath?: string|null, edgeKey?: string, cloudApiUrl?: string }} [deps] test hooks
 * @returns {Promise<string|null>}
 */
export async function uploadLabelPhoto(slideId, s3Prefix, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const labelPath = deps.labelPath !== undefined ? deps.labelPath : await findLabelPath(slideId);
  if (!labelPath) return null;

  const edgeKey = deps.edgeKey !== undefined ? deps.edgeKey : getEdgeKey();
  const cloudApiUrl = deps.cloudApiUrl !== undefined ? deps.cloudApiUrl : getCloudApiUrl();
  if (!edgeKey) {
    console.warn('[label] EDGE_KEY not configured, cannot upload the label photo');
    return null;
  }

  const key = `${s3Prefix}label.jpg`;
  try {
    const labelData = await readFile(labelPath);
    const urlRes = await fetchImpl(`${cloudApiUrl}/edge/upload-urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-EDGE-KEY': edgeKey },
      body: JSON.stringify({ slideId, items: [{ key, contentType: 'image/jpeg' }] }),
    });
    if (!urlRes.ok) {
      console.warn(`[label] Presigned URL request failed for ${slideId.substring(0, 12)}: ${urlRes.status}`);
      return null;
    }
    const { putUrls } = await urlRes.json();
    if (!putUrls || !putUrls[key]) {
      console.warn(`[label] Cloud returned no URL for ${key}`);
      return null;
    }
    const putRes = await fetchImpl(putUrls[key], {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
      body: labelData,
    });
    if (!putRes.ok) {
      console.warn(`[label] PUT failed for ${key}: ${putRes.status}`);
      return null;
    }
    console.log(`[label] Uploaded ${key}`);
    return key;
  } catch (err) {
    console.warn(`[label] Upload failed for ${slideId.substring(0, 12)} (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * preview/published payload for an already-uploaded BigTIFF slide (mirrors the
 * BIGTIFF job's Phase 5 payload). `slide` is the row from the edge `slides` table.
 *
 * @param {{ slide: object, wasabi: { bucket: string, region: string, endpoint: string }, s3Prefix: string, labelKey: string|null }} input
 */
export function buildBigtiffPublishedPayload({ slide, wasabi, s3Prefix, labelKey }) {
  const size = slide.bigtiff_size === null || slide.bigtiff_size === undefined ? NaN : Number(slide.bigtiff_size);
  return {
    slide_id: slide.id,
    case_id: null,
    external_case_id: slide.external_case_id || null,
    external_case_base: slide.external_case_base || null,
    external_slide_label: slide.external_slide_label || null,
    wasabi_bucket: wasabi.bucket,
    wasabi_region: wasabi.region,
    wasabi_endpoint: wasabi.endpoint,
    wasabi_prefix: s3Prefix,
    thumb_key: `${s3Prefix}thumb.jpg`,
    ...(labelKey ? { label_key: labelKey } : {}),
    manifest_key: `${s3Prefix}manifest.json`,
    tiles_prefix: s3Prefix,
    low_tiles_prefix: s3Prefix,
    max_preview_level: slide.max_level,
    preview_width: slide.width,
    preview_height: slide.height,
    original_width: slide.width,
    original_height: slide.height,
    tile_size: 256,
    format: 'jpg',
    pipeline_mode: 'bigtiff_iiif',
    bigtiff_key: slide.s3_bigtiff_key,
    ...(Number.isFinite(size) ? { bigtiff_size: size } : {}),
    published_at: new Date().toISOString(),
  };
}
