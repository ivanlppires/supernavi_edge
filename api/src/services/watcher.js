import { watch } from 'fs';
import { readdir, rename, mkdir, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import { hashFile } from '../lib/hash.js';
import { enqueueJob } from '../lib/queue.js';
import { createSlide, createJob } from '../db/slides.js';

// Supported formats by category
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const WSI_EXTENSIONS = ['.svs', '.tif', '.tiff', '.ndpi', '.mrxs'];
const SUPPORTED_EXTENSIONS = [...IMAGE_EXTENSIONS, ...WSI_EXTENSIONS];

const INGEST_DIR = process.env.INGEST_DIR || '/data/inbox';
const RAW_DIR = process.env.RAW_DIR || '/data/raw';
const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

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

async function ensureDirectories() {
  await mkdir(INGEST_DIR, { recursive: true });
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(DERIVED_DIR, { recursive: true });
}

async function processFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return;
  }

  const originalName = basename(filePath);
  const format = getFormat(ext);

  // Wait for file to be fully written (longer for large WSI files)
  const isWSI = WSI_EXTENSIONS.includes(ext);
  await new Promise(r => setTimeout(r, isWSI ? 2000 : 500));

  try {
    // Verify file still exists and is accessible
    const fileStats = await stat(filePath);

    // For large files, wait a bit more and check if size is stable
    if (isWSI && fileStats.size > 100 * 1024 * 1024) {
      await new Promise(r => setTimeout(r, 3000));
      const newStats = await stat(filePath);
      if (newStats.size !== fileStats.size) {
        console.log(`File ${originalName} still being written, will retry...`);
        setTimeout(() => processFile(filePath), 5000);
        return;
      }
    }

    // Calculate slideId from file contents
    console.log(`Calculating hash for ${originalName} (${(fileStats.size / 1024 / 1024).toFixed(1)} MB)...`);
    const slideId = await hashFile(filePath);
    console.log(`Processing file: ${originalName} -> slideId: ${slideId.substring(0, 12)}... (format: ${format})`);

    // Move to RAW_DIR
    const rawFileName = `${slideId}_${originalName}`;
    const rawPath = join(RAW_DIR, rawFileName);
    await rename(filePath, rawPath);
    console.log(`Moved to raw: ${rawPath}`);

    // Create slide record with format
    const slide = await createSlide({
      id: slideId,
      originalFilename: originalName,
      rawPath: rawPath,
      format: format
    });

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
  } catch (err) {
    console.error(`Error processing ${originalName}:`, err.message);
  }
}

async function scanExisting() {
  try {
    const files = await readdir(INGEST_DIR);
    for (const file of files) {
      const filePath = join(INGEST_DIR, file);
      await processFile(filePath);
    }
  } catch (err) {
    console.error('Error scanning inbox:', err.message);
  }
}

export async function startWatcher() {
  await ensureDirectories();

  // Process any existing files first
  await scanExisting();

  // Watch for new files
  console.log(`Watching ${INGEST_DIR} for new slides...`);
  console.log(`Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`);

  const watcher = watch(INGEST_DIR, async (eventType, filename) => {
    if (eventType === 'rename' && filename) {
      const filePath = join(INGEST_DIR, filename);
      // Small delay to ensure file is fully written
      setTimeout(() => processFile(filePath), 1000);
    }
  });

  return watcher;
}
