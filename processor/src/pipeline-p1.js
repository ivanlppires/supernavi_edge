import sharp from 'sharp';
import { mkdir, readFile } from 'fs/promises';
import { join } from 'path';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILE_SIZE = 256;
const TILE_QUALITY = 85;
const CONCURRENCY = 4;

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
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(
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
      })
    );
  }

  return { tilesX, tilesY };
}

export async function processP1(job) {
  const { slideId, rawPath, startLevel, maxLevel } = job;

  // Load manifest to get dimensions
  const manifestPath = join(DERIVED_DIR, slideId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const { width, height } = manifest;

  // Load image
  const image = sharp(rawPath);

  // Generate tiles for remaining levels
  for (let level = startLevel; level <= maxLevel; level++) {
    const { width: levelWidth, height: levelHeight } = calculateLevelDimensions(
      width,
      height,
      level,
      maxLevel
    );

    console.log(`P1: Generating level ${level}: ${levelWidth}x${levelHeight}`);

    const result = await generateTilesForLevel(
      image,
      slideId,
      level,
      levelWidth,
      levelHeight
    );

    console.log(`P1: Level ${level}: ${result.tilesX}x${result.tilesY} tiles`);
  }

  return { completed: true };
}
