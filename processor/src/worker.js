import { createClient } from 'redis';
import pg from 'pg';
import { stat, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { processP0 as processImageP0 } from './pipeline-p0.js';
import { processP1 as processImageP1 } from './pipeline-p1.js';
import { processSVS_P0, processSVS_P1, generateFullTilePyramid, persistTilesBackground, generateThumbnail } from './pipeline-svs.js';
import { publishRemotePreview, isPreviewEnabled, shutdown as shutdownPreview } from './preview/index.js';
import { getConfig as getWasabiConfig, getSlidePrefix } from './preview/wasabiUploader.js';
import { uploadSlideToCloud } from './cloud-uploader.js';
import { generateBigTIFF, cleanupBigTIFF, checkDiskSpace, calculateParallelSlots } from './bigtiff-generator.js';
import { uploadBigTIFF } from './bigtiff-uploader.js';
import { getEdgeKey, getCloudApiUrl } from './lib/config-reader.js';
import { pipelineLog } from './lib/pipeline-log.js';
import { canEmitRegistered } from './lib/review-gate.js';
import { readFileSync } from 'fs';

const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return 'unknown'; }
})();

/**
 * name_confirmed flag sent to the cloud with SlideRegistered: true unless the
 * slide is still waiting for (or failed) technician review. NULL review_status
 * = legacy slide, treated as confirmed. The cloud refuses to auto-link
 * unconfirmed names to patient cases.
 */
function isNameConfirmed(reviewStatus) {
  return reviewStatus !== 'pending' && reviewStatus !== 'rescan';
}

// Pipeline mode: 'legacy_dzi' (default) or 'bigtiff_iiif'
const PIPELINE_MODE = process.env.EDGE_PIPELINE_MODE || 'legacy_dzi';

const { Pool } = pg;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL || 'postgres://supernavi:supernavi@localhost:5432/supernavi';
const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

let redis = null;
let pool = null;

// Track background persist promise so we can await it before the next TILEGEN.
// This prevents tmpfs overflow: only 1 slide's tiles in hot at a time.
let pendingPersist = null;

// Track active BIGTIFF jobs for parallel processing
const activeBigtiffJobs = new Set();

// Formats that use the SVS/WSI pipeline
const WSI_FORMATS = ['svs', 'tiff', 'ndpi', 'mrxs'];

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: redisUrl });
    redis.on('error', err => console.error('Redis error:', err));
    await redis.connect();
  }
  return redis;
}

/**
 * Publish event to Redis for SSE subscribers
 */
async function publishEvent(event, data) {
  try {
    const client = await getRedis();
    await client.publish('supernavi:events', JSON.stringify({ event, data }));
  } catch (err) {
    console.error('Failed to publish event:', err.message);
  }
}

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

/**
 * Shorthand for pipelineLog with the worker's pool.
 */
async function logEvent(slideId, stage, level, message, details) {
  return pipelineLog(getPool(), slideId, stage, level, message, details);
}

async function updateJob(jobId, updates) {
  const fields = ['updated_at = NOW()'];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }

  values.push(jobId);
  await getPool().query(
    `UPDATE jobs SET ${fields.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function updateSlide(slideId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }

  values.push(slideId);
  await getPool().query(
    `UPDATE slides SET ${fields.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function enqueueJob(jobData) {
  const client = await getRedis();
  await client.lPush('jobs:pending', JSON.stringify(jobData));
}

async function createJob(slideId, type) {
  // Skip if an active job (queued or running) already exists
  const existing = await getPool().query(
    `SELECT id FROM jobs WHERE slide_id = $1 AND type = $2 AND status IN ('queued', 'running') LIMIT 1`,
    [slideId, type]
  );
  if (existing.rows.length > 0) {
    console.log(`[worker] Skipping duplicate ${type} for ${slideId.substring(0, 12)} (existing: ${existing.rows[0].id})`);
    return null;
  }

  const result = await getPool().query(
    `INSERT INTO jobs (slide_id, type, status) VALUES ($1, $2, 'queued') RETURNING id`,
    [slideId, type]
  );
  return result.rows[0].id;
}

/**
 * Determine if format is a WSI format
 */
function isWSIFormat(format) {
  return WSI_FORMATS.includes(format?.toLowerCase());
}

/**
 * Process P0 job - routes to appropriate pipeline based on format
 */
async function processP0(job) {
  const format = job.format || 'unknown';
  console.log(`Processing P0 [format: ${format}] for slide ${job.slideId.substring(0, 12)}...`);

  if (isWSIFormat(format)) {
    return processSVS_P0(job);
  } else {
    return processImageP0(job);
  }
}

/**
 * Process P1 job - routes to appropriate pipeline based on format
 */
async function processP1(job) {
  const format = job.format || 'unknown';
  console.log(`Processing P1 [format: ${format}] for slide ${job.slideId.substring(0, 12)}...`);

  if (isWSIFormat(format)) {
    return processSVS_P1(job);
  } else {
    return processImageP1(job);
  }
}

async function processJob(job) {
  const format = job.format || 'unknown';
  console.log(`Processing job: ${job.type} for slide ${job.slideId.substring(0, 12)}... [${format}]`);

  // Guard: skip if slide already past this stage
  try {
    const slideCheck = await getPool().query('SELECT status, tilegen_status FROM slides WHERE id = $1', [job.slideId]);
    const s = slideCheck.rows[0];
    if (s) {
      if (job.type === 'P0' && s.status !== 'queued') {
        console.log(`[worker] Skipping P0 for ${job.slideId.substring(0, 12)}: status already ${s.status}`);
        await updateJob(job.jobId, { status: 'done' });
        return;
      }
      if (job.type === 'TILEGEN' && s.tilegen_status === 'done') {
        console.log(`[worker] Skipping TILEGEN for ${job.slideId.substring(0, 12)}: already done`);
        await updateJob(job.jobId, { status: 'done' });
        return;
      }
    }
  } catch (checkErr) {
    console.warn(`[worker] Status check failed (non-fatal): ${checkErr.message}`);
  }

  // Guard: verify raw file exists before processing
  if (job.rawPath && ['P0', 'P1', 'TILEGEN'].includes(job.type)) {
    try {
      const rawStats = await stat(job.rawPath);
      console.log(`[worker] Raw file verified: ${job.rawPath} (${(rawStats.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch {
      const msg = `Raw file not found: ${job.rawPath}`;
      console.error(`[worker] ${msg} - aborting ${job.type} for ${job.slideId.substring(0, 12)}`);
      await updateJob(job.jobId, { status: 'failed', error: msg });
      await updateSlide(job.slideId, { status: 'failed' });
      await logEvent(job.slideId, job.type.toLowerCase(), 'error', msg, { rawPath: job.rawPath });
      return;
    }
  }

  await updateJob(job.jobId, { status: 'running' });
  await updateSlide(job.slideId, { status: 'processing' });
  await logEvent(job.slideId, job.type.toLowerCase(), 'info', `${job.type} started`, { format: job.format });

  try {
    if (job.type === 'P0') {
      const result = await processP0(job);

      // Update slide with metadata
      // For bigtiff_iiif pipeline, keep status as 'processing' until BIGTIFF completes
      const needsPostP0 = isWSIFormat(format) && PIPELINE_MODE === 'bigtiff_iiif';
      const slideUpdate = {
        width: result.width,
        height: result.height,
        max_level: result.maxLevel,
        level_ready_max: result.levelReadyMax,
        thumb_path: result.thumbPath,
        manifest_path: result.manifestPath,
        status: needsPostP0 ? 'processing' : 'ready'
      };
      // Add magnification metadata if available
      if (result.appMag !== undefined && result.appMag !== null) {
        slideUpdate.app_mag = result.appMag;
      }
      if (result.mpp !== undefined && result.mpp !== null) {
        slideUpdate.mpp = result.mpp;
      }
      await updateSlide(job.slideId, slideUpdate);

      await updateJob(job.jobId, { status: 'done' });

      // Publish slide:ready event for SSE subscribers (only if truly ready)
      if (!needsPostP0) {
        await publishEvent('slide:ready', {
          slideId: job.slideId,
          width: result.width,
          height: result.height,
          maxLevel: result.maxLevel,
          timestamp: Date.now()
        });
      }

      // Enqueue P1 job for remaining levels (only for image formats)
      // WSI formats generate all levels at once with vips dzsave
      if (!isWSIFormat(format) && result.maxLevel > result.p0MaxLevel) {
        const p1JobId = await createJob(job.slideId, 'P1');
        if (p1JobId) {
          await enqueueJob({
            jobId: p1JobId,
            slideId: job.slideId,
            type: 'P1',
            rawPath: job.rawPath,
            format: format,
            startLevel: result.p0MaxLevel + 1,
            maxLevel: result.maxLevel
          });
          console.log(`Enqueued P1 job for levels ${result.p0MaxLevel + 1}-${result.maxLevel}`);
        }
      }

      console.log(`P0 complete for ${job.slideId.substring(0, 12)}: ${result.width}x${result.height}, maxLevel=${result.maxLevel}`);
      await logEvent(job.slideId, 'p0', 'info', 'P0 complete', {
        width: result.width, height: result.height, maxLevel: result.maxLevel
      });

      // NOTE: SlideRegistered outbox event is emitted after TILEGEN completes,
      // so the slide only appears in the extension when fully navigable.

      // Enqueue post-P0 job based on pipeline mode
      if (isWSIFormat(format)) {
        const jobType = PIPELINE_MODE === 'bigtiff_iiif' ? 'BIGTIFF' : 'TILEGEN';
        try {
          const postP0JobId = await createJob(job.slideId, jobType);
          if (postP0JobId) {
            await updateSlide(job.slideId, {
              tilegen_status: 'queued',
              pipeline_mode: PIPELINE_MODE,
            });
            await enqueueJob({
              jobId: postP0JobId,
              slideId: job.slideId,
              type: jobType,
              rawPath: job.rawPath,
              format: format,
              maxLevel: result.maxLevel
            });
            console.log(`Enqueued ${jobType} job for ${job.slideId.substring(0, 12)} (mode: ${PIPELINE_MODE})`);
          }
        } catch (enqueueErr) {
          console.error(`Failed to enqueue ${jobType} (non-fatal): ${enqueueErr.message}`);
          await logEvent(job.slideId, jobType.toLowerCase(), 'error',
            `Failed to enqueue ${jobType}: ${enqueueErr.message}`);
        }
      }

      // Publish remote preview to Wasabi (async, non-blocking)
      if (isPreviewEnabled()) {
        try {
          console.log(`Publishing remote preview for ${job.slideId.substring(0, 12)}...`);
          const previewResult = await publishRemotePreview(job.slideId);
          if (previewResult.published) {
            console.log(`Preview published: ${previewResult.uploadStats.tilesCount} tiles, ${previewResult.uploadStats.totalBytes} bytes`);
            await publishEvent('preview:published', {
              slideId: job.slideId,
              maxLevel: previewResult.maxLevel,
              timestamp: Date.now()
            });
          } else if (previewResult.skipped) {
            console.log(`Preview skipped: ${previewResult.reason}`);
          }
        } catch (previewErr) {
          // Non-fatal: log and continue
          console.error(`Preview publish failed (non-fatal): ${previewErr.message}`);
          await logEvent(job.slideId, 'preview', 'error',
            `Preview publish failed: ${previewErr.message}`);
        }
      }
    } else if (job.type === 'P1') {
      const result = await processP1(job);
      await updateSlide(job.slideId, { level_ready_max: result.levelReadyMax });
      await updateJob(job.jobId, { status: 'done' });
      console.log(`P1 complete for ${job.slideId.substring(0, 12)}, levelReadyMax=${result.levelReadyMax}`);
    } else if (job.type === 'CLEANUP') {
      // Request cloud to delete preview from Wasabi S3
      console.log(`Requesting cloud cleanup for ${job.slideId.substring(0, 12)}...`);
      try {
        const CLOUD_API_URL = getCloudApiUrl();
        const EDGE_KEY = getEdgeKey();
        const res = await fetch(`${CLOUD_API_URL}/edge/slides/${job.slideId}/cleanup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-EDGE-KEY': EDGE_KEY },
        });
        if (!res.ok) {
          throw new Error(`Cloud cleanup failed: ${res.status} ${await res.text()}`);
        }
        const result = await res.json();
        console.log(`Cleanup requested: ${JSON.stringify(result)}`);
        await publishEvent('cleanup:complete', {
          slideId: job.slideId,
          timestamp: Date.now()
        });
      } catch (cleanupErr) {
        console.error(`Cleanup failed: ${cleanupErr.message}`);
        await publishEvent('cleanup:failed', {
          slideId: job.slideId,
          error: cleanupErr.message,
          timestamp: Date.now()
        });
        await logEvent(job.slideId, 'cleanup', 'error',
          `Cloud cleanup failed: ${cleanupErr.message}`);
      }
      // Note: CLEANUP jobs don't have a database job record
    } else if (job.type === 'PREVIEW_REPUBLISH') {
      // Re-publish preview for an already-processed slide
      console.log(`Re-publishing preview for ${job.slideId.substring(0, 12)}...`);
      try {
        // Regenerate thumbnail from raw file before re-uploading
        const db = await getPool();
        const slideRow = await db.query('SELECT raw_path, format FROM slides WHERE id = $1', [job.slideId]);
        const rawPath = slideRow.rows[0]?.raw_path;
        const format = slideRow.rows[0]?.format || '';
        const isWSI = WSI_FORMATS.includes(format.toLowerCase());

        if (rawPath && isWSI) {
          const thumbPath = join(DERIVED_DIR, job.slideId, 'thumb.jpg');
          console.log(`  Regenerating thumbnail from ${rawPath}...`);
          await generateThumbnail(rawPath, thumbPath);
        }

        // Optionally delete marker to force re-upload
        if (job.force) {
          const markerPath = join(DERIVED_DIR, job.slideId, 'preview_published.json');
          await rm(markerPath, { force: true });
          console.log(`  Deleted preview marker (force mode)`);
        }

        const previewResult = await publishRemotePreview(job.slideId, job.maxLevel, job.targetMaxDim, { force: true });
        if (previewResult.published) {
          console.log(`  Preview republished: ${previewResult.uploadStats.tilesCount} tiles, ${previewResult.uploadStats.totalBytes} bytes in ${previewResult.elapsedMs}ms`);
          await publishEvent('preview:published', {
            slideId: job.slideId,
            maxLevel: previewResult.maxLevel,
            republish: true,
            timestamp: Date.now(),
          });
        } else if (previewResult.skipped) {
          console.log(`  Preview republish skipped: ${previewResult.reason}`);
        }
      } catch (err) {
        console.error(`  Preview republish failed: ${err.message}`);
        await publishEvent('preview:failed', {
          slideId: job.slideId,
          error: err.message,
          timestamp: Date.now(),
        });
      }
      // Note: PREVIEW_REPUBLISH jobs don't have a database job record
    } else if (job.type === 'TILEGEN') {
      // Full tile pyramid generation using vips dzsave

      // Ensure previous slide's tiles have been persisted and cleaned from tmpfs.
      // Without this, tiles accumulate in the 2GB tmpfs causing "No space left on device".
      if (pendingPersist) {
        console.log(`[TILEGEN] Waiting for previous tile persistence to free tmpfs...`);
        await pendingPersist;
        pendingPersist = null;
        console.log(`[TILEGEN] Previous tiles persisted, tmpfs clear.`);
      }

      await updateSlide(job.slideId, { tilegen_status: 'running' });
      await updateJob(job.jobId, { status: 'running' });

      try {
        const result = await generateFullTilePyramid(job.slideId, job.rawPath);

        await updateSlide(job.slideId, {
          tilegen_status: 'done',
          level_ready_max: job.maxLevel
        });
        await updateJob(job.jobId, { status: 'done' });

        await publishEvent('tiles:ready', {
          slideId: job.slideId,
          tileCount: result.tileCount,
          elapsed: result.elapsed,
          timestamp: Date.now()
        });

        console.log(`TILEGEN complete for ${job.slideId.substring(0, 12)}: ${result.tileCount} tiles in ${result.elapsed}ms`);

        // Emit SlideRegistered outbox event now that tiles are fully ready
        try {
          const slideRow = await getPool().query(
            'SELECT external_case_id, external_case_base, external_slide_label, original_filename, width, height, mpp, review_status FROM slides WHERE id = $1',
            [job.slideId]
          );
          const slide = slideRow.rows[0];
          if (slide) {
            if (!(await canEmitRegistered(getPool(), job.slideId))) {
              console.log(`[Sync] Skipping SlideRegistered for ${job.slideId.substring(0, 12)} (not confirmed)`);
            } else {
              await getPool().query(
                `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
                 VALUES ($1, $2, $3, $4)`,
                ['slide', job.slideId, 'registered', JSON.stringify({
                  slide_id: job.slideId,
                  case_id: null,
                  svs_filename: slide.original_filename,
                  width: slide.width || 0,
                  height: slide.height || 0,
                  mpp: parseFloat(slide.mpp) || 0,
                  external_case_id: slide.external_case_id || null,
                  external_case_base: slide.external_case_base || null,
                  external_slide_label: slide.external_slide_label || null,
                  name_confirmed: isNameConfirmed(slide.review_status),
                })]
              );
              console.log(`SlideRegistered event emitted for ${job.slideId.substring(0, 12)} (after TILEGEN)`);
            }
          }
        } catch (outboxErr) {
          console.error(`Failed to emit SlideRegistered event (non-fatal): ${outboxErr.message}`);
          await logEvent(job.slideId, 'outbox', 'error',
            `Failed to emit SlideRegistered: ${outboxErr.message}`);
        }

        // Restore slide status to 'ready' after TILEGEN completes
        await updateSlide(job.slideId, { status: 'ready' });
        await logEvent(job.slideId, 'tilegen', 'info', 'TILEGEN complete', {
          tileCount: result.tileCount, elapsedMs: result.elapsed
        });

        // Cloud upload: send full tile pyramid to Wasabi and notify cloud
        // IMPORTANT: Must complete BEFORE persistTilesBackground, which deletes hot tiles
        if (process.env.CLOUD_UPLOAD_ENABLED === 'true') {
          try {
            await updateSlide(job.slideId, { cloud_upload_status: 'uploading' });
            await publishEvent('cloud:uploading', {
              slideId: job.slideId,
              timestamp: Date.now(),
            });

            const slideRow = await getPool().query(
              'SELECT original_filename, width, height, mpp, max_level FROM slides WHERE id = $1',
              [job.slideId]
            );
            const slide = slideRow.rows[0];
            if (slide) {
              const uploadResult = await uploadSlideToCloud(job.slideId, {
                originalFilename: slide.original_filename,
                width: slide.width,
                height: slide.height,
                mpp: slide.mpp,
                scanner: undefined,
                maxLevel: slide.max_level,
              });

              await updateSlide(job.slideId, {
                cloud_upload_status: 'done',
                cloud_upload_mode: uploadResult.mode || 'individual',
                cloud_upload_at: new Date().toISOString(),
              });
              await publishEvent('cloud:ready', {
                slideId: job.slideId,
                mode: uploadResult.mode,
                tileCount: uploadResult.tileCount,
                elapsed: uploadResult.elapsed,
                timestamp: Date.now(),
              });

              console.log(`[UPLOAD] Result for ${job.slideId.substring(0, 12)}: ${uploadResult.status} (${uploadResult.mode || 'unknown'} mode, ${((uploadResult.elapsed || 0) / 1000).toFixed(1)}s)`);

              // Emit updated preview:published event pointing to full tiles
              try {
                const s3Prefix = uploadResult.s3Prefix;
                if (s3Prefix) {
                  const wCfg = getWasabiConfig();
                  const slideRow2 = await getPool().query(
                    'SELECT original_filename, width, height, mpp, max_level, external_case_id, external_case_base, external_slide_label FROM slides WHERE id = $1',
                    [job.slideId]
                  );
                  const s = slideRow2.rows[0];
                  if (s) {
                    await getPool().query(
                      `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
                       VALUES ($1, $2, $3, $4)`,
                      ['preview', `preview:${job.slideId}`, 'published', JSON.stringify({
                        slide_id: job.slideId,
                        case_id: null,
                        external_case_id: s.external_case_id || null,
                        external_case_base: s.external_case_base || null,
                        external_slide_label: s.external_slide_label || null,
                        wasabi_bucket: wCfg.bucket,
                        wasabi_region: wCfg.region,
                        wasabi_endpoint: wCfg.endpoint,
                        wasabi_prefix: getSlidePrefix(job.slideId),
                        thumb_key: `${wCfg.prefixBase}/${job.slideId}/thumb.jpg`,
                        manifest_key: `${wCfg.prefixBase}/${job.slideId}/manifest.json`,
                        tiles_prefix: s3Prefix,
                        low_tiles_prefix: `${wCfg.prefixBase}/${job.slideId}/tiles/`,
                        max_preview_level: s.max_level,
                        preview_width: s.width,
                        preview_height: s.height,
                        original_width: s.width,
                        original_height: s.height,
                        tile_size: 256,
                        format: 'jpg',
                        full_tiles_ready: true,
                        published_at: new Date().toISOString(),
                      })]
                    );
                    console.log(`[UPLOAD] Emitted full preview:published event for ${job.slideId.substring(0, 12)} (tiles_prefix: ${s3Prefix})`);
                  }
                }


              } catch (manifestErr) {
                console.error(`[UPLOAD] Failed to emit full preview event (non-fatal): ${manifestErr.message}`);
                await logEvent(job.slideId, 'outbox', 'warn',
                  `Failed to emit preview:published: ${manifestErr.message}`);
              }
            }
          } catch (uploadErr) {
            await updateSlide(job.slideId, { cloud_upload_status: 'failed' }).catch(() => {});
            await publishEvent('cloud:failed', {
              slideId: job.slideId,
              error: uploadErr.message,
              timestamp: Date.now(),
            }).catch(() => {});
            console.error(`[UPLOAD] Failed for ${job.slideId.substring(0, 12)} (non-fatal): ${uploadErr.message}`);
            await logEvent(job.slideId, 'cloud_upload', 'error',
              `Cloud upload failed: ${uploadErr.message}`);
          }
        }

        // Persist hot tiles to bind-mount storage AFTER cloud upload completes.
        // Skip if tiles were written directly to NTFS (oversized slide fallback).
        if (result.persistent) {
          console.log(`[TILEGEN] Tiles already on persistent storage (NTFS direct), skipping persist step.`);
        } else {
          // Track the promise so the NEXT TILEGEN waits for cleanup before starting.
          pendingPersist = persistTilesBackground(job.slideId);
          pendingPersist.catch(err => {
            console.error(`[PERSIST] Failed for ${job.slideId.substring(0, 12)}: ${err.message}`);
          });
        }
      } catch (tilegenErr) {
        console.error(`TILEGEN failed for ${job.slideId.substring(0, 12)}: ${tilegenErr.message}`);
        // FIX: previously this marked the slide as 'ready', causing it to appear
        // as completed in the dashboard while the cloud never received tiles.
        // Mark the slide as 'failed' so it is visible as a problem and so the
        // SlideRegistered outbox event is NOT emitted (it's emitted in the try
        // block above, before this catch).
        await updateSlide(job.slideId, { tilegen_status: 'failed', status: 'failed' });
        await updateJob(job.jobId, { status: 'failed', error: tilegenErr.message });
        await logEvent(job.slideId, 'tilegen', 'error',
          `TILEGEN failed: ${tilegenErr.message}`,
          { stack: tilegenErr.stack ? tilegenErr.stack.split('\n').slice(0, 3).join('\n') : null });
        await publishEvent('slide:failed', {
          slideId: job.slideId,
          stage: 'tilegen',
          error: tilegenErr.message,
          timestamp: Date.now()
        }).catch(() => {});
      }
    } else if (job.type === 'BIGTIFF') {
      // BigTIFF pipeline: generate single pyramidal BigTIFF + upload to S3
      await updateSlide(job.slideId, { tilegen_status: 'running', pipeline_mode: 'bigtiff_iiif' });
      await updateJob(job.jobId, { status: 'running' });

      try {
        // Check disk space before starting
        const freeBytes = await checkDiskSpace();
        const freeGB = freeBytes / 1024 / 1024 / 1024;
        if (freeGB < 5) {
          throw new Error(`Insufficient disk space: ${freeGB.toFixed(1)} GB free (need 5+ GB)`);
        }

        // Phase 1: Generate BigTIFF
        console.log(`[BIGTIFF] Starting pipeline for ${job.slideId.substring(0, 12)} (mode: bigtiff_iiif)`);
        const genResult = await generateBigTIFF(job.slideId, job.rawPath);

        await updateSlide(job.slideId, { bigtiff_size: genResult.size });

        // Phase 2: Upload BigTIFF to S3 via presigned multipart
        const slideRow = await getPool().query(
          'SELECT original_filename, width, height, mpp, max_level FROM slides WHERE id = $1',
          [job.slideId]
        );
        const slide = slideRow.rows[0];
        if (!slide) throw new Error('Slide not found in DB');

        const uploadResult = await uploadBigTIFF(job.slideId, genResult.path, {
          originalFilename: slide.original_filename,
          width: slide.width,
          height: slide.height,
          mpp: slide.mpp,
          scanner: undefined,
          maxLevel: slide.max_level,
        });

        // Phase 3: Update state
        await updateSlide(job.slideId, {
          tilegen_status: 'done',
          level_ready_max: job.maxLevel,
          s3_bigtiff_key: uploadResult.bigtiffKey || null,
          cloud_upload_status: 'done',
          cloud_upload_mode: 'bigtiff',
          cloud_upload_at: new Date().toISOString(),
        });
        await updateJob(job.jobId, { status: 'done' });

        // Phase 4: Emit SlideRegistered outbox event
        try {
          const slideData = await getPool().query(
            'SELECT external_case_id, external_case_base, external_slide_label, original_filename, width, height, mpp, review_status FROM slides WHERE id = $1',
            [job.slideId]
          );
          const s = slideData.rows[0];
          if (s) {
            if (!(await canEmitRegistered(getPool(), job.slideId))) {
              console.log(`[Sync] Skipping SlideRegistered for ${job.slideId.substring(0, 12)} (not confirmed)`);
            } else {
              await getPool().query(
                `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
                 VALUES ($1, $2, $3, $4)`,
                ['slide', job.slideId, 'registered', JSON.stringify({
                  slide_id: job.slideId,
                  case_id: null,
                  svs_filename: s.original_filename,
                  width: s.width || 0,
                  height: s.height || 0,
                  mpp: parseFloat(s.mpp) || 0,
                  external_case_id: s.external_case_id || null,
                  external_case_base: s.external_case_base || null,
                  external_slide_label: s.external_slide_label || null,
                  pipeline_mode: 'bigtiff_iiif',
                  name_confirmed: isNameConfirmed(s.review_status),
                })]
              );
              console.log(`[BIGTIFF] SlideRegistered event emitted for ${job.slideId.substring(0, 12)}`);
            }
          }
        } catch (outboxErr) {
          console.error(`[BIGTIFF] Failed to emit SlideRegistered (non-fatal): ${outboxErr.message}`);
          await logEvent(job.slideId, 'outbox', 'error',
            `Failed to emit SlideRegistered: ${outboxErr.message}`);
        }

        // Phase 5: Emit preview:published event (for cloud to know where the BigTIFF is)
        try {
          const wCfg = getWasabiConfig();
          const s3Prefix = uploadResult.s3Prefix;
          const slideData2 = await getPool().query(
            'SELECT original_filename, width, height, mpp, max_level, external_case_id, external_case_base, external_slide_label FROM slides WHERE id = $1',
            [job.slideId]
          );
          const s2 = slideData2.rows[0];
          if (s2 && s3Prefix) {
            await getPool().query(
              `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
               VALUES ($1, $2, $3, $4)`,
              ['preview', `preview:${job.slideId}`, 'published', JSON.stringify({
                slide_id: job.slideId,
                case_id: null,
                external_case_id: s2.external_case_id || null,
                external_case_base: s2.external_case_base || null,
                external_slide_label: s2.external_slide_label || null,
                wasabi_bucket: wCfg.bucket,
                wasabi_region: wCfg.region,
                wasabi_endpoint: wCfg.endpoint,
                wasabi_prefix: s3Prefix,
                thumb_key: `${s3Prefix}thumb.jpg`,
                manifest_key: `${s3Prefix}manifest.json`,
                tiles_prefix: s3Prefix,
                low_tiles_prefix: s3Prefix,
                max_preview_level: s2.max_level,
                preview_width: s2.width,
                preview_height: s2.height,
                original_width: s2.width,
                original_height: s2.height,
                tile_size: 256,
                format: 'jpg',
                pipeline_mode: 'bigtiff_iiif',
                bigtiff_key: uploadResult.bigtiffKey,
                bigtiff_size: uploadResult.bigtiffSize,
                published_at: new Date().toISOString(),
              })]
            );
          }
        } catch (previewErr) {
          console.error(`[BIGTIFF] Failed to emit preview event (non-fatal): ${previewErr.message}`);
          await logEvent(job.slideId, 'outbox', 'warn',
            `Failed to emit preview:published: ${previewErr.message}`);
        }

        // Restore slide status to 'ready'
        await updateSlide(job.slideId, { status: 'ready' });
        await logEvent(job.slideId, 'bigtiff', 'info', 'BigTIFF pipeline complete', {
          bigtiffSize: genResult.size,
          generationMs: genResult.elapsed,
          uploadMs: uploadResult.elapsed
        });

        await publishEvent('bigtiff:ready', {
          slideId: job.slideId,
          bigtiffSize: genResult.size,
          generationTime: genResult.elapsed,
          uploadTime: uploadResult.elapsed,
          totalTime: Date.now() - (Date.now() - genResult.elapsed - (uploadResult.elapsed || 0)),
          timestamp: Date.now(),
        });

        // Phase 6: Clean up temp BigTIFF file
        await cleanupBigTIFF(job.slideId);

        // Phase 7: Keep raw SVS file for potential re-processing/debugging.
        // Cleanup is done manually or by a separate housekeeping job.
        console.log(`[BIGTIFF] Raw file retained: ${job.rawPath}`);

        const totalElapsed = genResult.elapsed + (uploadResult.elapsed || 0);
        console.log(`[BIGTIFF] Pipeline complete for ${job.slideId.substring(0, 12)}: ${(genResult.size / 1024 / 1024).toFixed(1)} MB, gen=${(genResult.elapsed / 1000).toFixed(1)}s, upload=${((uploadResult.elapsed || 0) / 1000).toFixed(1)}s, total=${(totalElapsed / 1000).toFixed(1)}s`);
      } catch (bigtiffErr) {
        console.error(`[BIGTIFF] Failed for ${job.slideId.substring(0, 12)}: ${bigtiffErr.message}`);
        // FIX: same bug as TILEGEN — previously marked as 'ready' causing
        // silent cloud sync failures. Mark as 'failed' so it's visible.
        await updateSlide(job.slideId, { tilegen_status: 'failed', status: 'failed' });
        await updateJob(job.jobId, { status: 'failed', error: bigtiffErr.message });
        await logEvent(job.slideId, 'bigtiff', 'error',
          `BigTIFF pipeline failed: ${bigtiffErr.message}`,
          { stack: bigtiffErr.stack ? bigtiffErr.stack.split('\n').slice(0, 3).join('\n') : null });
        await publishEvent('slide:failed', {
          slideId: job.slideId,
          stage: 'bigtiff',
          error: bigtiffErr.message,
          timestamp: Date.now()
        }).catch(() => {});
        // Clean up temp file on failure
        await cleanupBigTIFF(job.slideId).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`Job failed: ${err.message}`);
    console.error(err.stack);
    await updateJob(job.jobId, { status: 'failed', error: err.message });
    await updateSlide(job.slideId, { status: 'failed' });
    await logEvent(job.slideId, (job.type || 'unknown').toLowerCase(), 'error',
      `${job.type} failed: ${err.message}`,
      { stack: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : null });
    await publishEvent('slide:failed', {
      slideId: job.slideId,
      stage: (job.type || 'unknown').toLowerCase(),
      error: err.message,
      timestamp: Date.now()
    }).catch(() => {});
  }
}

/**
 * Wait for PostgreSQL to be ready (it may start after the processor).
 */
async function waitForDatabase() {
  let retries = 30;
  while (retries > 0) {
    try {
      await getPool().query('SELECT 1');
      return;
    } catch (err) {
      retries--;
      console.log(`[STARTUP] Database not ready, retrying... (${retries} left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Database not available after 60s');
}

/**
 * Reset orphaned jobs left in 'running' status from a previous crash.
 * Must be called at startup before processing new jobs.
 */
async function resetOrphanedJobs() {
  const result = await getPool().query(
    `UPDATE jobs SET status = 'failed', error = 'orphaned: worker restarted', updated_at = NOW()
     WHERE status = 'running'
     RETURNING id, slide_id, type`
  );
  if (result.rowCount > 0) {
    for (const job of result.rows) {
      console.log(`[STARTUP] Reset orphaned ${job.type} job ${job.id} for slide ${job.slide_id.substring(0, 12)}`);
    }
    // Also reset slides stuck in 'processing' status due to orphaned jobs
    await getPool().query(
      `UPDATE slides SET status = 'ready'
       WHERE status = 'processing'
       AND id IN (SELECT slide_id FROM jobs WHERE error = 'orphaned: worker restarted' AND status = 'failed')`
    );
    console.log(`[STARTUP] Reset ${result.rowCount} orphaned job(s)`);
  }
}

/**
 * Re-queue TILEGEN/BIGTIFF for slides that failed or were interrupted.
 * Called once at startup so failed slides are automatically retried.
 */
async function retryFailedTilegen() {
  try {
    const result = await getPool().query(
      `SELECT id, raw_path, format, max_level, pipeline_mode FROM slides WHERE tilegen_status IN ('failed', 'queued', 'running')`
    );
    if (result.rows.length === 0) return;

    console.log(`[RETRY] Found ${result.rows.length} slides with incomplete processing, re-queuing...`);

    for (const slide of result.rows) {
      // Verify raw file still exists
      try {
        await stat(slide.raw_path);
      } catch {
        console.log(`[RETRY] Skipping ${slide.id.substring(0, 12)}: raw file missing`);
        continue;
      }

      // Determine job type based on slide's pipeline_mode or current global mode
      const slideMode = slide.pipeline_mode || PIPELINE_MODE;
      const jobType = slideMode === 'bigtiff_iiif' ? 'BIGTIFF' : 'TILEGEN';

      const jobId = await createJob(slide.id, jobType);
      if (jobId) {
        await updateSlide(slide.id, { tilegen_status: 'queued' });
        await enqueueJob({
          jobId,
          slideId: slide.id,
          type: jobType,
          rawPath: slide.raw_path,
          format: slide.format,
          maxLevel: slide.max_level,
        });
        console.log(`[RETRY] Re-queued ${jobType} for ${slide.id.substring(0, 12)}`);
      }
    }
  } catch (err) {
    console.error(`[RETRY] Failed to retry jobs: ${err.message}`);
  }
}

async function worker() {
  console.log('SuperNavi Processor Worker starting...');
  console.log(`Version: ${PKG_VERSION} — review gate ACTIVE (SlideRegistered only for confirmed/legacy slides)`);
  console.log(`WSI formats (OpenSlide): ${WSI_FORMATS.join(', ')}`);
  console.log(`Pipeline mode: ${PIPELINE_MODE}`);
  if (PIPELINE_MODE === 'bigtiff_iiif') {
    console.log(`Post-P0: pyramidal BigTIFF → S3 multipart upload (BIGTIFF job)`);
  } else {
    console.log(`Post-P0: full pyramid via vips dzsave (TILEGEN job)`);
  }

  // Wait for Redis
  let retries = 10;
  while (retries > 0) {
    try {
      await getRedis();
      break;
    } catch (err) {
      retries--;
      console.log(`Redis not ready, retrying... (${retries} left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Wait for PostgreSQL before doing any DB operations
  await waitForDatabase();

  // Reset any jobs left in 'running' from a previous crash/restart
  await resetOrphanedJobs();

  // Retry any previously failed TILEGEN jobs
  await retryFailedTilegen();

  // Log parallel capacity
  const { slots: initialSlots, freeGB, cpuCores } = calculateParallelSlots();
  console.log(`Parallel BigTIFF: ${initialSlots} slots (${freeGB.toFixed(1)} GB free, ${cpuCores} CPU cores)`);

  console.log('Worker ready, waiting for jobs...');

  const client = await getRedis();

  while (true) {
    try {
      // Blocking pop from queue (timeout 5s)
      const result = await client.brPop('jobs:pending', 5);

      if (!result) continue;

      const job = JSON.parse(result.element);

      // BIGTIFF jobs run in parallel (up to calculated slots)
      if (job.type === 'BIGTIFF') {
        const { slots } = calculateParallelSlots();

        if (activeBigtiffJobs.size >= slots) {
          // All slots full — wait for any one to finish before starting
          console.log(`[BIGTIFF] ${activeBigtiffJobs.size}/${slots} slots busy, waiting...`);
          await Promise.race([...activeBigtiffJobs]);
        }

        const jobPromise = processJob(job)
          .finally(() => activeBigtiffJobs.delete(jobPromise));
        activeBigtiffJobs.add(jobPromise);

        console.log(`[BIGTIFF] ${activeBigtiffJobs.size}/${slots} slots active`);
      } else {
        // P0, P1, TILEGEN, CLEANUP — run sequentially
        await processJob(job);
      }
    } catch (err) {
      console.error('Worker error:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Graceful shutdown with timeout (Docker sends SIGKILL after 10s by default)
process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Worker received SIGTERM');
  if (activeBigtiffJobs.size > 0) {
    console.log(`[SHUTDOWN] Waiting up to 7s for ${activeBigtiffJobs.size} active BigTIFF job(s)...`);
    const timeout = new Promise(r => setTimeout(r, 7000));
    await Promise.race([Promise.allSettled([...activeBigtiffJobs]), timeout]);
  }
  // Mark any still-running jobs as failed so they get retried on next startup
  try {
    const result = await getPool().query(
      `UPDATE jobs SET status = 'failed', error = 'interrupted: worker shutdown', updated_at = NOW()
       WHERE status = 'running'
       RETURNING id, type, slide_id`
    );
    if (result.rowCount > 0) {
      for (const job of result.rows) {
        console.log(`[SHUTDOWN] Marked ${job.type} job ${job.id} as failed (slide ${job.slide_id.substring(0, 12)})`);
      }
    }
  } catch (err) {
    console.error(`[SHUTDOWN] Failed to mark jobs: ${err.message}`);
  }
  if (redis) await redis.quit();
  if (pool) await pool.end();
  await shutdownPreview();
  process.exit(0);
});

worker();
