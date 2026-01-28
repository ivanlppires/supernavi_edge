#!/usr/bin/env node
/**
 * Smoke Test: Publish Preview to Wasabi
 *
 * Usage:
 *   node scripts/publish_preview_smoke.js <slideId> [maxLevel]
 *
 * Environment variables required:
 *   S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_ENDPOINT, S3_REGION
 *   DATABASE_URL (for outbox event)
 *   DERIVED_DIR (where tiles/thumb/manifest are stored)
 *
 * Example:
 *   S3_ACCESS_KEY=xxx S3_SECRET_KEY=yyy PREVIEW_REMOTE_ENABLED=true \
 *   node scripts/publish_preview_smoke.js abc123def456
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { access, readFile } from 'fs/promises';

// Change to processor directory for module resolution
const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(join(__dirname, '..', 'processor'));

// Now import from processor
const { publishRemotePreview, isPreviewEnabled, getConfig, shutdown } = await import('./src/preview/index.js');

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: node scripts/publish_preview_smoke.js <slideId> [maxLevel]');
    console.log('');
    console.log('Environment variables:');
    console.log('  S3_ACCESS_KEY       - Wasabi access key');
    console.log('  S3_SECRET_KEY       - Wasabi secret key');
    console.log('  S3_BUCKET           - Bucket name (default: supernavi-eu)');
    console.log('  S3_ENDPOINT         - Wasabi endpoint (default: https://s3.eu-central-1.wasabisys.com)');
    console.log('  S3_REGION           - Region (default: eu-central-1)');
    console.log('  DATABASE_URL        - PostgreSQL connection string');
    console.log('  DERIVED_DIR         - Directory with processed slides (default: /data/derived)');
    console.log('  PREVIEW_REMOTE_ENABLED - Set to "true" to enable');
    console.log('  PREVIEW_MAX_LEVEL   - Max level to upload (default: 6)');
    process.exit(1);
  }

  const slideId = args[0];
  const maxLevel = args[1] ? parseInt(args[1], 10) : undefined;

  console.log('='.repeat(60));
  console.log('Remote Preview Publisher - Smoke Test');
  console.log('='.repeat(60));
  console.log('');

  // Check environment
  console.log('Configuration:');
  const config = getConfig();
  console.log(`  Bucket: ${config.bucket}`);
  console.log(`  Endpoint: ${config.endpoint}`);
  console.log(`  Region: ${config.region}`);
  console.log(`  Prefix: ${config.prefixBase}`);
  console.log(`  Concurrency: ${config.uploadConcurrency}`);
  console.log(`  Preview Enabled: ${isPreviewEnabled()}`);
  console.log('');

  if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
    console.error('ERROR: S3_ACCESS_KEY and S3_SECRET_KEY are required');
    process.exit(1);
  }

  // Check slide exists
  const derivedDir = process.env.DERIVED_DIR || '/data/derived';
  const slideDir = join(derivedDir, slideId);

  try {
    await access(slideDir);
  } catch {
    console.error(`ERROR: Slide directory not found: ${slideDir}`);
    console.error('Make sure the slide has been processed (P0 complete)');
    process.exit(1);
  }

  // Check required files
  const thumbPath = join(slideDir, 'thumb.jpg');
  const manifestPath = join(slideDir, 'manifest.json');

  try {
    await access(thumbPath);
    await access(manifestPath);
  } catch {
    console.error('ERROR: thumb.jpg or manifest.json not found');
    console.error('Make sure P0 processing is complete');
    process.exit(1);
  }

  // Show slide info
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  console.log('Slide Info:');
  console.log(`  ID: ${slideId}`);
  console.log(`  Dimensions: ${manifest.width}x${manifest.height}`);
  console.log(`  Max Level: ${manifest.levelMax}`);
  console.log(`  On-Demand: ${manifest.onDemand || false}`);
  console.log('');

  // Run publish
  console.log(`Publishing preview for slide ${slideId}...`);
  console.log('');

  try {
    const result = await publishRemotePreview(slideId, maxLevel);

    console.log('');
    console.log('='.repeat(60));

    if (result.published) {
      console.log('SUCCESS: Preview published!');
      console.log('');
      console.log('Result:');
      console.log(`  Event ID: ${result.eventId}`);
      console.log(`  Max Level: ${result.maxLevel}`);
      console.log(`  Tiles Uploaded: ${result.uploadStats.tilesCount}`);
      console.log(`  Total Bytes: ${result.uploadStats.totalBytes}`);
      console.log(`  Elapsed: ${result.elapsedMs}ms`);
      console.log('');
      console.log('S3 Keys:');
      console.log(`  Thumb: ${config.prefixBase}/${slideId}/thumb.jpg`);
      console.log(`  Manifest: ${config.prefixBase}/${slideId}/manifest.json`);
      console.log(`  Tiles: ${config.prefixBase}/${slideId}/tiles/{z}/{x}_{y}.jpg`);
    } else if (result.skipped) {
      console.log(`SKIPPED: ${result.reason}`);
      if (result.previousPublishAt) {
        console.log(`  Previous publish: ${result.previousPublishAt}`);
      }
    }

    console.log('='.repeat(60));

  } catch (err) {
    console.error('');
    console.error('='.repeat(60));
    console.error('FAILED:', err.message);
    console.error('='.repeat(60));
    console.error('');
    console.error('Stack trace:');
    console.error(err.stack);
    process.exit(1);
  } finally {
    await shutdown();
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
