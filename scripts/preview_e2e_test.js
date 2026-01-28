#!/usr/bin/env node
/**
 * Preview End-to-End Test Script
 *
 * Performs a complete test of the preview publishing pipeline:
 * 1. Generate rebased preview tiles locally
 * 2. Verify local tiles (count, size > 0)
 * 3. Upload to Wasabi S3
 * 4. Verify remote tiles (LIST + HEAD requests)
 * 5. Compare local vs remote
 *
 * Usage:
 *   node scripts/preview_e2e_test.js <slideId> [maxLevel]
 *
 * Environment variables:
 *   S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_ENDPOINT, S3_REGION
 *   DATABASE_URL
 *   DERIVED_DIR, RAW_DIR
 *   PREVIEW_REMOTE_ENABLED=true (required for upload)
 *
 * Example:
 *   PREVIEW_REMOTE_ENABLED=true S3_ACCESS_KEY=xxx S3_SECRET_KEY=yyy \
 *   node scripts/preview_e2e_test.js f41fa55d4f2478bbff5e9192b1031fcc19f9513b24708961121012492e0bfe3b
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, readdir } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Change to processor directory for module resolution
process.chdir(join(__dirname, '..', 'processor'));

// Import preview modules
const {
  generateRebasedPreviewTiles,
  getRebasedConfig,
  publishRemotePreview,
  isPreviewEnabled,
  getConfig,
  shutdown
} = await import('./src/preview/index.js');

const {
  verifyLocalTiles,
  verifyRemoteTiles,
  verifySampleTilesHEAD,
  compareLocalRemote,
  runFullIntegrityCheck
} = await import('./src/preview/integrityCheck.js');

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: node scripts/preview_e2e_test.js <slideId> [maxLevel]');
    console.log('');
    console.log('Environment variables required:');
    console.log('  S3_ACCESS_KEY, S3_SECRET_KEY - Wasabi credentials');
    console.log('  PREVIEW_REMOTE_ENABLED=true - Enable upload');
    console.log('');
    console.log('Optional:');
    console.log('  S3_BUCKET, S3_ENDPOINT, S3_REGION');
    console.log('  PREVIEW_MAX_LEVEL (default: 6)');
    console.log('  PREVIEW_TARGET_MAX_DIM (default: 2048)');
    console.log('');

    // List available slides
    try {
      const dirs = await readdir(DERIVED_DIR);
      const slides = dirs.filter(d => d.length === 64);
      if (slides.length > 0) {
        console.log('Available slides:');
        for (const slideId of slides) {
          const manifestPath = join(DERIVED_DIR, slideId, 'manifest.json');
          try {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            console.log(`  ${slideId.substring(0, 16)}... (${manifest.width}x${manifest.height})`);
          } catch {
            console.log(`  ${slideId.substring(0, 16)}...`);
          }
        }
      }
    } catch {}

    process.exit(1);
  }

  const slideId = args[0];
  const maxLevel = args[1] ? parseInt(args[1], 10) : 6;

  console.log('');
  console.log('='.repeat(80));
  console.log('PREVIEW END-TO-END TEST');
  console.log('='.repeat(80));
  console.log('');
  console.log(`[${new Date().toISOString()}] Starting test`);
  console.log('');

  // Show configuration
  console.log('Configuration:');
  console.log(`  Slide ID: ${slideId}`);
  console.log(`  Max Level: ${maxLevel}`);
  console.log(`  Rebased Config: ${JSON.stringify(getRebasedConfig())}`);
  console.log(`  S3 Config: ${JSON.stringify(getConfig())}`);
  console.log(`  Preview Enabled: ${isPreviewEnabled()}`);
  console.log('');

  // Verify credentials
  if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
    console.error('ERROR: S3_ACCESS_KEY and S3_SECRET_KEY are required');
    process.exit(1);
  }

  const s3Config = {
    ...getConfig(),
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false'
  };

  // Load manifest
  const manifestPath = join(DERIVED_DIR, slideId, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Could not read manifest: ${err.message}`);
    console.error(`Make sure P0 processing is complete for ${slideId}`);
    process.exit(1);
  }

  console.log('Original Slide:');
  console.log(`  Dimensions: ${manifest.width}x${manifest.height}`);
  console.log(`  Max Level: ${manifest.levelMax}`);
  console.log('');

  const startTime = Date.now();
  let success = true;

  try {
    // =========================================================================
    // STEP 1: Generate rebased preview tiles
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[STEP 1] Generate rebased preview tiles');
    console.log('='.repeat(80));
    console.log('');

    const genStart = Date.now();
    const tileStats = await generateRebasedPreviewTiles(slideId, maxLevel);
    const genElapsed = Date.now() - genStart;

    console.log('');
    console.log(`  Result: ${tileStats.generated} tiles generated in ${genElapsed}ms`);
    console.log(`  Rebased: ${tileStats.rebasedWidth}x${tileStats.rebasedHeight}`);
    console.log(`  Scale: ${tileStats.scale.toFixed(3)}x`);
    console.log('');

    // =========================================================================
    // STEP 2: Verify local tiles
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[STEP 2] Verify local tiles');
    console.log('='.repeat(80));

    const localResults = await verifyLocalTiles(slideId, maxLevel);

    console.log('');
    console.log(`  Total local tiles: ${localResults.totalTiles}`);
    console.log(`  Total bytes: ${formatBytes(localResults.totalBytes)}`);
    console.log(`  Status: ${localResults.success ? 'OK' : 'ERRORS'}`);

    if (!localResults.success) {
      console.error('  Errors:', localResults.errors.slice(0, 5).join('\n    '));
      success = false;
    }
    console.log('');

    // Expected tile counts
    const expectedCounts = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 4, 5: 16, 6: 64 };
    console.log('  Tile counts by level:');
    for (let z = 0; z <= maxLevel; z++) {
      const level = localResults.levels[z];
      const expected = expectedCounts[z] || '?';
      const match = level.tileCount === expected ? 'OK' : `EXPECTED ${expected}`;
      console.log(`    Level ${z}: ${level.tileCount} tiles [${match}]`);
    }
    console.log('');

    // =========================================================================
    // STEP 3: Upload to Wasabi (full publish)
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[STEP 3] Upload to Wasabi S3');
    console.log('='.repeat(80));
    console.log('');

    if (!isPreviewEnabled()) {
      console.warn('  WARNING: PREVIEW_REMOTE_ENABLED is not true, upload will be skipped');
      console.warn('  Set PREVIEW_REMOTE_ENABLED=true to enable upload');
    }

    const publishStart = Date.now();
    const publishResult = await publishRemotePreview(slideId, maxLevel);
    const publishElapsed = Date.now() - publishStart;

    console.log('');
    if (publishResult.published) {
      console.log(`  Publish complete in ${publishElapsed}ms`);
      console.log(`  Event ID: ${publishResult.eventId}`);
      console.log(`  Tiles uploaded: ${publishResult.uploadStats?.tilesCount || 0}`);
      console.log(`  Total bytes: ${formatBytes(publishResult.uploadStats?.totalBytes || 0)}`);
    } else if (publishResult.skipped) {
      console.log(`  Skipped: ${publishResult.reason}`);
    }
    console.log('');

    // =========================================================================
    // STEP 4: Verify remote tiles
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[STEP 4] Verify remote tiles in S3');
    console.log('='.repeat(80));

    const remoteResults = await verifyRemoteTiles(slideId, maxLevel, s3Config);

    console.log('');
    console.log(`  Total remote tiles: ${remoteResults.totalFound}`);
    console.log(`  Status: ${remoteResults.success ? 'OK' : 'ERRORS'}`);

    if (!remoteResults.success) {
      console.error('  Errors:', remoteResults.errors.slice(0, 5).join('\n    '));
      success = false;
    }
    console.log('');

    // =========================================================================
    // STEP 5: Compare local vs remote
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[STEP 5] Compare local vs remote');
    console.log('='.repeat(80));

    const comparison = await compareLocalRemote(localResults, remoteResults);

    console.log('');
    console.log(`  Match: ${comparison.success ? 'YES' : 'NO'}`);

    if (!comparison.success) {
      console.error(`  Missing in remote: ${comparison.missingRemote.length} tiles`);
      if (comparison.missingRemote.length > 0) {
        console.error('  Missing tiles (first 10):');
        for (const missing of comparison.missingRemote.slice(0, 10)) {
          console.error(`    Level ${missing.level}: ${missing.tile}`);
        }
      }
      success = false;
    }
    console.log('');

    // =========================================================================
    // STEP 6: HEAD verification for sample tiles
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[STEP 6] HEAD verification for sample tiles');
    console.log('='.repeat(80));

    const headResults = await verifySampleTilesHEAD(slideId, maxLevel, s3Config, 3);

    console.log('');
    console.log(`  Checks performed: ${headResults.checks.length}`);
    console.log(`  Status: ${headResults.success ? 'ALL OK' : 'SOME FAILED'}`);

    if (!headResults.success) {
      console.error('  Failed checks:');
      for (const check of headResults.checks.filter(c => !c.exists)) {
        console.error(`    ${check.key}: ${check.error}`);
      }
      success = false;
    }
    console.log('');

  } catch (err) {
    console.error('');
    console.error('='.repeat(80));
    console.error('ERROR');
    console.error('='.repeat(80));
    console.error(`  ${err.message}`);
    console.error('');
    console.error('Stack trace:');
    console.error(err.stack);
    success = false;
  } finally {
    await shutdown();
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  const totalElapsed = Date.now() - startTime;

  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log('');
  console.log(`  Slide: ${slideId}`);
  console.log(`  Status: ${success ? 'SUCCESS' : 'FAILED'}`);
  console.log(`  Total time: ${totalElapsed}ms`);
  console.log('');
  console.log(`[${new Date().toISOString()}] Test complete`);
  console.log('');

  // Sample URLs for manual verification
  if (success) {
    const config = getConfig();
    console.log('Sample URLs for verification:');
    console.log(`  Thumb: ${config.endpoint}/${config.bucket}/${config.prefixBase}/${slideId}/thumb.jpg`);
    console.log(`  Manifest: ${config.endpoint}/${config.bucket}/${config.prefixBase}/${slideId}/manifest.json`);
    console.log(`  Tile L0: ${config.endpoint}/${config.bucket}/${config.prefixBase}/${slideId}/tiles/0/0_0.jpg`);
    console.log(`  Tile L5: ${config.endpoint}/${config.bucket}/${config.prefixBase}/${slideId}/tiles/5/0_0.jpg`);
    console.log(`  Tile L6: ${config.endpoint}/${config.bucket}/${config.prefixBase}/${slideId}/tiles/6/0_0.jpg`);
    console.log('');
  }

  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
