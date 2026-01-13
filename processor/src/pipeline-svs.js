/**
 * SVS/WSI Pipeline using OpenSlide + libvips
 * Generates DeepZoom tiles using vips dzsave
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import { join, basename } from 'path';

const execAsync = promisify(exec);

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILE_SIZE = 256;
const TILE_OVERLAP = 0;
const TILE_QUALITY = 90;

/**
 * Get slide properties using openslide-show-properties
 */
async function getSlideProperties(rawPath) {
  try {
    const { stdout } = await execAsync(`openslide-show-properties "${rawPath}"`);
    const props = {};

    for (const line of stdout.split('\n')) {
      const match = line.match(/^(.+?):\s*(.+)$/);
      if (match) {
        // Strip quotes from values (openslide outputs values like '10961')
        let value = match[2].trim();
        if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        props[match[1].trim()] = value;
      }
    }

    // Extract dimensions
    const width = parseInt(props['openslide.level[0].width'] || props['width'] || '0', 10);
    const height = parseInt(props['openslide.level[0].height'] || props['height'] || '0', 10);

    return { width, height, props };
  } catch (err) {
    console.error('openslide-show-properties failed, trying vipsheader...');
    return getSlidePropertiesVips(rawPath);
  }
}

/**
 * Fallback: get dimensions using vipsheader
 */
async function getSlidePropertiesVips(rawPath) {
  const { stdout } = await execAsync(`vipsheader -a "${rawPath}"`);
  const lines = stdout.split('\n');

  let width = 0, height = 0;
  for (const line of lines) {
    if (line.includes('width:')) {
      width = parseInt(line.split(':')[1].trim(), 10);
    }
    if (line.includes('height:')) {
      height = parseInt(line.split(':')[1].trim(), 10);
    }
  }

  return { width, height, props: {} };
}

/**
 * Calculate max level for DeepZoom (DZI standard)
 * vips dzsave uses: maxLevel = ceil(log2(maxDim))
 * Level 0 = 1x1 pixel, Level maxLevel = full resolution
 */
function calculateMaxLevel(width, height) {
  const maxDim = Math.max(width, height);
  return Math.ceil(Math.log2(maxDim));
}

/**
 * Generate thumbnail using vips
 */
async function generateThumbnail(rawPath, outputPath) {
  // Use vips thumbnail with openslide loader
  await execAsync(
    `vips thumbnail "${rawPath}" "${outputPath}" 256 --height 256`
  );
  console.log(`Generated thumbnail: ${outputPath}`);
}

/**
 * Generate DeepZoom tiles using vips dzsave
 */
async function generateDZITiles(rawPath, outputDir, slideId) {
  const dziBasePath = join(outputDir, 'dzi');

  // vips dzsave creates: dzi.dzi and dzi_files/
  console.log(`Starting vips dzsave for ${basename(rawPath)}...`);

  await execAsync(
    `vips dzsave "${rawPath}" "${dziBasePath}" ` +
    `--tile-size ${TILE_SIZE} ` +
    `--overlap ${TILE_OVERLAP} ` +
    `--suffix .jpg[Q=${TILE_QUALITY}]`
  );

  console.log('vips dzsave completed');
  return dziBasePath;
}

/**
 * Normalize DZI output to our tile structure
 * vips creates: dzi_files/{level}/{col}_{row}.jpg
 * We need: tiles/{level}/{col}_{row}.jpg
 */
async function normalizeTiles(outputDir) {
  const dziFilesDir = join(outputDir, 'dzi_files');
  const tilesDir = join(outputDir, 'tiles');

  // Rename dzi_files to tiles
  try {
    await rm(tilesDir, { recursive: true, force: true });
  } catch {}

  await rename(dziFilesDir, tilesDir);
  console.log(`Normalized tiles: ${dziFilesDir} -> ${tilesDir}`);

  // Remove the .dzi XML file (we use our own manifest.json)
  try {
    await rm(join(outputDir, 'dzi.dzi'));
  } catch {}

  // Remove vips-properties.xml if it exists
  try {
    await rm(join(tilesDir, 'vips-properties.xml'));
  } catch {}

  // Return tile count per level (only numeric directories)
  const entries = await readdir(tilesDir);
  const levels = entries.filter(e => /^\d+$/.test(e));
  const tileCount = {};

  for (const level of levels) {
    const levelPath = join(tilesDir, level);
    const tiles = await readdir(levelPath);
    tileCount[level] = tiles.length;
  }

  return tileCount;
}

/**
 * Process SVS/WSI file (P0 phase)
 */
export async function processSVS_P0(job) {
  const { slideId, rawPath } = job;
  const slideDir = join(DERIVED_DIR, slideId);

  await mkdir(slideDir, { recursive: true });

  console.log(`Processing SVS P0: ${basename(rawPath)}`);

  // Get slide dimensions
  const { width, height } = await getSlideProperties(rawPath);
  console.log(`Slide dimensions: ${width}x${height}`);

  if (!width || !height) {
    throw new Error('Could not determine slide dimensions');
  }

  const maxLevel = calculateMaxLevel(width, height);
  console.log(`Max level: ${maxLevel}`);

  // Generate thumbnail first (quick)
  const thumbPath = join(slideDir, 'thumb.jpg');
  await generateThumbnail(rawPath, thumbPath);

  // Generate all tiles with vips dzsave
  // Note: vips dzsave generates all levels at once, so P0/P1 separation
  // is less relevant here. We mark as "ready" after generation completes.
  await generateDZITiles(rawPath, slideDir, slideId);

  // Normalize tile directory structure
  const tileCount = await normalizeTiles(slideDir);

  console.log('Tile levels generated:');
  for (const [level, count] of Object.entries(tileCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  Level ${level}: ${count} tiles`);
  }

  const totalTiles = Object.values(tileCount).reduce((a, b) => a + b, 0);
  console.log(`Total tiles: ${totalTiles}`);

  // Generate manifest after tiles are ready (includes actual level info)
  const manifest = {
    protocol: 'dzi',
    tileSize: TILE_SIZE,
    overlap: TILE_OVERLAP,
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
    p0MaxLevel: maxLevel, // SVS generates all levels at once
    levelReadyMax: maxLevel,
    thumbPath,
    manifestPath,
    tileCount
  };
}

/**
 * P1 for SVS is a no-op since vips dzsave generates everything at once
 */
export async function processSVS_P1(job) {
  console.log(`SVS P1: Nothing to do (dzsave generates all levels at once)`);
  return { completed: true };
}
