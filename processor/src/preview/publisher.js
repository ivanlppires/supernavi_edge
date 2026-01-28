/**
 * Preview Publisher - Remote Preview Publishing Orchestrator
 *
 * Orchestrates the publishing of REBASED preview assets to Wasabi S3:
 * 1. Generates rebased preview tiles (scaled down image with own pyramid)
 * 2. Uploads thumb, manifest, and rebased tiles to Wasabi
 * 3. Persists local publication marker (idempotency)
 * 4. Emits PreviewPublished event to outbox
 *
 * The "rebased" approach means:
 * - Original image is scaled so max(width,height) = PREVIEW_TARGET_MAX_DIM
 * - This scaled image has its own tile pyramid with levels 0..PREVIEW_MAX_LEVEL
 * - OpenSeadragon renders a meaningful preview with proper zoom
 */

import { readFile, writeFile, access, readdir } from 'fs/promises';
import { join } from 'path';
import pg from 'pg';

import {
  generateRebasedPreviewTiles,
  calculateRebasedDimensions,
  getRebasedConfig
} from './rebasedPreview.js';
import {
  uploadThumb,
  uploadManifest,
  uploadRebasedTiles,
  createRemoteManifest,
  getSlidePrefix,
  getConfig,
  hashFile,
  hashContent
} from './wasabiUploader.js';

const { Pool } = pg;

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://supernavi:supernavi@db:5432/supernavi';
const PREVIEW_ENABLED = process.env.PREVIEW_REMOTE_ENABLED === 'true';
const PREVIEW_MAX_LEVEL = parseInt(process.env.PREVIEW_MAX_LEVEL || '6', 10);
const PREVIEW_TARGET_MAX_DIM = parseInt(process.env.PREVIEW_TARGET_MAX_DIM || '2048', 10);

let pool = null;

/**
 * Get database pool (lazy)
 */
function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

/**
 * Check if preview publishing is enabled
 */
export function isPreviewEnabled() {
  return PREVIEW_ENABLED;
}

/**
 * Check if file exists
 */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load manifest from disk
 */
async function loadManifest(slideId) {
  const manifestPath = join(DERIVED_DIR, slideId, 'manifest.json');
  const content = await readFile(manifestPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Get case_id for a slide (if linked)
 */
async function getCaseIdForSlide(slideId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT case_id FROM case_slides WHERE slide_id = $1 LIMIT 1`,
    [slideId]
  );
  return result.rows.length > 0 ? result.rows[0].case_id : null;
}

/**
 * Record event in outbox
 */
async function recordOutboxEvent({ entityType, entityId, op, payload }) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [entityType, entityId, op, JSON.stringify(payload)]
  );
  return result.rows[0];
}

/**
 * Load publication marker from disk
 */
async function loadPublicationMarker(slideId) {
  const markerPath = join(DERIVED_DIR, slideId, 'preview_published.json');
  try {
    const content = await readFile(markerPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save publication marker to disk
 */
async function savePublicationMarker(slideId, marker) {
  const markerPath = join(DERIVED_DIR, slideId, 'preview_published.json');
  await writeFile(markerPath, JSON.stringify(marker, null, 2));
  return markerPath;
}

/**
 * Compute content hash for idempotency check
 * Uses preview_tiles directory (rebased tiles)
 */
async function computeContentHash(slideId, maxLevel, targetMaxDim) {
  const slideDir = join(DERIVED_DIR, slideId);

  // Hash thumb
  const thumbPath = join(slideDir, 'thumb.jpg');
  const thumbHash = await hashFile(thumbPath);

  // Hash manifest
  const manifestPath = join(slideDir, 'manifest.json');
  const manifestHash = await hashFile(manifestPath);

  // Hash preview_tiles index (rebased tiles)
  const previewTilesDir = join(slideDir, 'preview_tiles');
  const tileIndex = [];

  for (let z = 0; z <= maxLevel; z++) {
    const levelDir = join(previewTilesDir, String(z));
    try {
      const files = await readdir(levelDir);
      const jpgFiles = files.filter(f => f.endsWith('.jpg')).sort();
      tileIndex.push(`${z}:${jpgFiles.length}:${jpgFiles.join(',')}`);
    } catch {
      tileIndex.push(`${z}:0:`);
    }
  }

  // Include targetMaxDim in hash to detect config changes
  tileIndex.push(`targetMaxDim:${targetMaxDim}`);

  const tilesHash = hashContent(tileIndex.join('|'));

  return { thumbHash, manifestHash, tilesHash };
}

/**
 * Check if preview needs republishing
 */
async function needsRepublish(slideId, maxLevel, targetMaxDim) {
  const marker = await loadPublicationMarker(slideId);

  if (!marker) {
    console.log(`[publisher] No marker found - needs publish`);
    return { needsPublish: true, reason: 'no_marker' };
  }

  if (marker.status === 'incomplete') {
    console.log(`[publisher] Previous publish incomplete - needs retry`);
    return { needsPublish: true, reason: 'incomplete' };
  }

  if (marker.maxLevel !== maxLevel) {
    console.log(`[publisher] maxLevel changed: ${marker.maxLevel} -> ${maxLevel}`);
    return { needsPublish: true, reason: 'level_change' };
  }

  if (marker.targetMaxDim !== targetMaxDim) {
    console.log(`[publisher] targetMaxDim changed: ${marker.targetMaxDim} -> ${targetMaxDim}`);
    return { needsPublish: true, reason: 'target_dim_change' };
  }

  // Check content hashes
  const currentHashes = await computeContentHash(slideId, maxLevel, targetMaxDim);

  if (marker.thumbHash !== currentHashes.thumbHash) {
    console.log(`[publisher] thumb changed`);
    return { needsPublish: true, reason: 'thumb_changed' };
  }

  if (marker.manifestHash !== currentHashes.manifestHash) {
    console.log(`[publisher] manifest changed`);
    return { needsPublish: true, reason: 'manifest_changed' };
  }

  if (marker.tilesHash !== currentHashes.tilesHash) {
    console.log(`[publisher] tiles changed`);
    return { needsPublish: true, reason: 'tiles_changed' };
  }

  console.log(`[publisher] Already published - skipping`);
  return { needsPublish: false, reason: 'already_published', marker };
}

/**
 * Publish remote preview for a slide using REBASED tiles
 *
 * @param {string} slideId - Slide identifier
 * @param {number} maxLevel - Maximum level to publish (default from env)
 * @param {number} targetMaxDim - Target max dimension for rebased image
 * @returns {Promise<{published: boolean, skipped: boolean, stats: Object}>}
 */
export async function publishRemotePreview(
  slideId,
  maxLevel = PREVIEW_MAX_LEVEL,
  targetMaxDim = PREVIEW_TARGET_MAX_DIM
) {
  const startTime = Date.now();

  console.log(`\n[publishRemotePreview] slideId=${slideId} maxLevel=${maxLevel} targetMaxDim=${targetMaxDim}`);
  console.log(`  Config: ${JSON.stringify(getConfig())}`);

  if (!PREVIEW_ENABLED) {
    console.log(`[publisher] Preview publishing disabled (PREVIEW_REMOTE_ENABLED=${PREVIEW_ENABLED})`);
    return { published: false, skipped: true, reason: 'disabled' };
  }

  const slideDir = join(DERIVED_DIR, slideId);

  // Verify required files exist
  const thumbPath = join(slideDir, 'thumb.jpg');
  const manifestPath = join(slideDir, 'manifest.json');

  if (!(await fileExists(thumbPath))) {
    throw new Error(`thumb.jpg not found: ${thumbPath}`);
  }
  if (!(await fileExists(manifestPath))) {
    throw new Error(`manifest.json not found: ${manifestPath}`);
  }

  // Load manifest
  const localManifest = await loadManifest(slideId);

  // Calculate rebased dimensions
  const rebased = calculateRebasedDimensions(
    localManifest.width,
    localManifest.height,
    targetMaxDim
  );

  console.log(`  Original: ${localManifest.width}x${localManifest.height} (levelMax=${localManifest.levelMax})`);
  console.log(`  Rebased: ${rebased.width}x${rebased.height} (scale=${rebased.scale.toFixed(3)})`);
  console.log(`  Preview maxLevel: ${maxLevel}`);

  // Check idempotency
  const { needsPublish, reason, marker } = await needsRepublish(slideId, maxLevel, targetMaxDim);

  if (!needsPublish) {
    console.log(`[publisher] Skipping - ${reason}`);
    return {
      published: false,
      skipped: true,
      reason,
      previousPublishAt: marker?.publishedAt
    };
  }

  // Mark as incomplete before starting
  const incompleteMarker = {
    status: 'incomplete',
    startedAt: new Date().toISOString(),
    maxLevel,
    targetMaxDim
  };
  await savePublicationMarker(slideId, incompleteMarker);

  try {
    // Step 1: Generate rebased preview tiles
    console.log(`\n  [Step 1] Generating rebased preview tiles (0..${maxLevel})...`);
    const tileStats = await generateRebasedPreviewTiles(slideId, maxLevel, targetMaxDim);
    console.log(`    Generated: ${tileStats.generated} tiles`);
    console.log(`    Rebased dimensions: ${tileStats.rebasedWidth}x${tileStats.rebasedHeight}`);

    // Step 2: Upload thumb
    console.log(`\n  [Step 2] Uploading thumb.jpg...`);
    const thumbResult = await uploadThumb(thumbPath, slideId);
    console.log(`    Uploaded: ${thumbResult.key} (${thumbResult.bytes} bytes)`);

    // Step 3: Create and upload remote manifest with REBASED dimensions
    console.log(`\n  [Step 3] Uploading manifest.json (rebased)...`);
    const remoteManifest = createRemoteManifest(
      localManifest,
      slideId,
      maxLevel,
      tileStats.rebasedWidth,
      tileStats.rebasedHeight
    );
    const manifestResult = await uploadManifest(remoteManifest, slideId);
    console.log(`    Uploaded: ${manifestResult.key} (${manifestResult.bytes} bytes)`);
    console.log(`    Manifest width=${remoteManifest.width} height=${remoteManifest.height} levelMax=${remoteManifest.levelMax}`);

    // Step 4: Upload rebased preview tiles
    console.log(`\n  [Step 4] Uploading rebased tiles 0..${maxLevel}...`);
    const previewTilesDir = join(slideDir, 'preview_tiles');
    const uploadStats = await uploadRebasedTiles(previewTilesDir, slideId, maxLevel);
    console.log(`    Uploaded: ${uploadStats.totalTiles} tiles (${uploadStats.totalBytes} bytes)`);

    // Step 5: Compute final hashes for marker
    const finalHashes = await computeContentHash(slideId, maxLevel, targetMaxDim);

    // Step 6: Get case_id (if linked)
    const caseId = await getCaseIdForSlide(slideId);
    console.log(`\n  Case ID: ${caseId || '(not linked)'}`);

    // Step 7: Emit PreviewPublished event
    console.log(`\n  [Step 5] Emitting PreviewPublished event...`);
    const wasabiConfig = getConfig();
    const publishedAt = new Date().toISOString();

    const eventPayload = {
      slide_id: slideId,
      case_id: caseId,
      wasabi_bucket: wasabiConfig.bucket,
      wasabi_region: wasabiConfig.region,
      wasabi_endpoint: wasabiConfig.endpoint,
      wasabi_prefix: getSlidePrefix(slideId),
      thumb_key: `${wasabiConfig.prefixBase}/${slideId}/thumb.jpg`,
      manifest_key: `${wasabiConfig.prefixBase}/${slideId}/manifest.json`,
      // FIXED: Use tiles/ path to match standard DZI and viewer expectation
      tiles_prefix: `${wasabiConfig.prefixBase}/${slideId}/tiles/`,
      max_preview_level: maxLevel,
      // REBASED dimensions for the cloud to use
      preview_width: tileStats.rebasedWidth,
      preview_height: tileStats.rebasedHeight,
      // Original dimensions for reference
      original_width: localManifest.width,
      original_height: localManifest.height,
      tile_size: 256,
      format: 'jpg',
      published_at: publishedAt,
      upload_stats: {
        tiles_count: uploadStats.totalTiles,
        tiles_bytes: uploadStats.totalBytes,
        thumb_bytes: thumbResult.bytes,
        manifest_bytes: manifestResult.bytes,
        tiles_generated: tileStats.generated,
        errors: uploadStats.errors?.length || 0
      }
    };

    const outboxEvent = await recordOutboxEvent({
      entityType: 'preview',
      entityId: `preview:${slideId}`,
      op: 'published',
      payload: eventPayload
    });
    console.log(`    Event ID: ${outboxEvent.event_id}`);

    // Step 8: Save success marker
    const successMarker = {
      status: 'complete',
      publishedAt,
      maxLevel,
      targetMaxDim,
      rebasedWidth: tileStats.rebasedWidth,
      rebasedHeight: tileStats.rebasedHeight,
      thumbHash: finalHashes.thumbHash,
      manifestHash: finalHashes.manifestHash,
      tilesHash: finalHashes.tilesHash,
      eventId: outboxEvent.event_id,
      uploadStats: {
        tilesCount: uploadStats.totalTiles,
        totalBytes: thumbResult.bytes + manifestResult.bytes + uploadStats.totalBytes
      }
    };
    await savePublicationMarker(slideId, successMarker);

    const elapsed = Date.now() - startTime;
    console.log(`\n[publishRemotePreview] Complete in ${elapsed}ms`);
    console.log(`  Total uploaded: ${successMarker.uploadStats.totalBytes} bytes`);
    console.log(`  Preview: ${tileStats.rebasedWidth}x${tileStats.rebasedHeight} with ${uploadStats.totalTiles} tiles`);

    return {
      published: true,
      skipped: false,
      slideId,
      eventId: outboxEvent.event_id,
      maxLevel,
      rebasedWidth: tileStats.rebasedWidth,
      rebasedHeight: tileStats.rebasedHeight,
      uploadStats: successMarker.uploadStats,
      elapsedMs: elapsed
    };

  } catch (err) {
    // Mark as incomplete on failure
    const failedMarker = {
      status: 'incomplete',
      startedAt: incompleteMarker.startedAt,
      failedAt: new Date().toISOString(),
      maxLevel,
      targetMaxDim,
      error: err.message
    };
    await savePublicationMarker(slideId, failedMarker);

    console.error(`[publishRemotePreview] FAILED: ${err.message}`);
    throw err;
  }
}

/**
 * Cleanup database pool on shutdown
 */
export async function shutdown() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
