/**
 * Scanner Adapter Service
 *
 * Periodically scans a mounted scanner directory (e.g., /scanner from E:\Slides\Completed)
 * for new SVS files. Discovers files recursively, deduplicates against scanner_files table,
 * registers new slides, and enqueues P0 jobs.
 *
 * Unlike the watcher (which moves files to raw/), the scanner adapter leaves files in place.
 * The raw_path stored in the DB points directly to the scanner mount location.
 *
 * Enable via env:
 *   SCANNER_ENABLED=true
 *   SCANNER_DIR=/scanner
 *   SCANNER_INTERVAL_MS=120000
 */

import { readdir, access } from 'fs/promises';
import { join, extname } from 'path';
import { constants } from 'fs';
import { hashFile } from '../lib/hash.js';
import { parseDsmeta, parseMoticPath } from '../lib/dsmeta-parser.js';
import { createSlide, createJob, updateSlide } from '../db/slides.js';
import { scannerFileExists, insertScannerFile, getAllScannerFilePaths } from '../db/scanner.js';
import { enqueueJob } from '../lib/queue.js';
import { eventBus } from './events.js';

const WSI_EXTENSIONS = new Set(['.svs', '.ndpi', '.tif', '.tiff', '.mrxs']);

let scannerInterval = null;
let scanning = false;
let scannerState = {
  enabled: false,
  state: 'stopped',
  lastScan: null,
  lastScanCount: 0,
  totalDiscovered: 0,
  error: null,
};

export function getScannerState() {
  return { ...scannerState };
}

/**
 * Recursively find all SVS files under a directory.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function findSvsFiles(dir) {
  const results = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.dsmeta')) continue;
        const subFiles = await findSvsFiles(fullPath);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (WSI_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EACCES') {
      console.error(`[Scanner] Error reading ${dir}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Process a single newly discovered SVS file.
 */
async function processNewFile(filePath) {
  const filename = filePath.split('/').pop();
  const format = extname(filename).toLowerCase().replace('.', '');

  console.log(`[Scanner] Hashing ${filename}...`);
  const slideId = await hashFile(filePath);
  console.log(`[Scanner] ${filename} -> slideId: ${slideId.substring(0, 12)}...`);

  await createSlide({
    id: slideId,
    originalFilename: filename,
    rawPath: filePath,
    format,
  });

  const pathInfo = parseMoticPath(filePath);
  let barcode = null;
  let guid = null;
  let scanDatetime = null;

  if (pathInfo) {
    barcode = pathInfo.barcode;
    guid = pathInfo.guid;
    scanDatetime = pathInfo.scanDatetime;
  }

  const dsmetaDir = filePath + '.dsmeta';
  const dsmeta = await parseDsmeta(dsmetaDir);
  if (dsmeta) {
    barcode = dsmeta.barcode || barcode;
    guid = dsmeta.guid || guid;
  }

  if (barcode) {
    await updateSlide(slideId, { scannerBarcode: barcode });
  }

  await insertScannerFile({
    filePath,
    slideId,
    scannerBarcode: barcode,
    scannerGuid: guid,
    scanDatetime,
  });

  const job = await createJob({ slideId, type: 'P0' });
  await enqueueJob({
    jobId: job.id,
    slideId,
    type: 'P0',
    rawPath: filePath,
    format,
  });

  eventBus.emitSlideImport(slideId, filename, format);

  console.log(`[Scanner] Registered slide ${slideId.substring(0, 12)} (${filename}, barcode=${barcode || 'unknown'})`);
  return slideId;
}

/**
 * Run one scan cycle: discover new files, process them.
 */
export async function runScan() {
  if (scanning) {
    console.log('[Scanner] Scan already in progress, skipping');
    return { scanned: 0, newFiles: 0 };
  }

  scanning = true;
  scannerState.state = 'scanning';

  const scannerDir = process.env.SCANNER_DIR || '/scanner';

  try {
    await access(scannerDir, constants.R_OK);

    const knownPaths = await getAllScannerFilePaths();

    const allFiles = await findSvsFiles(scannerDir);
    console.log(`[Scanner] Found ${allFiles.length} SVS files, ${knownPaths.size} already known`);

    const newFiles = allFiles.filter(f => !knownPaths.has(f));

    if (newFiles.length === 0) {
      scannerState.lastScan = new Date().toISOString();
      scannerState.lastScanCount = 0;
      scannerState.state = 'running';
      scanning = false;
      return { scanned: allFiles.length, newFiles: 0 };
    }

    console.log(`[Scanner] Processing ${newFiles.length} new files...`);

    let processed = 0;
    for (const filePath of newFiles) {
      try {
        await processNewFile(filePath);
        processed++;
      } catch (err) {
        console.error(`[Scanner] Failed to process ${filePath}: ${err.message}`);
      }
    }

    scannerState.lastScan = new Date().toISOString();
    scannerState.lastScanCount = processed;
    scannerState.totalDiscovered += processed;
    scannerState.state = 'running';
    scannerState.error = null;

    console.log(`[Scanner] Scan complete: ${processed}/${newFiles.length} new slides registered`);
    return { scanned: allFiles.length, newFiles: processed };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      scannerState.state = 'dir_missing';
      scannerState.error = `Scanner directory not accessible: ${scannerDir}`;
      console.warn(`[Scanner] ${scannerState.error}`);
    } else {
      scannerState.state = 'running';
      scannerState.error = err.message;
      console.error(`[Scanner] Scan error: ${err.message}`);
    }
    return { scanned: 0, newFiles: 0 };
  } finally {
    scanning = false;
  }
}

/**
 * Start the scanner adapter.
 */
export async function startScanner() {
  const enabled = process.env.SCANNER_ENABLED === 'true';
  if (!enabled) {
    scannerState.enabled = false;
    scannerState.state = 'disabled';
    console.log('[Scanner] Scanner adapter disabled (SCANNER_ENABLED != true)');
    return;
  }

  const intervalMs = parseInt(process.env.SCANNER_INTERVAL_MS || '120000', 10);
  const scannerDir = process.env.SCANNER_DIR || '/scanner';

  scannerState.enabled = true;
  scannerState.state = 'running';

  console.log(`[Scanner] Starting scanner adapter`);
  console.log(`[Scanner]   directory: ${scannerDir}`);
  console.log(`[Scanner]   interval: ${intervalMs / 1000}s`);

  await runScan();

  scannerInterval = setInterval(() => {
    runScan().catch(err => {
      console.error(`[Scanner] Periodic scan error: ${err.message}`);
    });
  }, intervalMs);
}

/**
 * Stop the scanner adapter.
 */
export function stopScanner() {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }
  scannerState.state = 'stopped';
}
