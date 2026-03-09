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
  console.log(`[BIGTIFF] Settings: tile=${TILE_SIZE}x${TILE_SIZE}, Q=${JPEG_QUALITY}, bigtiff=true`);

  const cmd = [
    `vips tiffsave "${rawPath}" "${outputPath}"`,
    '--compression jpeg',
    `--Q ${JPEG_QUALITY}`,
    '--tile',
    `--tile-width ${TILE_SIZE}`,
    `--tile-height ${TILE_SIZE}`,
    '--pyramid',
    '--bigtiff',
  ].join(' ');

  await execAsync(cmd, {
    timeout: BIGTIFF_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
  });

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
