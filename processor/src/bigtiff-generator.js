/**
 * BigTIFF Generator — creates a single pyramidal BigTIFF from WSI source files.
 *
 * Replaces vips dzsave (90k tiles) with vips tiffsave (1 file).
 * Eliminates the NTFS bind-mount bottleneck entirely.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { stat, mkdir, unlink, access } from 'fs/promises';
import { join } from 'path';
import os from 'os';

const execAsync = promisify(exec);

const TMP_DIR = process.env.BIGTIFF_TMP_DIR || '/data/tmp';
const TILE_SIZE = parseInt(process.env.BIGTIFF_TILE_SIZE || '256', 10);
const JPEG_QUALITY = parseInt(process.env.TILE_JPEG_QUALITY || '80', 10);
const BIGTIFF_TIMEOUT_MS = parseInt(process.env.BIGTIFF_TIMEOUT_MS || '600000', 10); // 10 min

/**
 * Generate a pyramidal BigTIFF from a WSI source file.
 *
 * @param {string} slideId - Slide identifier (SHA256)
 * @param {string} rawPath - Path to source SVS/NDPI/TIFF/MRXS file
 * @returns {{ path: string, size: number, elapsed: number }}
 */
export async function generateBigTIFF(slideId, rawPath) {
  const startTime = Date.now();
  await mkdir(TMP_DIR, { recursive: true });

  const outputPath = join(TMP_DIR, `${slideId}.tif`);

  // Clean any previous residue
  await unlink(outputPath).catch(() => {});

  console.log(`[BIGTIFF] Generating pyramidal BigTIFF for ${slideId.substring(0, 12)}`);
  console.log(`[BIGTIFF] Input: ${rawPath}`);
  console.log(`[BIGTIFF] Settings: tile=${TILE_SIZE}x${TILE_SIZE}, Q=${JPEG_QUALITY}, bigtiff=true, subifd=true`);

  // Detect which loader vips will use for this file
  try {
    const { stdout } = await execAsync(`vipsheader -f vips-loader "${rawPath}"`);
    console.log(`[BIGTIFF] Vips loader: ${stdout.trim()}`);
  } catch {
    console.log(`[BIGTIFF] Could not detect vips loader`);
  }

  // Build tiffsave flags:
  // NOTE: Do NOT use --subifd — Cantaloupe 6's imageio-ext library does not
  // support TIFF IFD8 pointer types (tag type 18), causing ArrayIndexOutOfBoundsException.
  // Standard multi-IFD pyramid (without SubIFD) is universally compatible.
  const tiffsaveFlags = [
    '--compression jpeg',
    `--Q ${JPEG_QUALITY}`,
    '--tile',
    `--tile-width ${TILE_SIZE}`,
    `--tile-height ${TILE_SIZE}`,
    '--pyramid',
    '--bigtiff',
  ].join(' ');

  // Force OpenSlide loader by passing level=0 (an openslide-specific option).
  // This prevents vips from falling back to tiffload, which can misread
  // multi-IFD SVS files and produce blurry regions in the output.
  const openslideCmd = `vips tiffsave "${rawPath}[level=0]" "${outputPath}" ${tiffsaveFlags}`;

  try {
    await execAsync(openslideCmd, {
      timeout: BIGTIFF_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });
    console.log(`[BIGTIFF] Conversion complete (OpenSlide loader, level=0)`);
  } catch (err) {
    // If openslide fails (e.g., non-SVS TIFF), fall back to auto-detect
    console.warn(`[BIGTIFF] OpenSlide load failed: ${err.message}`);
    console.log(`[BIGTIFF] Falling back to auto-detect loader...`);
    await unlink(outputPath).catch(() => {});

    const fallbackCmd = `vips tiffsave "${rawPath}" "${outputPath}" ${tiffsaveFlags}`;
    await execAsync(fallbackCmd, {
      timeout: BIGTIFF_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });
    console.log(`[BIGTIFF] Conversion complete (auto-detect loader)`);
  }

  const stats = await stat(outputPath);
  const elapsed = Date.now() - startTime;

  console.log(`[BIGTIFF] Generated: ${(stats.size / 1024 / 1024).toFixed(1)} MB in ${(elapsed / 1000).toFixed(1)}s`);

  return {
    path: outputPath,
    size: stats.size,
    elapsed,
  };
}

/**
 * Check available disk space in the temp directory.
 * Returns free space in bytes.
 */
export async function checkDiskSpace() {
  try {
    const { stdout } = await execAsync(`df -B1 "${TMP_DIR}" | tail -1 | awk '{print $4}'`);
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return Infinity; // If we can't check, assume enough space
  }
}

/**
 * Calculate how many BigTIFF jobs can run in parallel based on available
 * system resources (free RAM and CPU cores).
 *
 * Formula: min(floor(freeRAM / 3GB), floor(cpuCores / 4), 8)
 *
 * @returns {{ slots: number, freeGB: number, cpuCores: number }}
 */
export function calculateParallelSlots() {
  const freeBytes = os.freemem();
  const freeGB = freeBytes / (1024 ** 3);
  const cpuCores = os.cpus().length;

  const ramSlots = Math.floor(freeGB / 3);
  const cpuSlots = Math.floor(cpuCores / 4);
  const slots = Math.max(1, Math.min(ramSlots, cpuSlots, 8));

  return { slots, freeGB, cpuCores };
}

/**
 * Clean up temporary BigTIFF file for a slide.
 */
export async function cleanupBigTIFF(slideId) {
  const outputPath = join(TMP_DIR, `${slideId}.tif`);
  try {
    await access(outputPath);
    await unlink(outputPath);
    console.log(`[BIGTIFF] Cleaned up temp file: ${outputPath}`);
  } catch {
    // File doesn't exist, nothing to clean
  }
}
