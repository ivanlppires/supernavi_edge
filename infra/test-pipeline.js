/**
 * Standalone pipeline test - runs without Docker/Redis/PostgreSQL
 * Tests tile generation directly with a sample image
 */

import sharp from 'sharp';
import { mkdir, rm, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const TEST_DIR = './data/test-run';
const TILE_SIZE = 256;

// Generate a test image
async function createTestImage(width, height) {
  console.log(`Creating test image: ${width}x${height}`);

  const imagePath = join(TEST_DIR, 'test-input.jpg');

  // Create a gradient image with some patterns for visual verification
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      // Create a colorful pattern
      pixels[idx] = Math.floor((x / width) * 255);     // R: gradient left-right
      pixels[idx + 1] = Math.floor((y / height) * 255); // G: gradient top-bottom
      pixels[idx + 2] = Math.floor(((x + y) % 256));   // B: diagonal pattern
    }
  }

  await sharp(pixels, { raw: { width, height, channels } })
    .jpeg({ quality: 90 })
    .toFile(imagePath);

  console.log(`Created: ${imagePath}`);
  return imagePath;
}

// Calculate slideId from file
async function calculateSlideId(filePath) {
  const buffer = await readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

// Calculate max level for DeepZoom
function calculateMaxLevel(width, height) {
  const maxDim = Math.max(width, height);
  return Math.ceil(Math.log2(maxDim / TILE_SIZE));
}

// Calculate dimensions for a specific level
function calculateLevelDimensions(width, height, level, maxLevel) {
  const scale = Math.pow(2, maxLevel - level);
  return {
    width: Math.ceil(width / scale),
    height: Math.ceil(height / scale)
  };
}

// Generate tiles for a level
async function generateTilesForLevel(image, outputDir, level, levelWidth, levelHeight) {
  const tilesX = Math.ceil(levelWidth / TILE_SIZE);
  const tilesY = Math.ceil(levelHeight / TILE_SIZE);
  const tilesDir = join(outputDir, 'tiles', String(level));

  await mkdir(tilesDir, { recursive: true });

  let count = 0;
  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      const left = x * TILE_SIZE;
      const top = y * TILE_SIZE;
      const width = Math.min(TILE_SIZE, levelWidth - left);
      const height = Math.min(TILE_SIZE, levelHeight - top);

      const tilePath = join(tilesDir, `${x}_${y}.jpg`);

      await image
        .clone()
        .resize(levelWidth, levelHeight, { fit: 'fill' })
        .extract({ left, top, width, height })
        .jpeg({ quality: 85 })
        .toFile(tilePath);

      count++;
    }
  }

  return { tilesX, tilesY, count };
}

// Main test
async function runTest() {
  console.log('=== SuperNavi Pipeline Test ===\n');

  // Clean up previous test
  try {
    await rm(TEST_DIR, { recursive: true });
  } catch {}
  await mkdir(TEST_DIR, { recursive: true });

  // Create test image (2048x1536 - large enough to generate multiple levels)
  const testWidth = 2048;
  const testHeight = 1536;
  const imagePath = await createTestImage(testWidth, testHeight);

  // Calculate slideId
  const slideId = await calculateSlideId(imagePath);
  console.log(`SlideId: ${slideId.substring(0, 16)}...`);

  // Setup output directory
  const outputDir = join(TEST_DIR, 'derived', slideId);
  await mkdir(outputDir, { recursive: true });

  // Load image
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  console.log(`Image dimensions: ${metadata.width}x${metadata.height}`);

  // Calculate levels
  const maxLevel = calculateMaxLevel(metadata.width, metadata.height);
  console.log(`Max level: ${maxLevel}`);

  // Generate thumbnail
  console.log('\nGenerating thumbnail...');
  const thumbPath = join(outputDir, 'thumb.jpg');
  await image
    .clone()
    .resize(256, 256, { fit: 'inside' })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);
  console.log(`Thumbnail: ${thumbPath}`);

  // Generate tiles for P0 levels (0-4)
  const p0MaxLevel = Math.min(4, maxLevel);
  console.log(`\nGenerating P0 tiles (levels 0-${p0MaxLevel})...`);

  const startTime = Date.now();
  let totalTiles = 0;

  for (let level = 0; level <= p0MaxLevel; level++) {
    const { width: levelWidth, height: levelHeight } = calculateLevelDimensions(
      metadata.width,
      metadata.height,
      level,
      maxLevel
    );

    const result = await generateTilesForLevel(
      image,
      outputDir,
      level,
      levelWidth,
      levelHeight
    );

    console.log(`  Level ${level}: ${levelWidth}x${levelHeight} -> ${result.tilesX}x${result.tilesY} tiles (${result.count} total)`);
    totalTiles += result.count;
  }

  const p0Time = Date.now() - startTime;
  console.log(`P0 complete: ${totalTiles} tiles in ${p0Time}ms`);

  // Generate P1 levels if needed
  if (maxLevel > p0MaxLevel) {
    console.log(`\nGenerating P1 tiles (levels ${p0MaxLevel + 1}-${maxLevel})...`);
    const p1Start = Date.now();
    let p1Tiles = 0;

    for (let level = p0MaxLevel + 1; level <= maxLevel; level++) {
      const { width: levelWidth, height: levelHeight } = calculateLevelDimensions(
        metadata.width,
        metadata.height,
        level,
        maxLevel
      );

      const result = await generateTilesForLevel(
        image,
        outputDir,
        level,
        levelWidth,
        levelHeight
      );

      console.log(`  Level ${level}: ${levelWidth}x${levelHeight} -> ${result.tilesX}x${result.tilesY} tiles (${result.count} total)`);
      p1Tiles += result.count;
    }

    const p1Time = Date.now() - p1Start;
    console.log(`P1 complete: ${p1Tiles} tiles in ${p1Time}ms`);
    totalTiles += p1Tiles;
  }

  // Generate manifest
  const manifest = {
    protocol: 'dzi',
    tileSize: TILE_SIZE,
    format: 'jpg',
    maxLevel,
    width: metadata.width,
    height: metadata.height,
    tileUrlTemplate: `/v1/slides/${slideId}/tiles/{z}/{x}/{y}.jpg`
  };

  const manifestPath = join(outputDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${manifestPath}`);

  // Summary
  console.log('\n=== Results ===');
  console.log(`Total tiles generated: ${totalTiles}`);
  console.log(`Total time: ${Date.now() - startTime}ms`);

  // List generated files
  console.log('\nGenerated structure:');
  const tilesDir = join(outputDir, 'tiles');
  const levels = await readdir(tilesDir);
  for (const level of levels.sort((a, b) => Number(a) - Number(b))) {
    const tiles = await readdir(join(tilesDir, level));
    console.log(`  tiles/${level}/: ${tiles.length} files`);
  }

  // Verify manifest
  console.log('\nManifest content:');
  const savedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  console.log(JSON.stringify(savedManifest, null, 2));

  console.log('\n=== Test Complete ===');
  console.log(`Output directory: ${outputDir}`);
}

runTest().catch(console.error);
