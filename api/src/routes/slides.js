import { createReadStream, createWriteStream } from 'fs';
import { access, readFile, readdir, mkdir, rm } from 'fs/promises';
import { join, extname, basename } from 'path';
import { pipeline } from 'stream/promises';
import { listSlides, getSlide, updateLevelReadyMax, findSlideByFilename, deleteSlide, updateSlideOcr, createJob } from '../db/slides.js';
import { generateTile, getPendingCount } from '../services/tilegen-svs.js';
import { enqueueJob } from '../lib/queue.js';
import { query } from '../db/index.js';
import { ocrLabel, isOcrEnabled, parseOcrResponse } from '../lib/label-ocr.js';
import { stat } from 'fs/promises';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILES_HOT_DIR = process.env.TILES_HOT_DIR || '/data/tiles_hot';
const INGEST_DIR = process.env.INGEST_DIR || '/data/inbox';
const RAW_DIR = process.env.RAW_DIR || '/data/raw';

// Supported upload formats
const SUPPORTED_EXTENSIONS = ['.svs', '.tif', '.tiff', '.ndpi', '.mrxs', '.jpg', '.jpeg', '.png'];

// WSI formats that use on-demand tile generation
const WSI_FORMATS = ['svs', 'tiff', 'ndpi', 'mrxs'];

/**
 * Check if format is a WSI format (on-demand tiles)
 */
function isWSIFormat(format) {
  return WSI_FORMATS.includes(format?.toLowerCase());
}

/**
 * Calculate levelReadyMax from disk by scanning tiles directory
 * Returns the highest level number that has tiles
 */
async function scanLevelReadyMax(slideId) {
  const tilesDir = join(DERIVED_DIR, slideId, 'tiles');
  try {
    const entries = await readdir(tilesDir);
    const levels = entries
      .filter(e => /^\d+$/.test(e))
      .map(e => parseInt(e, 10));
    return levels.length > 0 ? Math.max(...levels) : 0;
  } catch {
    return 0;
  }
}

/**
 * Count total tiles on disk for a slide
 */
async function countTilesOnDisk(slideId) {
  const tilesDir = join(DERIVED_DIR, slideId, 'tiles');
  let total = 0;
  try {
    const levels = await readdir(tilesDir);
    for (const level of levels) {
      if (/^\d+$/.test(level)) {
        const tiles = await readdir(join(tilesDir, level));
        total += tiles.filter(t => t.endsWith('.jpg')).length;
      }
    }
  } catch {}
  return total;
}

export default async function slidesRoutes(fastify) {
  // List all slides
  fastify.get('/slides', async () => {
    const slides = await listSlides();
    return {
      items: slides.map(s => ({
        slideId: s.id,
        originalFilename: s.original_filename,
        status: s.status,
        width: s.width || 0,
        height: s.height || 0,
        maxLevel: s.max_level || 0,
        levelMax: s.max_level || 0,
        levelReadyMax: s.level_ready_max || 0,
        format: s.format || 'unknown',
        onDemand: isWSIFormat(s.format),
        appMag: s.app_mag || null,    // Native scan magnification
        mpp: s.mpp || null,            // Microns per pixel
        createdAt: s.created_at,
        ocrStatus: s.ocr_status || null,
        externalCaseBase: s.external_case_base || null,
        externalSlideLabel: s.external_slide_label || null,
        hasLabel: !!s.dsmeta_path,
        hasRawFile: !!s.raw_path,
        pipelineMode: s.pipeline_mode || null,
        tilegenStatus: s.tilegen_status || null
      }))
    };
  });

  // Get slide status by filename (for tracking upload progress)
  fastify.get('/slides/by-filename/:filename', async (request, reply) => {
    const { filename } = request.params;
    const slide = await findSlideByFilename(filename);

    if (!slide) {
      return {
        found: false,
        status: 'uploading',
        message: 'Aguardando processamento...',
        previewPublished: false
      };
    }

    // Check if preview has been published (marker file exists with status 'complete')
    let previewPublished = false;
    try {
      const markerPath = join(DERIVED_DIR, slide.id, 'preview_published.json');
      const markerContent = await readFile(markerPath, 'utf8');
      const marker = JSON.parse(markerContent);
      previewPublished = marker.status === 'complete';
    } catch {
      // Marker doesn't exist or is invalid
      previewPublished = false;
    }

    // Determine processing stage
    let stage = 'queued';
    let message = 'Na fila de processamento...';
    let progress = 10;

    if (slide.status === 'processing') {
      stage = 'processing';
      message = 'Extraindo metadados e gerando thumbnail...';
      progress = 50;
    } else if (slide.status === 'ready') {
      if (previewPublished) {
        stage = 'ready';
        message = 'Pronto para visualização!';
        progress = 100;
      } else {
        // Slide is ready but preview not yet published
        stage = 'publishing';
        message = 'Publicando preview remoto...';
        progress = 80;
      }
    } else if (slide.status === 'failed') {
      stage = 'failed';
      message = 'Erro no processamento';
      progress = 0;
    }

    return {
      found: true,
      slideId: slide.id,
      originalFilename: slide.original_filename,
      status: slide.status,
      stage,
      message,
      progress,
      width: slide.width || 0,
      height: slide.height || 0,
      format: slide.format,
      previewPublished
    };
  });

  // Upload slide to inbox (watcher will process it)
  fastify.post('/slides/upload', async (request, reply) => {
    // Get filename from header
    const filename = request.headers['x-filename'];
    if (!filename) {
      reply.code(400);
      return { error: 'Missing X-Filename header' };
    }

    // Sanitize filename to prevent path traversal
    const safeFilename = basename(filename);

    // Validate extension
    const ext = extname(safeFilename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      reply.code(400);
      return { error: `Unsupported file format: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}` };
    }

    // Ensure inbox directory exists
    await mkdir(INGEST_DIR, { recursive: true });

    // Write file to inbox
    const inboxPath = join(INGEST_DIR, safeFilename);
    try {
      // request.body is the raw stream (from content type parser)
      await pipeline(request.body, createWriteStream(inboxPath));
      console.log(`Received upload: ${safeFilename} -> ${inboxPath}`);

      return {
        success: true,
        filename: safeFilename,
        message: 'File received, processing will start shortly'
      };
    } catch (err) {
      console.error(`Upload failed for ${filename}:`, err.message);
      reply.code(500);
      return { error: 'Failed to save uploaded file' };
    }
  });

  // Get slide manifest
  fastify.get('/slides/:slideId/manifest', async (request, reply) => {
    const { slideId } = request.params;
    const manifestPath = join(DERIVED_DIR, slideId, 'manifest.json');

    try {
      await access(manifestPath);
      const manifest = await readFile(manifestPath, 'utf8');
      reply.header('Content-Type', 'application/json');
      reply.header('Cache-Control', 'public, max-age=3600');
      return manifest;
    } catch {
      reply.code(404);
      return { error: 'Manifest not found' };
    }
  });

  // Get slide thumbnail
  fastify.get('/slides/:slideId/thumb', async (request, reply) => {
    const { slideId } = request.params;
    const thumbPath = join(DERIVED_DIR, slideId, 'thumb.jpg');

    try {
      await access(thumbPath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=86400');
      return createReadStream(thumbPath);
    } catch {
      reply.code(404);
      return { error: 'Thumbnail not found' };
    }
  });

  // Get tile (with on-demand generation for WSI formats)
  fastify.get('/slides/:slideId/tiles/:z/:x/:y.jpg', async (request, reply) => {
    const { slideId, z, x, y } = request.params;
    const hotTilePath = join(TILES_HOT_DIR, slideId, 'tiles', z, `${x}_${y}.jpg`);
    const tilePath = join(DERIVED_DIR, slideId, 'tiles', z, `${x}_${y}.jpg`);

    // Check hot tiles first (tmpfs, RAM-backed, fastest)
    try {
      await access(hotTilePath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return createReadStream(hotTilePath);
    } catch {
      // Not in hot cache
    }

    // Check persistent tiles (bind mount)
    try {
      await access(tilePath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return createReadStream(tilePath);
    } catch {
      // Tile doesn't exist - check if WSI format for on-demand generation
    }

    // Get slide info to check format
    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return reply.send();
    }

    // Only generate on-demand for WSI formats
    if (!isWSIFormat(slide.format)) {
      reply.code(404);
      return reply.send();
    }

    // Generate tile on-demand
    try {
      const result = await generateTile(slideId, parseInt(z), parseInt(x), parseInt(y));

      if (result.exists || result.generated) {
        reply.header('Content-Type', 'image/jpeg');
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        return createReadStream(result.path);
      }
    } catch (err) {
      console.error(`Tile generation failed: ${slideId}/${z}/${x}/${y}`, err.message);
      reply.code(404);
      return reply.send();
    }

    reply.code(404);
    return reply.send();
  });

  // Get slide info
  fastify.get('/slides/:slideId', async (request, reply) => {
    const { slideId } = request.params;
    const slide = await getSlide(slideId);

    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    return {
      slideId: slide.id,
      originalFilename: slide.original_filename,
      status: slide.status,
      format: slide.format,
      width: slide.width,
      height: slide.height,
      maxLevel: slide.max_level,
      levelMax: slide.max_level,
      levelReadyMax: slide.level_ready_max || 0,
      tileSize: slide.tile_size,
      onDemand: isWSIFormat(slide.format),
      createdAt: slide.created_at
    };
  });

  // Get slide availability (tile readiness info)
  fastify.get('/slides/:slideId/availability', async (request, reply) => {
    const { slideId } = request.params;
    const slide = await getSlide(slideId);

    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const isOnDemand = isWSIFormat(slide.format);

    // Get cached levelReadyMax from DB
    let levelReadyMax = slide.level_ready_max || 0;

    // For pre-generated slides, scan disk if needed
    if (!isOnDemand && slide.status === 'ready' && levelReadyMax === 0) {
      levelReadyMax = await scanLevelReadyMax(slideId);
      if (levelReadyMax > 0) {
        await updateLevelReadyMax(slideId, levelReadyMax);
      }
    }

    // For on-demand slides, always scan disk for actual state
    if (isOnDemand) {
      levelReadyMax = await scanLevelReadyMax(slideId);
    }

    // Count tiles on disk
    const tilesOnDisk = await countTilesOnDisk(slideId);

    // tilesComplete is true for pre-generated slides, false for on-demand
    const tilesComplete = !isOnDemand;

    return {
      slideId: slide.id,
      levelMax: slide.max_level || 0,
      levelReadyMax,
      tilesOnDisk,
      tilesComplete,
      onDemand: isOnDemand,
      pendingGenerations: isOnDemand ? getPendingCount() : 0
    };
  });

  // Get slide label image (from dsmeta directory)
  fastify.get('/slides/:slideId/label', async (request, reply) => {
    const { slideId } = request.params;
    const slide = await getSlide(slideId);

    if (!slide || !slide.dsmeta_path) {
      reply.code(404);
      return { error: 'Label not found' };
    }

    const labelPath = join(slide.dsmeta_path, 'label.jpg');

    try {
      await access(labelPath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'no-cache');
      return createReadStream(labelPath);
    } catch {
      reply.code(404);
      return { error: 'Label image not found' };
    }
  });

  // Get slide2 overview image (from dsmeta directory)
  fastify.get('/slides/:slideId/slide2', async (request, reply) => {
    const { slideId } = request.params;
    const slide = await getSlide(slideId);

    if (!slide || !slide.dsmeta_path) {
      reply.code(404);
      return { error: 'Slide2 not found' };
    }

    const slide2Path = join(slide.dsmeta_path, 'slide2.jpg');

    try {
      await access(slide2Path);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'no-cache');
      return createReadStream(slide2Path);
    } catch {
      reply.code(404);
      return { error: 'Slide2 image not found' };
    }
  });

  // Trigger re-OCR for a slide's label
  fastify.post('/slides/:slideId/reocr', async (request, reply) => {
    const { slideId } = request.params;
    const slide = await getSlide(slideId);

    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    if (!slide.dsmeta_path) {
      reply.code(400);
      return { error: 'No dsmeta directory for this slide' };
    }

    if (!isOcrEnabled()) {
      reply.code(400);
      return { error: 'OCR is not enabled (ANTHROPIC_API_KEY not set)' };
    }

    try {
      await access(slide.dsmeta_path);
    } catch {
      reply.code(404);
      return { error: 'dsmeta directory not found' };
    }

    // Run OCR
    const ocrResult = await ocrLabel(slide.dsmeta_path);

    if (!ocrResult) {
      await updateSlideOcr(slideId, { ocrStatus: 'pending' });
      return {
        success: false,
        message: 'OCR could not read the label',
        ocrStatus: 'pending'
      };
    }

    const format = slide.format || 'svs';
    const newFilename = ocrResult.fullName + '.' + format;

    // Update slide DB
    await updateSlideOcr(slideId, {
      originalFilename: newFilename,
      externalCaseId: `pathoweb:${ocrResult.caseBase}`,
      externalCaseBase: ocrResult.caseBase,
      externalSlideLabel: ocrResult.fullName,
      ocrStatus: 'done',
    });

    // Re-emit SlideRegistered outbox event if tilegen is done
    const slideRow = await query(
      'SELECT width, height, mpp, tilegen_status, external_case_id, external_case_base, external_slide_label FROM slides WHERE id = $1',
      [slideId]
    );
    const s = slideRow.rows[0];
    if (s && s.tilegen_status === 'done') {
      await query(
        `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
         VALUES ($1, $2, $3, $4)`,
        ['slide', slideId, 'registered', JSON.stringify({
          slide_id: slideId,
          case_id: null,
          svs_filename: newFilename,
          width: s.width || 0,
          height: s.height || 0,
          mpp: parseFloat(s.mpp) || 0,
          external_case_id: s.external_case_id,
          external_case_base: s.external_case_base,
          external_slide_label: s.external_slide_label,
        })]
      );
    }

    return {
      success: true,
      ocrStatus: 'done',
      fullName: ocrResult.fullName,
      caseBase: ocrResult.caseBase,
      slideLabel: ocrResult.slideLabel,
      newFilename,
    };
  });

  // Manual rename: technician manually sets the slide name
  fastify.post('/slides/:slideId/rename', async (request, reply) => {
    const { name } = request.body || {};

    if (!name || typeof name !== 'string') {
      reply.code(400);
      return { error: 'Missing or invalid "name" field' };
    }

    const { slideId } = request.params;
    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const parsed = parseOcrResponse(name.trim());
    if (!parsed) {
      reply.code(400);
      return { error: 'Invalid format. Expected: AP26000388A1, C26000588A, 26_388A, etc.' };
    }

    const format = slide.format || 'svs';
    const newFilename = parsed.fullName + '.' + format;

    await updateSlideOcr(slideId, {
      originalFilename: newFilename,
      externalCaseId: `pathoweb:${parsed.caseBase}`,
      externalCaseBase: parsed.caseBase,
      externalSlideLabel: parsed.fullName,
      ocrStatus: 'done',
    });

    // Re-emit SlideRegistered outbox event if tilegen is done
    const slideRow = await query(
      'SELECT width, height, mpp, tilegen_status, external_case_id, external_case_base, external_slide_label FROM slides WHERE id = $1',
      [slideId]
    );
    const s = slideRow.rows[0];
    if (s && s.tilegen_status === 'done') {
      await query(
        `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
         VALUES ($1, $2, $3, $4)`,
        ['slide', slideId, 'registered', JSON.stringify({
          slide_id: slideId,
          case_id: null,
          svs_filename: newFilename,
          width: s.width || 0,
          height: s.height || 0,
          mpp: parseFloat(s.mpp) || 0,
          external_case_id: s.external_case_id,
          external_case_base: s.external_case_base,
          external_slide_label: s.external_slide_label,
        })]
      );
    }

    return {
      success: true,
      ocrStatus: 'done',
      fullName: parsed.fullName,
      caseBase: parsed.caseBase,
      slideLabel: parsed.slideLabel,
      newFilename,
    };
  });

  // Re-process a slide (re-trigger BigTIFF generation + upload)
  fastify.post('/slides/:slideId/reprocess', async (request, reply) => {
    const { slideId } = request.params;
    const slide = await getSlide(slideId);

    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    // Check if raw file still exists
    if (!slide.raw_path) {
      reply.code(400);
      return { error: 'No raw file path recorded for this slide' };
    }

    try {
      await stat(slide.raw_path);
    } catch {
      reply.code(400);
      return { error: 'Raw file no longer exists on disk', rawPath: slide.raw_path };
    }

    // Don't re-process if already running
    const activeJob = await query(
      `SELECT id FROM jobs WHERE slide_id = $1 AND type IN ('BIGTIFF', 'TILEGEN') AND status IN ('queued', 'running') LIMIT 1`,
      [slideId]
    );
    if (activeJob.rows.length > 0) {
      reply.code(409);
      return { error: 'A processing job is already active for this slide' };
    }

    // Determine pipeline mode
    const pipelineMode = slide.pipeline_mode || process.env.EDGE_PIPELINE_MODE || 'legacy_dzi';
    const jobType = pipelineMode === 'bigtiff_iiif' ? 'BIGTIFF' : 'TILEGEN';

    // Reset slide status
    await query(
      `UPDATE slides SET status = 'processing', tilegen_status = 'queued', pipeline_mode = $1 WHERE id = $2`,
      [pipelineMode, slideId]
    );

    // Create and enqueue the job
    const job = await createJob({ slideId, type: jobType });
    if (!job) {
      reply.code(500);
      return { error: 'Failed to create processing job' };
    }

    await enqueueJob({
      jobId: job.id,
      slideId,
      type: jobType,
      rawPath: slide.raw_path,
      format: slide.format,
      maxLevel: slide.max_level,
    });

    console.log(`[REPROCESS] Queued ${jobType} for ${slideId.substring(0, 12)} (${slide.original_filename})`);

    return {
      success: true,
      slideId,
      jobType,
      pipelineMode,
      message: `Re-processing queued (${jobType})`,
    };
  });

  // Delete a slide (local files + database + queue Wasabi cleanup)
  fastify.delete('/slides/:slideId', async (request, reply) => {
    const { slideId } = request.params;

    // Delete from database first
    const result = await deleteSlide(slideId);

    if (!result.deleted) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const slide = result.slide;
    console.log(`Deleting slide ${slideId.substring(0, 12)} (${slide.original_filename})`);

    // Delete local files (async, non-blocking)
    const deleteLocal = async () => {
      try {
        // Delete derived files (tiles, manifest, thumb)
        const derivedPath = join(DERIVED_DIR, slideId);
        await rm(derivedPath, { recursive: true, force: true });
        console.log(`Deleted derived files: ${derivedPath}`);

        // Delete raw file if exists
        if (slide.raw_path) {
          await rm(slide.raw_path, { force: true });
          console.log(`Deleted raw file: ${slide.raw_path}`);
        }
      } catch (err) {
        console.error(`Error deleting local files for ${slideId}:`, err.message);
      }
    };

    // Queue Wasabi cleanup job (async, non-blocking)
    const queueCleanup = async () => {
      try {
        await enqueueJob({
          type: 'CLEANUP',
          slideId: slideId
        });
        console.log(`Queued Wasabi cleanup for ${slideId.substring(0, 12)}`);
      } catch (err) {
        console.error(`Error queuing cleanup for ${slideId}:`, err.message);
      }
    };

    // Run both cleanup tasks in parallel (don't wait)
    Promise.all([deleteLocal(), queueCleanup()]).catch(err => {
      console.error(`Cleanup error for ${slideId}:`, err.message);
    });

    return {
      success: true,
      slideId,
      message: 'Slide deleted, cleanup in progress'
    };
  });
}
