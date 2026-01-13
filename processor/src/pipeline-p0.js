import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILE_SIZE = 256;
const P0_MAX_LEVEL = 4; // P0 generates levels 0-4 (quick preview)
const TILE_QUALITY = 85;
const CONCURRENCY = 4;

function calculateMaxLevel(width, height) {
  const maxDim = Math.max(width, height);
  return Math.ceil(Math.log2(maxDim / TILE_SIZE));
}

function calculateLevelDimensions(width, height, level, maxLevel) {
  const scale = Math.pow(2, maxLevel - level);
  return {
    width: Math.ceil(width / scale),
    height: Math.ceil(height / scale)
  };
}

async function generateTilesForLevel(image, slideId, level, levelWidth, levelHeight) {
  const tilesX = Math.ceil(levelWidth / TILE_SIZE);
  const tilesY = Math.ceil(levelHeight / TILE_SIZE);
  const tilesDir = join(DERIVED_DIR, slideId, 'tiles', String(level));

  await mkdir(tilesDir, { recursive: true });

  const tasks = [];

  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      tasks.push({ x, y });
    }
  }

  // Process tiles with controlled concurrency
  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ({ x, y }) => {
        const left = x * TILE_SIZE;
        const top = y * TILE_SIZE;
        const width = Math.min(TILE_SIZE, levelWidth - left);
        const height = Math.min(TILE_SIZE, levelHeight - top);

        const tilePath = join(tilesDir, `${x}_${y}.jpg`);

        await image
          .clone()
          .resize(levelWidth, levelHeight, { fit: 'fill' })
          .extract({ left, top, width, height })
          .jpeg({ quality: TILE_QUALITY })
          .toFile(tilePath);

        return tilePath;
      })
    );
    results.push(...batchResults);
  }

  return { tilesX, tilesY, count: results.length };
}

export async function processP0(job) {
  const { slideId, rawPath } = job;
  const slideDir = join(DERIVED_DIR, slideId);

  await mkdir(slideDir, { recursive: true });

  // Load image and get metadata
  const image = sharp(rawPath);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  console.log(`Image: ${width}x${height}`);

  const maxLevel = calculateMaxLevel(width, height);
  const p0MaxLevel = Math.min(P0_MAX_LEVEL, maxLevel);

  // Generate thumbnail
  const thumbPath = join(slideDir, 'thumb.jpg');
  await image
    .clone()
    .resize(256, 256, { fit: 'inside' })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);

  console.log(`Generated thumbnail: ${thumbPath}`);

  // Generate tiles for P0 levels (0 to p0MaxLevel)
  for (let level = 0; level <= p0MaxLevel; level++) {
    const { width: levelWidth, height: levelHeight } = calculateLevelDimensions(
      width,
      height,
      level,
      maxLevel
    );

    console.log(`Generating level ${level}: ${levelWidth}x${levelHeight}`);

    const result = await generateTilesForLevel(
      image,
      slideId,
      level,
      levelWidth,
      levelHeight
    );

    console.log(`Level ${level}: ${result.count} tiles (${result.tilesX}x${result.tilesY})`);
  }

  // Generate manifest
  const manifest = {
    protocol: 'dzi',
    tileSize: TILE_SIZE,
    overlap: 0,
    format: 'jpg',
    width,
    height,
    levelMin: 0,
    levelMax: maxLevel,
    tilePathPattern: 'tiles/{z}/{x}_{y}.jpg',
    tileUrlTemplate: `/v1/slides/${slideId}/tiles/{z}/{x}/{y}.jpg`
  };

  const manifestPath = join(slideDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Generated manifest: ${manifestPath}`);

  return {
    width,
    height,
    maxLevel,
    p0MaxLevel,
    levelReadyMax: p0MaxLevel,
    thumbPath,
    manifestPath
  };
}
