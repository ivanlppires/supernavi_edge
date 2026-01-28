#!/usr/bin/env node
/**
 * Test: Rebased Preview Generation (local only, no S3 upload)
 *
 * Usage:
 *   node scripts/test_rebased_preview.js <slideId> [maxLevel] [targetMaxDim]
 *
 * Or from SVS file path (extracts slideId from filename):
 *   node scripts/test_rebased_preview.js samples/_20250912163526.svs
 *
 * Environment variables:
 *   DERIVED_DIR - Where processed slides are (default: ./data/derived)
 *   RAW_DIR     - Where raw files are (default: ./data/raw)
 *
 * Example:
 *   node scripts/test_rebased_preview.js abc123def456
 *   node scripts/test_rebased_preview.js abc123def456 6 2048
 */

import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { readdir, readFile, access } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Set defaults for local testing
process.env.DERIVED_DIR = process.env.DERIVED_DIR || join(projectRoot, 'data', 'derived');
process.env.RAW_DIR = process.env.RAW_DIR || join(projectRoot, 'data', 'raw');

// Import the module
const {
  generateRebasedPreviewTiles,
  calculateRebasedDimensions,
  countRebasedTiles,
  getRebasedConfig,
  hasRebasedPreviewTiles
} = await import('../processor/src/preview/rebasedPreview.js');

async function findSlideIdFromPath(inputPath) {
  // If it looks like a slideId (64 hex chars), use it directly
  if (/^[a-f0-9]{64}$/.test(inputPath)) {
    return inputPath;
  }

  // Check if it's a file path ending in .svs or similar
  if (inputPath.includes('/') || inputPath.includes('\\') || inputPath.match(/\.(svs|ndpi|tiff?|mrxs)$/i)) {
    // Look for processed slides in derived dir
    const derivedDir = process.env.DERIVED_DIR;
    const dirs = await readdir(derivedDir);

    // Try to match by filename
    const filename = basename(inputPath);
    for (const dir of dirs) {
      if (dir.length === 64) {
        // Check raw dir for matching filename
        const rawDir = process.env.RAW_DIR;
        const rawFiles = await readdir(rawDir);
        for (const rawFile of rawFiles) {
          if (rawFile.startsWith(dir) && rawFile.includes(filename.replace(/\.[^.]+$/, ''))) {
            return dir;
          }
        }
      }
    }

    // If no match, list available slides
    console.log('Available processed slides:');
    for (const dir of dirs.filter(d => d.length === 64)) {
      console.log(`  ${dir}`);
    }
    throw new Error(`Could not find processed slide for: ${inputPath}`);
  }

  // Assume it's a partial slideId - find matching dir
  const derivedDir = process.env.DERIVED_DIR;
  const dirs = await readdir(derivedDir);
  const matches = dirs.filter(d => d.startsWith(inputPath));

  if (matches.length === 1) {
    return matches[0];
  } else if (matches.length > 1) {
    console.log('Multiple matches found:');
    matches.forEach(m => console.log(`  ${m}`));
    throw new Error('Ambiguous slideId prefix');
  }

  throw new Error(`No slide found matching: ${inputPath}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: node scripts/test_rebased_preview.js <slideId|path> [maxLevel] [targetMaxDim]');
    console.log('');
    console.log('Arguments:');
    console.log('  slideId|path   - Slide ID (SHA256 hash) or path to SVS file');
    console.log('  maxLevel       - Max preview level (default: 6)');
    console.log('  targetMaxDim   - Target max dimension (default: 2048)');
    console.log('');
    console.log('Environment:');
    console.log(`  DERIVED_DIR = ${process.env.DERIVED_DIR}`);
    console.log(`  RAW_DIR     = ${process.env.RAW_DIR}`);
    console.log('');

    // List available slides
    try {
      const derivedDir = process.env.DERIVED_DIR;
      const dirs = await readdir(derivedDir);
      const slides = dirs.filter(d => d.length === 64);
      if (slides.length > 0) {
        console.log('Available slides:');
        for (const slideId of slides) {
          try {
            const manifestPath = join(derivedDir, slideId, 'manifest.json');
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            console.log(`  ${slideId.substring(0, 12)}... (${manifest.width}x${manifest.height})`);
          } catch {
            console.log(`  ${slideId.substring(0, 12)}... (manifest not found)`);
          }
        }
      }
    } catch {}

    process.exit(1);
  }

  const input = args[0];
  const maxLevel = args[1] ? parseInt(args[1], 10) : 6;
  const targetMaxDim = args[2] ? parseInt(args[2], 10) : 2048;

  console.log('='.repeat(70));
  console.log('Rebased Preview Test');
  console.log('='.repeat(70));
  console.log('');
  console.log(`[${new Date().toISOString()}] Starting...`);
  console.log('');

  // Resolve slideId
  let slideId;
  try {
    slideId = await findSlideIdFromPath(input);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }

  console.log('Configuration:');
  const config = getRebasedConfig();
  console.log(`  slideId:      ${slideId}`);
  console.log(`  maxLevel:     ${maxLevel}`);
  console.log(`  targetMaxDim: ${targetMaxDim}`);
  console.log(`  tileSize:     ${config.tileSize}`);
  console.log(`  DERIVED_DIR:  ${process.env.DERIVED_DIR}`);
  console.log(`  RAW_DIR:      ${process.env.RAW_DIR}`);
  console.log('');

  // Check slide exists
  const slideDir = join(process.env.DERIVED_DIR, slideId);
  const manifestPath = join(slideDir, 'manifest.json');

  try {
    await access(manifestPath);
  } catch {
    console.error(`ERROR: Manifest not found: ${manifestPath}`);
    console.error('Make sure the slide has been processed (P0 complete)');
    process.exit(1);
  }

  // Load manifest
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  console.log('Original Image:');
  console.log(`  Width:    ${manifest.width}`);
  console.log(`  Height:   ${manifest.height}`);
  console.log(`  MaxLevel: ${manifest.levelMax}`);
  console.log(`  OnDemand: ${manifest.onDemand || false}`);
  console.log('');

  // Calculate rebased dimensions
  const rebased = calculateRebasedDimensions(manifest.width, manifest.height, targetMaxDim);
  console.log('Rebased Dimensions (preview):');
  console.log(`  Width:  ${rebased.width}`);
  console.log(`  Height: ${rebased.height}`);
  console.log(`  Scale:  ${rebased.scale.toFixed(3)}x`);
  console.log('');

  // Calculate expected tiles
  const expectedTiles = countRebasedTiles(rebased.width, rebased.height, maxLevel);
  console.log(`Expected tiles for levels 0..${maxLevel}: ${expectedTiles}`);
  console.log('');

  // Check if already exists
  const hasExisting = await hasRebasedPreviewTiles(slideId);
  if (hasExisting) {
    console.log('NOTE: Preview tiles already exist, will be regenerated');
    console.log('');
  }

  // Generate!
  console.log('='.repeat(70));
  console.log(`[${new Date().toISOString()}] Generating rebased preview tiles...`);
  console.log('='.repeat(70));
  console.log('');

  const startTime = Date.now();

  try {
    const result = await generateRebasedPreviewTiles(slideId, maxLevel, targetMaxDim);

    const elapsed = Date.now() - startTime;

    console.log('');
    console.log('='.repeat(70));
    console.log(`[${new Date().toISOString()}] Complete!`);
    console.log('='.repeat(70));
    console.log('');
    console.log('Result:');
    console.log(`  Rebased Size: ${result.rebasedWidth}x${result.rebasedHeight}`);
    console.log(`  Scale Factor: ${result.scale.toFixed(3)}x`);
    console.log(`  Total Tiles:  ${result.generated} (expected: ${result.totalTiles})`);
    console.log(`  Elapsed:      ${elapsed}ms`);
    console.log('');
    console.log('Tiles by level:');
    for (let z = 0; z <= maxLevel; z++) {
      const levelInfo = result.byLevel[z] || { tiles: 0 };
      console.log(`  Level ${z}: ${levelInfo.tiles} tiles`);
    }
    console.log('');
    console.log('Output directory:');
    console.log(`  ${join(slideDir, 'preview_tiles')}`);
    console.log('');

  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('');
    console.error('='.repeat(70));
    console.error(`[${new Date().toISOString()}] FAILED after ${elapsed}ms`);
    console.error('='.repeat(70));
    console.error('');
    console.error('Error:', err.message);
    console.error('');
    console.error('Stack trace:');
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
