import { createReadStream } from 'fs';
import { access, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { listSlides, getSlide, updateLevelReadyMax } from '../db/slides.js';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

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
        format: s.format || 'unknown'
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

  // Get tile
  fastify.get('/slides/:slideId/tiles/:z/:x/:y.jpg', async (request, reply) => {
    const { slideId, z, x, y } = request.params;
    const tilePath = join(DERIVED_DIR, slideId, 'tiles', z, `${x}_${y}.jpg`);

    try {
      await access(tilePath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return createReadStream(tilePath);
    } catch {
      reply.code(404);
      return { error: 'Tile not found' };
    }
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

    // Get cached levelReadyMax from DB
    let levelReadyMax = slide.level_ready_max || 0;

    // If status is ready and levelReadyMax is 0, scan disk and update cache
    if (slide.status === 'ready' && levelReadyMax === 0) {
      levelReadyMax = await scanLevelReadyMax(slideId);
      if (levelReadyMax > 0) {
        await updateLevelReadyMax(slideId, levelReadyMax);
      }
    }

    // Count tiles on disk
    const tilesComplete = await countTilesOnDisk(slideId);

    return {
      slideId: slide.id,
      levelMax: slide.max_level || 0,
      levelReadyMax,
      tilesComplete
    };
  });
}
