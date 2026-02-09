import { watch, createReadStream, createWriteStream } from 'fs';
import { readdir, mkdir, stat, unlink, access } from 'fs/promises';
import { join, basename, extname } from 'path';
import { constants } from 'fs';
import { pipeline } from 'stream/promises';
import { hashFile } from '../lib/hash.js';
import { enqueueJob } from '../lib/queue.js';
import { createSlide, createJob, updateSlide } from '../db/slides.js';
import { eventBus } from './events.js';
import { parsePathologyFilename } from '../lib/filename-parser.js';
import { loadConfig, getConfig } from '../lib/edge-config.js';

// Supported formats by category
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const WSI_EXTENSIONS = ['.svs', '.tif', '.tiff', '.ndpi', '.mrxs'];
const SUPPORTED_EXTENSIONS = [...IMAGE_EXTENSIONS, ...WSI_EXTENSIONS];

// ============================================================================
// Watcher state
// ============================================================================

let watcherState = 'stopped'; // 'running' | 'needs_config' | 'dir_inaccessible' | 'stopped'
let watcherError = null;
let watcherIngestDir = null;
let dirHealthInterval = null;
let fsWatcher = null;

/**
 * Get current watcher state.
 * @returns {{ state: string, error: string|null, ingestDir: string|null }}
 */
export function getWatcherState() {
  return { state: watcherState, error: watcherError, ingestDir: watcherIngestDir };
}

/**
 * Stop the watcher and health check interval.
 */
export function stopWatcher() {
  if (fsWatcher) {
    fsWatcher.close();
    fsWatcher = null;
  }
  if (dirHealthInterval) {
    clearInterval(dirHealthInterval);
    dirHealthInterval = null;
  }
  watcherState = 'stopped';
}

// ============================================================================
// Helpers
// ============================================================================

// Determine format category from extension
function getFormat(ext) {
  const lower = ext.toLowerCase();
  if (['.jpg', '.jpeg'].includes(lower)) return 'jpg';
  if (lower === '.png') return 'png';
  if (lower === '.svs') return 'svs';
  if (['.tif', '.tiff'].includes(lower)) return 'tiff';
  if (lower === '.ndpi') return 'ndpi';
  if (lower === '.mrxs') return 'mrxs';
  return 'unknown';
}

async function ensureDirectories(ingestDir, rawDir, derivedDir) {
  await mkdir(ingestDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await mkdir(derivedDir, { recursive: true });
}

// Move file across devices (copy + delete)
async function moveFile(src, dest) {
  await pipeline(
    createReadStream(src),
    createWriteStream(dest)
  );
  await unlink(src);
}

// ============================================================================
// File processing
// ============================================================================

async function processFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return;
  }

  const originalName = basename(filePath);
  const format = getFormat(ext);
  const config = getConfig();
  const stableMs = (config.stableSeconds || 15) * 1000;
  const RAW_DIR = process.env.RAW_DIR || config.rawDirContainer || '/data/raw';

  // Wait for file to be fully written
  const isWSI = WSI_EXTENSIONS.includes(ext);
  const initialWait = isWSI ? stableMs * 0.5 : stableMs * 0.25;
  await new Promise(r => setTimeout(r, initialWait));

  try {
    // Verify file still exists and is accessible
    const fileStats = await stat(filePath);

    // For large files, wait full stableSeconds and check size stability
    if (isWSI && fileStats.size > 100 * 1024 * 1024) {
      await new Promise(r => setTimeout(r, stableMs));
      const newStats = await stat(filePath);
      if (newStats.size !== fileStats.size) {
        console.log(`File ${originalName} still being written, will retry...`);
        setTimeout(() => processFile(filePath), stableMs);
        return;
      }
    }

    // Calculate slideId from file contents
    console.log(`Calculating hash for ${originalName} (${(fileStats.size / 1024 / 1024).toFixed(1)} MB)...`);
    const slideId = await hashFile(filePath);
    console.log(`Processing file: ${originalName} -> slideId: ${slideId.substring(0, 12)}... (format: ${format})`);

    // Move to RAW_DIR (uses copy+delete for cross-device support)
    const rawFileName = `${slideId}_${originalName}`;
    const rawPath = join(RAW_DIR, rawFileName);
    await moveFile(filePath, rawPath);
    console.log(`Moved to raw: ${rawPath}`);

    // Create slide record with format
    const slide = await createSlide({
      id: slideId,
      originalFilename: originalName,
      rawPath: rawPath,
      format: format
    });

    // Parse filename for PathoWeb external case linkage
    const parsed = parsePathologyFilename(originalName);
    if (parsed) {
      await updateSlide(slideId, {
        externalCaseId: parsed.externalCaseId,
        externalCaseBase: parsed.externalCaseBase,
        externalSlideLabel: parsed.label,
      });
      console.log(`PathoWeb case detected: ${parsed.caseBase} label=${parsed.label} (${originalName})`);
    }

    // Create job record
    const job = await createJob({
      slideId: slideId,
      type: 'P0'
    });

    // Enqueue P0 job with format info
    await enqueueJob({
      jobId: job.id,
      slideId: slideId,
      type: 'P0',
      rawPath: rawPath,
      format: format
    });

    console.log(`Imported slide ${slideId.substring(0, 12)}... (${originalName}) [${format}]`);

    // Emit SSE event for slide import
    eventBus.emitSlideImport(slideId, originalName, format);
  } catch (err) {
    console.error(`Error processing ${originalName}:`, err.message);
  }
}

async function scanExisting(ingestDir) {
  try {
    const files = await readdir(ingestDir);
    for (const file of files) {
      const filePath = join(ingestDir, file);
      await processFile(filePath);
    }
  } catch (err) {
    console.error('Error scanning inbox:', err.message);
  }
}

// ============================================================================
// Directory health check
// ============================================================================

function startDirHealthCheck(dirPath) {
  if (dirHealthInterval) clearInterval(dirHealthInterval);

  dirHealthInterval = setInterval(async () => {
    try {
      await access(dirPath, constants.R_OK);
      if (watcherState === 'dir_inaccessible') {
        console.log(`[Watcher] Directory ${dirPath} is accessible again`);
        watcherState = 'running';
        watcherError = null;
      }
    } catch {
      if (watcherState === 'running') {
        watcherState = 'dir_inaccessible';
        watcherError = `Directory became inaccessible: ${dirPath}`;
        console.warn(`[Watcher] ${watcherError}`);
      }
    }
  }, 30_000);
}

// ============================================================================
// Start watcher
// ============================================================================

export async function startWatcher() {
  const { config, loaded } = await loadConfig();

  const INGEST_DIR = process.env.INGEST_DIR || config.slidesDirContainer || '/data/inbox';
  const RAW_DIR = process.env.RAW_DIR || config.rawDirContainer || '/data/raw';
  const DERIVED_DIR = process.env.DERIVED_DIR || config.derivedDirContainer || '/data/derived';

  watcherIngestDir = INGEST_DIR;

  // Check if directory exists and is accessible
  try {
    await access(INGEST_DIR, constants.R_OK);
  } catch (err) {
    watcherState = 'needs_config';
    watcherError = `Inbox directory not accessible: ${INGEST_DIR}`;
    console.warn(`[Watcher] ${watcherError}`);
    console.warn('[Watcher] API will start in NEEDS_CONFIG mode. Configure via POST /v1/admin/config or run setup.js');
    startDirHealthCheck(INGEST_DIR);
    return null;
  }

  await ensureDirectories(INGEST_DIR, RAW_DIR, DERIVED_DIR);

  // Process any existing files first
  await scanExisting(INGEST_DIR);

  // Watch for new files
  const stableMs = (config.stableSeconds || 15) * 1000;
  console.log(`Watching ${INGEST_DIR} for new slides...`);
  console.log(`Stable seconds: ${config.stableSeconds || 15}s`);
  console.log(`Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`);

  fsWatcher = watch(INGEST_DIR, async (eventType, filename) => {
    if (eventType === 'rename' && filename) {
      const filePath = join(INGEST_DIR, filename);
      // Initial delay proportional to stableSeconds
      setTimeout(() => processFile(filePath), stableMs * 0.25);
    }
  });

  watcherState = 'running';
  watcherError = null;

  startDirHealthCheck(INGEST_DIR);

  return fsWatcher;
}
