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
import { createSlide, createJob, updateSlide, updateSlideOcr, listPendingOcrSlides } from '../db/slides.js';
import { query } from '../db/index.js';
import { ocrLabel, isOcrEnabled } from '../lib/label-ocr.js';
import { parsePathologyFilename } from '../lib/filename-parser.js';
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

  // --- OCR label before registration ---
  let effectiveFilename = filename;
  let ocrStatus = null;
  let dsmetaPath = null;
  let externalFields = null;

  const dsmetaDir = filePath + '.dsmeta';
  const labelPath = dsmetaDir + '/label.jpg';

  if (isOcrEnabled()) {
    try {
      await access(labelPath, constants.R_OK);
      dsmetaPath = dsmetaDir;

      console.log(`[Scanner] OCR: found label at ${labelPath}`);
      const ocrResult = await ocrLabel(labelPath);

      if (ocrResult) {
        const newFilename = ocrResult.fullName + '.' + format;
        console.log(`[Scanner] OCR: ${filename} -> ${newFilename}`);
        effectiveFilename = newFilename;
        ocrStatus = 'done';
        externalFields = {
          externalCaseId: `pathoweb:${ocrResult.caseBase}`,
          externalCaseBase: ocrResult.caseBase,
          externalSlideLabel: ocrResult.fullName,
        };
      } else {
        console.log(`[Scanner] OCR: could not read label for ${filename}, processing with original name`);
        ocrStatus = 'pending';
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // No label.jpg — OCR not applicable
        console.log(`[Scanner] No label.jpg in .dsmeta for ${filename}`);
      } else {
        console.error(`[Scanner] OCR error for ${filename}: ${err.message}`);
        ocrStatus = 'pending';
        dsmetaPath = dsmetaDir;
      }
    }
  }

  // If OCR didn't provide external fields, try filename parser
  if (!externalFields) {
    const parsed = parsePathologyFilename(effectiveFilename);
    if (parsed) {
      externalFields = {
        externalCaseId: parsed.externalCaseId,
        externalCaseBase: parsed.externalCaseBase,
        externalSlideLabel: `${parsed.caseBase}${parsed.label}`,
      };
    }
  }

  // --- Register slide ---
  await createSlide({
    id: slideId,
    originalFilename: effectiveFilename,
    rawPath: filePath,
    format,
  });

  // Set external fields + OCR status
  const slideUpdates = { ...(externalFields || {}), ocrStatus, dsmetaPath };
  if (Object.values(slideUpdates).some(v => v !== null && v !== undefined)) {
    await updateSlideOcr(slideId, slideUpdates);
  }

  // --- Parse dsmeta for barcode/guid ---
  const pathInfo = parseMoticPath(filePath);
  let barcode = null;
  let guid = null;
  let scanDatetime = null;

  if (pathInfo) {
    barcode = pathInfo.barcode;
    guid = pathInfo.guid;
    scanDatetime = pathInfo.scanDatetime;
  }

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

  // --- Enqueue P0 processing ---
  const job = await createJob({ slideId, type: 'P0' });
  if (!job) {
    console.log(`[Scanner] P0 already active for ${slideId.substring(0, 12)}, skipping enqueue`);
    return slideId;
  }

  await enqueueJob({
    jobId: job.id,
    slideId,
    type: 'P0',
    rawPath: filePath,
    format,
  });

  eventBus.emitSlideImport(slideId, effectiveFilename, format);

  console.log(`[Scanner] Registered slide ${slideId.substring(0, 12)} (${effectiveFilename}, barcode=${barcode || 'unknown'}, ocr=${ocrStatus || 'n/a'})`);
  return slideId;
}

/**
 * Retry OCR for slides that previously failed.
 * On success: update original_filename, external fields, and ocr_status.
 * Re-emit SlideRegistered outbox event so cloud picks up the new name.
 */
async function retryPendingOcr() {
  const pendingSlides = await listPendingOcrSlides();

  if (pendingSlides.length === 0) return;

  console.log(`[Scanner] Retrying OCR for ${pendingSlides.length} pending slides...`);

  for (const slide of pendingSlides) {
    try {
      const labelPath = slide.dsmeta_path + '/label.jpg';
      await access(labelPath, constants.R_OK);

      const ocrResult = await ocrLabel(labelPath);
      if (!ocrResult) {
        console.log(`[Scanner] OCR retry still failed for ${slide.id.substring(0, 12)}`);
        continue;
      }

      const format = slide.format || 'svs';
      const newFilename = ocrResult.fullName + '.' + format;

      console.log(`[Scanner] OCR retry success: ${slide.original_filename} -> ${newFilename}`);

      // Update slide DB
      await updateSlideOcr(slide.id, {
        originalFilename: newFilename,
        externalCaseId: `pathoweb:${ocrResult.caseBase}`,
        externalCaseBase: ocrResult.caseBase,
        externalSlideLabel: ocrResult.fullName,
        ocrStatus: 'done',
      });

      // Re-emit SlideRegistered only if TILEGEN is already done (slide fully ready)
      const slideRow = await query(
        'SELECT width, height, mpp, tilegen_status, external_case_id, external_case_base, external_slide_label FROM slides WHERE id = $1',
        [slide.id]
      );
      const s = slideRow.rows[0];
      if (s && s.tilegen_status === 'done') {
        await query(
          `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
           VALUES ($1, $2, $3, $4)`,
          ['slide', slide.id, 'registered', JSON.stringify({
            slide_id: slide.id,
            case_id: null,
            svs_filename: newFilename,
            width: s.width || 0,
            height: s.height || 0,
            mpp: parseFloat(s.mpp) || 0,
            external_case_id: s.external_case_id,
            external_case_base: s.external_case_base,
            external_slide_label: s.external_slide_label,
          })]
        );
        console.log(`[Scanner] Re-emitted SlideRegistered for ${slide.id.substring(0, 12)} with new name ${newFilename}`);
      } else {
        console.log(`[Scanner] OCR updated for ${slide.id.substring(0, 12)} but TILEGEN not done yet — SlideRegistered will emit after TILEGEN`);
      }
    } catch (err) {
      console.error(`[Scanner] OCR retry error for ${slide.id.substring(0, 12)}: ${err.message}`);
    }
  }
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

    // Retry OCR for previously failed slides
    if (isOcrEnabled()) {
      try {
        await retryPendingOcr();
      } catch (err) {
        console.error(`[Scanner] OCR retry batch error: ${err.message}`);
      }
    }

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
