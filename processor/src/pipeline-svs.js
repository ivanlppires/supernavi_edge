/**
 * SVS/WSI Pipeline - Edge-First Architecture
 *
 * P0: Quick metadata extraction + thumbnail (instant viewer access)
 * Post-P0: Full tile pyramid generation via vips dzsave (TILEGEN job)
 * Fallback: On-demand tile generation during TILEGEN window
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, unlink, access, readdir, rename } from 'fs/promises';
import { join, basename } from 'path';

const execAsync = promisify(exec);

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';
const TILES_HOT_DIR = process.env.TILES_HOT_DIR || '/data/tiles_hot';

/**
 * Run a shell command via spawn (no maxBuffer limit, long-running safe).
 */
function spawnAsync(cmd, { timeout } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let timer;
    if (timeout) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Timed out after ${timeout}ms: ${cmd}`));
      }, timeout);
    }
    proc.stderr.on('data', chunk => { stderr += chunk.toString().slice(-2000); });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}: ${cmd}\n${stderr}`));
    });
    proc.on('error', err => { if (timer) clearTimeout(timer); reject(err); });
  });
}
const TILE_SIZE = 256;
const TILE_OVERLAP = 0;

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

    // Extract magnification metadata (Aperio format)
    const appMag = parseFloat(props['aperio.AppMag'] || '0') || null;
    const mpp = parseFloat(props['aperio.MPP'] || '0') || null;

    return { width, height, appMag, mpp, props };
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

  return { width, height, appMag: null, mpp: null, props: {} };
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
  // Generate a 640x400 (16:10) centre-cropped thumbnail.
  // This matches the dashboard card aspect ratio and avoids low-res
  // stretched thumbnails for elongated slides (e.g. 100000x20000).
  await execAsync(
    `vips thumbnail "${rawPath}" "${outputPath}" 640 --height 400 --crop centre`
  );
  console.log(`Generated thumbnail: ${outputPath}`);
}

/**
 * Process SVS/WSI file (P0 phase) - Edge-First
 *
 * Only extracts metadata and generates thumbnail.
 * Tiles are generated on-demand by the API.
 */
export async function processSVS_P0(job) {
  const { slideId, rawPath } = job;
  const slideDir = join(DERIVED_DIR, slideId);

  await mkdir(slideDir, { recursive: true });

  console.log(`Processing SVS P0 (edge-first): ${basename(rawPath)}`);

  // Get slide dimensions and magnification metadata
  const { width, height, appMag, mpp } = await getSlideProperties(rawPath);
  console.log(`Slide dimensions: ${width}x${height}`);
  console.log(`Magnification: ${appMag}x, MPP: ${mpp} µm/pixel`);

  if (!width || !height) {
    throw new Error('Could not determine slide dimensions');
  }

  const maxLevel = calculateMaxLevel(width, height);
  console.log(`Max level: ${maxLevel}`);

  // Generate thumbnail (quick)
  const thumbPath = join(slideDir, 'thumb.jpg');
  await generateThumbnail(rawPath, thumbPath);

  // Create tiles directory (tiles generated on-demand)
  const tilesDir = join(slideDir, 'tiles');
  await mkdir(tilesDir, { recursive: true });

  // Generate manifest immediately (viewer can start)
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
    tileUrlTemplate: `/v1/slides/${slideId}/tiles/{z}/{x}/{y}.jpg`,
    onDemand: true,  // Tiles generated on-demand
    // Magnification metadata for proper zoom display
    appMag: appMag,  // Native scan magnification (e.g., 20, 40)
    mpp: mpp         // Microns per pixel
  };

  const manifestPath = join(slideDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Generated manifest: ${manifestPath}`);

  console.log(`SVS P0 complete - viewer ready (tiles on-demand)`);

  return {
    width,
    height,
    maxLevel,
    p0MaxLevel: 0,        // No tiles pre-generated
    levelReadyMax: 0,     // Tiles generated on-demand
    thumbPath,
    manifestPath,
    appMag,               // Native scan magnification
    mpp                   // Microns per pixel
  };
}

const TILEGEN_TIMEOUT_MS = parseInt(process.env.TILEGEN_TIMEOUT_MS || '600000', 10);

/**
 * Generate full DeepZoom tile pyramid using vips dzsave.
 *
 * Two-phase approach for Docker-for-Windows performance:
 * 1. dzsave writes to tmpfs (RAM-backed, ~4 min for large slides)
 * 2. Tiles immediately available via hot path (/data/tiles_hot)
 * 3. Background copy to persistent storage (bind mount, slow but non-blocking)
 *
 * The API checks tiles_hot first, then persistent tiles, then on-demand.
 */
export async function generateFullTilePyramid(slideId, rawPath) {
  const hotSlideDir = join(TILES_HOT_DIR, slideId);
  const hotTmpOutput = join(hotSlideDir, 'dz');
  const hotDzsaveOutput = join(hotSlideDir, 'dz_files');
  const hotTilesDir = join(hotSlideDir, 'tiles');
  const startTime = Date.now();

  console.log(`[TILEGEN] Starting vips dzsave for ${slideId.substring(0, 12)}...`);

  // Clean previous residue from tmpfs
  await execAsync(`rm -rf "${hotSlideDir}"`).catch(() => {});
  await mkdir(hotSlideDir, { recursive: true });

  try {
    // Phase 1: dzsave to tmpfs (RAM-backed, blazing fast)
    const cmd = `vips dzsave "${rawPath}" "${hotTmpOutput}" --suffix .jpg[Q=90] --tile-size ${TILE_SIZE} --overlap ${TILE_OVERLAP}`;
    await execAsync(cmd, { timeout: TILEGEN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });

    // Count generated tiles
    let tileCount = 0;
    const levelDirs = await readdir(hotDzsaveOutput);
    for (const dir of levelDirs) {
      if (/^\d+$/.test(dir)) {
        const files = await readdir(join(hotDzsaveOutput, dir));
        tileCount += files.filter(f => f.endsWith('.jpg')).length;
      }
    }

    // Rename dz_files → tiles (atomic, same tmpfs filesystem)
    await rename(hotDzsaveOutput, hotTilesDir);
    // Clean dz.dzi metadata file
    await unlink(join(hotSlideDir, 'dz.dzi')).catch(() => {});

    const elapsed = Date.now() - startTime;
    console.log(`[TILEGEN] Hot tiles ready: ${tileCount} tiles in ${elapsed}ms`);

    return { tileCount, elapsed };
  } catch (err) {
    await execAsync(`rm -rf "${hotSlideDir}"`).catch(() => {});
    throw err;
  }
}

/**
 * Background: copy tiles from tmpfs to persistent bind-mount storage.
 * Uses tar streaming for reliability on Docker-for-Windows NTFS mounts.
 * Non-blocking — tiles are already served from hot path.
 */
export async function persistTilesBackground(slideId) {
  const hotTilesDir = join(TILES_HOT_DIR, slideId, 'tiles');
  const slideDir = join(DERIVED_DIR, slideId);
  const persistDir = join(slideDir, 'tiles');
  const startTime = Date.now();

  console.log(`[TILEGEN] Persisting tiles for ${slideId.substring(0, 12)}...`);

  try {
    // Remove old on-demand tiles and staging residue
    await execAsync(`rm -rf "${persistDir}" "${join(slideDir, '.dzsave_tmp')}"`).catch(() => {});
    await mkdir(persistDir, { recursive: true });

    // Stream via tar (single sequential write, reliable on NTFS bind mounts)
    await spawnAsync(
      `tar -C "${hotTilesDir}" -cf - . | tar -C "${persistDir}" -xf -`,
      { timeout: 60 * 60 * 1000 } // 1 hour
    );

    // Clean hot tiles (RAM freed)
    await execAsync(`rm -rf "${join(TILES_HOT_DIR, slideId)}"`).catch(() => {});

    const elapsed = Date.now() - startTime;
    console.log(`[TILEGEN] Tiles persisted for ${slideId.substring(0, 12)} in ${elapsed}ms`);
  } catch (err) {
    // Non-fatal: hot tiles still serve, persist will retry on next restart
    console.error(`[TILEGEN] Persist failed for ${slideId.substring(0, 12)} (non-fatal): ${err.message}`);
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * P1 for SVS is a no-op (tiles are generated on-demand by API)
 */
export async function processSVS_P1(job) {
  console.log(`SVS P1: No-op (tiles generated on-demand)`);
  return { completed: true, levelReadyMax: 0 };
}
