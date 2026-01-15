import { createReadStream } from 'fs';
import { access, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { listSlides, getSlide, updateLevelReadyMax } from '../db/slides.js';
import { generateTile, isTilePending, getPendingCount } from '../services/tilegen-svs.js';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

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
        status: s.status,
        width: s.width || 0,
        height: s.height || 0,
        maxLevel: s.max_level || 0,
        levelMax: s.max_level || 0,
        levelReadyMax: s.level_ready_max || 0,
        format: s.format || 'unknown',
        onDemand: isWSIFormat(s.format)
      }))
    };
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
    const tilePath = join(DERIVED_DIR, slideId, 'tiles', z, `${x}_${y}.jpg`);

    // Check if tile exists on disk (fast path)
    try {
      await access(tilePath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return createReadStream(tilePath);
    } catch {
      // Tile doesn't exist - check if WSI format for on-demand generation
    }

    // Check if tile is already being generated (return 503 immediately)
    if (isTilePending(slideId, z, x, y)) {
      reply.code(503);
      reply.header('Retry-After', '1');
      return reply.send();
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
      // Check if generation is still pending (concurrent request started it)
      if (isTilePending(slideId, z, x, y)) {
        reply.code(503);
        reply.header('Retry-After', '1');
        return reply.send();
      }

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
}
