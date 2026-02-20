import { createReadStream, createWriteStream } from 'fs';
import { access, readFile, readdir, mkdir, rm } from 'fs/promises';
import { join, extname } from 'path';
import { pipeline } from 'stream/promises';
import { listSlides, listUnlinkedSlides, getSlide, updateLevelReadyMax, findSlideByFilename, deleteSlide } from '../db/slides.js';
import { findCaseByExternalRef, createCase, linkSlideToCase } from '../db/collaboration.js';
import { query } from '../db/index.js';
import { generateTile, getPendingCount } from '../services/tilegen-svs.js';
import { enqueueJob } from '../lib/queue.js';

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
        createdAt: s.created_at
      }))
    };
  });

  // List slides not linked to any case
  fastify.get('/slides/unlinked', async () => {
    const slides = await listUnlinkedSlides();
    return {
      slides: slides.map(s => ({
        slideId: s.id,
        filename: s.original_filename,
        width: s.width || 0,
        height: s.height || 0,
        status: s.status,
        createdAt: s.created_at
      }))
    };
  });

  // Link a slide to a case by external reference (AP number), auto-creating the case if needed
  fastify.post('/slides/:slideId/link-to-case', {
    schema: {
      body: {
        type: 'object',
        required: ['caseBase'],
        properties: {
          caseBase: { type: 'string', minLength: 1 },
          patientName: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { slideId } = request.params;
    const { caseBase, patientName } = request.body;

    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const normalizedBase = caseBase.toUpperCase();

    // Find or create case
    let caseRecord = await findCaseByExternalRef(normalizedBase);
    if (!caseRecord) {
      const title = patientName || normalizedBase;
      caseRecord = await createCase({ title, externalRef: normalizedBase });
      // createCase returns a flat row, wrap slides
      caseRecord = { ...caseRecord, slides: [] };
    }

    // Link slide to case
    await linkSlideToCase(caseRecord.case_id, slideId);

    // Update slide external fields
    await query(
      `UPDATE slides SET external_case_base = $1, external_case_id = $2 WHERE id = $3`,
      [normalizedBase, `pathoweb:${normalizedBase}`, slideId]
    );

    return {
      ok: true,
      caseId: caseRecord.case_id,
      slideId,
      caseBase: normalizedBase
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

    // Validate extension
    const ext = extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      reply.code(400);
      return { error: `Unsupported file format: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}` };
    }

    // Ensure inbox directory exists
    await mkdir(INGEST_DIR, { recursive: true });

    // Write file to inbox
    const inboxPath = join(INGEST_DIR, filename);
    try {
      // request.body is the raw stream (from content type parser)
      await pipeline(request.body, createWriteStream(inboxPath));
      console.log(`Received upload: ${filename} -> ${inboxPath}`);

      return {
        success: true,
        filename,
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
