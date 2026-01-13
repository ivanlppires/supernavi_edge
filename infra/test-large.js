/**
 * Test with larger image to verify P0/P1 separation
 */

import sharp from 'sharp';
import { mkdir, rm, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const TEST_DIR = './data/test-large';
const TILE_SIZE = 256;
const P0_MAX_LEVEL = 4;

async function createLargeTestImage(width, height) {
  console.log(`Creating large test image: ${width}x${height}`);
  const imagePath = join(TEST_DIR, 'large-input.jpg');

  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      pixels[idx] = Math.floor((x / width) * 255);
      pixels[idx + 1] = Math.floor((y / height) * 255);
      pixels[idx + 2] = Math.floor(((x * y) % 256));
    }
  }

  await sharp(pixels, { raw: { width, height, channels } })
    .jpeg({ quality: 90 })
    .toFile(imagePath);

  return imagePath;
}

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

      await image.clone()
        .resize(levelWidth, levelHeight, { fit: 'fill' })
        .extract({ left, top, width, height })
        .jpeg({ quality: 85 })
        .toFile(tilePath);
      count++;
    }
  }
  return { tilesX, tilesY, count };
}

async function runTest() {
  console.log('=== Large Image Pipeline Test (P0/P1 Separation) ===\n');

  try { await rm(TEST_DIR, { recursive: true }); } catch {}
  await mkdir(TEST_DIR, { recursive: true });

  // 8192x6144 image = ~50 megapixels, should generate level 0-5
  const testWidth = 8192;
  const testHeight = 6144;
  const imagePath = await createLargeTestImage(testWidth, testHeight);

  const buffer = await readFile(imagePath);
  const slideId = createHash('sha256').update(buffer).digest('hex').substring(0, 16);
  console.log(`SlideId: ${slideId}`);

  const outputDir = join(TEST_DIR, 'derived', slideId);
  await mkdir(outputDir, { recursive: true });

  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const maxLevel = calculateMaxLevel(metadata.width, metadata.height);

  console.log(`Image: ${metadata.width}x${metadata.height}`);
  console.log(`Max level: ${maxLevel}`);
  console.log(`P0 will generate levels: 0-${Math.min(P0_MAX_LEVEL, maxLevel)}`);
  console.log(`P1 will generate levels: ${Math.min(P0_MAX_LEVEL, maxLevel) + 1}-${maxLevel}`);

  // P0 Phase
  console.log('\n--- P0 Phase (Quick Preview) ---');
  const p0Start = Date.now();
  const p0MaxLevel = Math.min(P0_MAX_LEVEL, maxLevel);
  let p0Tiles = 0;

  // Thumbnail
  await image.clone()
    .resize(256, 256, { fit: 'inside' })
    .jpeg({ quality: 80 })
    .toFile(join(outputDir, 'thumb.jpg'));

  for (let level = 0; level <= p0MaxLevel; level++) {
    const { width: lw, height: lh } = calculateLevelDimensions(metadata.width, metadata.height, level, maxLevel);
    const result = await generateTilesForLevel(image, outputDir, level, lw, lh);
    console.log(`  Level ${level}: ${lw}x${lh} -> ${result.count} tiles`);
    p0Tiles += result.count;
  }

  const p0Time = Date.now() - p0Start;
  console.log(`P0 complete: ${p0Tiles} tiles in ${p0Time}ms`);
  console.log(`>> At this point, viewer can start showing preview! <<`);

  // P1 Phase
  if (maxLevel > p0MaxLevel) {
    console.log('\n--- P1 Phase (Full Resolution) ---');
    const p1Start = Date.now();
    let p1Tiles = 0;

    for (let level = p0MaxLevel + 1; level <= maxLevel; level++) {
      const { width: lw, height: lh } = calculateLevelDimensions(metadata.width, metadata.height, level, maxLevel);
      const result = await generateTilesForLevel(image, outputDir, level, lw, lh);
      console.log(`  Level ${level}: ${lw}x${lh} -> ${result.count} tiles`);
      p1Tiles += result.count;
    }

    const p1Time = Date.now() - p1Start;
    console.log(`P1 complete: ${p1Tiles} tiles in ${p1Time}ms`);
  }

  // Manifest
  const manifest = {
    protocol: 'dzi',
    tileSize: TILE_SIZE,
    format: 'jpg',
    maxLevel,
    width: metadata.width,
    height: metadata.height,
    tileUrlTemplate: `/v1/slides/${slideId}/tiles/{z}/{x}/{y}.jpg`
  };
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Summary
  console.log('\n=== Summary ===');
  const levels = await readdir(join(outputDir, 'tiles'));
  let totalTiles = 0;
  for (const level of levels.sort((a, b) => Number(a) - Number(b))) {
    const tiles = await readdir(join(outputDir, 'tiles', level));
    console.log(`  Level ${level}: ${tiles.length} tiles`);
    totalTiles += tiles.length;
  }
  console.log(`Total: ${totalTiles} tiles`);
  console.log(`\nP0 time: ${p0Time}ms (preview ready)`);
  console.log(`Output: ${outputDir}`);
}

runTest().catch(console.error);
