import { createClient } from 'redis';
import pg from 'pg';
import { stat } from 'fs/promises';
import { processP0 as processImageP0 } from './pipeline-p0.js';
import { processP1 as processImageP1 } from './pipeline-p1.js';
import { processSVS_P0, processSVS_P1, generateFullTilePyramid, persistTilesBackground } from './pipeline-svs.js';
import { publishRemotePreview, isPreviewEnabled, shutdown as shutdownPreview } from './preview/index.js';
import { deleteSlidePreview } from './preview/wasabiUploader.js';
import { uploadSlideToCloud } from './cloud-uploader.js';

const { Pool } = pg;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL || 'postgres://supernavi:supernavi@localhost:5432/supernavi';

let redis = null;
let pool = null;

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
      return;
    }
  }

  await updateJob(job.jobId, { status: 'running' });
  await updateSlide(job.slideId, { status: 'processing' });

  try {
    if (job.type === 'P0') {
      const result = await processP0(job);

      // Update slide with metadata
      const slideUpdate = {
        width: result.width,
        height: result.height,
        max_level: result.maxLevel,
        level_ready_max: result.levelReadyMax,
        thumb_path: result.thumbPath,
        manifest_path: result.manifestPath,
        status: 'ready'
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

      // Publish slide:ready event for SSE subscribers
      await publishEvent('slide:ready', {
        slideId: job.slideId,
        width: result.width,
        height: result.height,
        maxLevel: result.maxLevel,
        timestamp: Date.now()
      });

      // Enqueue P1 job for remaining levels (only for image formats)
      // WSI formats generate all levels at once with vips dzsave
      if (!isWSIFormat(format) && result.maxLevel > result.p0MaxLevel) {
        const p1JobId = await createJob(job.slideId, 'P1');
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

      console.log(`P0 complete for ${job.slideId.substring(0, 12)}: ${result.width}x${result.height}, maxLevel=${result.maxLevel}`);

      // NOTE: SlideRegistered outbox event is emitted after TILEGEN completes,
      // so the slide only appears in the extension when fully navigable.

      // Enqueue TILEGEN job for full tile pyramid generation
      if (isWSIFormat(format)) {
        try {
          const tilegenJobId = await createJob(job.slideId, 'TILEGEN');
          await updateSlide(job.slideId, { tilegen_status: 'queued' });
          await enqueueJob({
            jobId: tilegenJobId,
            slideId: job.slideId,
            type: 'TILEGEN',
            rawPath: job.rawPath,
            format: format,
            maxLevel: result.maxLevel
          });
          console.log(`Enqueued TILEGEN job for ${job.slideId.substring(0, 12)}`);
        } catch (tilegenErr) {
          console.error(`Failed to enqueue TILEGEN (non-fatal): ${tilegenErr.message}`);
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
        }
      }
    } else if (job.type === 'P1') {
      const result = await processP1(job);
      await updateSlide(job.slideId, { level_ready_max: result.levelReadyMax });
      await updateJob(job.jobId, { status: 'done' });
      console.log(`P1 complete for ${job.slideId.substring(0, 12)}, levelReadyMax=${result.levelReadyMax}`);
    } else if (job.type === 'CLEANUP') {
      // Delete preview from Wasabi S3
      console.log(`Cleaning up Wasabi preview for ${job.slideId.substring(0, 12)}...`);
      try {
        const result = await deleteSlidePreview(job.slideId);
        console.log(`Cleanup complete: ${result.deleted} objects deleted, ${result.errors} errors`);
        await publishEvent('cleanup:complete', {
          slideId: job.slideId,
          deleted: result.deleted,
          errors: result.errors,
          timestamp: Date.now()
        });
      } catch (cleanupErr) {
        console.error(`Cleanup failed: ${cleanupErr.message}`);
        await publishEvent('cleanup:failed', {
          slideId: job.slideId,
          error: cleanupErr.message,
          timestamp: Date.now()
        });
      }
      // Note: CLEANUP jobs don't have a database job record
    } else if (job.type === 'TILEGEN') {
      // Full tile pyramid generation using vips dzsave
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

        // Background: persist hot tiles to bind-mount storage (non-blocking)
        persistTilesBackground(job.slideId).catch(err => {
          console.error(`[PERSIST] Failed for ${job.slideId.substring(0, 12)}: ${err.message}`);
        });

        // Emit SlideRegistered outbox event now that tiles are fully ready
        try {
          const slideRow = await getPool().query(
            'SELECT external_case_id, external_case_base, external_slide_label, original_filename, width, height, mpp FROM slides WHERE id = $1',
            [job.slideId]
          );
          const slide = slideRow.rows[0];
          if (slide) {
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
              })]
            );
            console.log(`SlideRegistered event emitted for ${job.slideId.substring(0, 12)} (after TILEGEN)`);
          }
        } catch (outboxErr) {
          console.error(`Failed to emit SlideRegistered event (non-fatal): ${outboxErr.message}`);
        }

        // Cloud upload: send full tile pyramid to Wasabi and notify cloud
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
            }
          } catch (uploadErr) {
            await updateSlide(job.slideId, { cloud_upload_status: 'failed' }).catch(() => {});
            await publishEvent('cloud:failed', {
              slideId: job.slideId,
              error: uploadErr.message,
              timestamp: Date.now(),
            }).catch(() => {});
            console.error(`[UPLOAD] Failed for ${job.slideId.substring(0, 12)} (non-fatal): ${uploadErr.message}`);
          }
        }
      } catch (tilegenErr) {
        console.error(`TILEGEN failed for ${job.slideId.substring(0, 12)}: ${tilegenErr.message}`);
        await updateSlide(job.slideId, { tilegen_status: 'failed' });
        await updateJob(job.jobId, { status: 'failed', error: tilegenErr.message });
      }
    }
  } catch (err) {
    console.error(`Job failed: ${err.message}`);
    console.error(err.stack);
    await updateJob(job.jobId, { status: 'failed', error: err.message });
    await updateSlide(job.slideId, { status: 'failed' });
  }
}

async function worker() {
  console.log('SuperNavi Processor Worker starting...');
  console.log(`WSI formats (OpenSlide): ${WSI_FORMATS.join(', ')}`);
  console.log(`Tile generation: full pyramid via vips dzsave (TILEGEN job)`);

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

  console.log('Worker ready, waiting for jobs...');

  const client = await getRedis();

  while (true) {
    try {
      // Blocking pop from queue (timeout 5s)
      const result = await client.brPop('jobs:pending', 5);

      if (result) {
        const job = JSON.parse(result.element);
        await processJob(job);
      }
    } catch (err) {
      console.error('Worker error:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down worker...');
  if (redis) await redis.quit();
  if (pool) await pool.end();
  await shutdownPreview();
  process.exit(0);
});

worker();
