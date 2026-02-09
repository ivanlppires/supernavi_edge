#!/usr/bin/env node
/**
 * Wasabi S3 Cleanup Script
 *
 * Deletes all preview data from Wasabi S3 bucket.
 * Run with: node processor/src/cleanup-wasabi.js
 *
 * Or via Docker: docker compose exec processor node src/cleanup-wasabi.js
 */

import { deleteAllPreviews, listAllPreviews, getConfig } from './preview/wasabiUploader.js';

async function main() {
  console.log('='.repeat(60));
  console.log('SuperNavi Wasabi S3 Cleanup');
  console.log('='.repeat(60));

  const config = getConfig();
  console.log('\nConfiguration:');
  console.log(`  Bucket: ${config.bucket}`);
  console.log(`  Endpoint: ${config.endpoint}`);
  console.log(`  Prefix: ${config.prefixBase}/`);

  try {
    // First list what we'll delete
    console.log('\nScanning for existing previews...');
    const slideIds = await listAllPreviews();

    if (slideIds.length === 0) {
      console.log('\nNo previews found in bucket. Nothing to delete.');
      process.exit(0);
    }

    console.log(`\nFound ${slideIds.length} slides with previews:`);
    for (const id of slideIds.slice(0, 10)) {
      console.log(`  - ${id}`);
    }
    if (slideIds.length > 10) {
      console.log(`  ... and ${slideIds.length - 10} more`);
    }

    // Delete all
    console.log('\nDeleting all previews...');
    const result = await deleteAllPreviews();

    console.log('\n' + '='.repeat(60));
    console.log('Cleanup Complete');
    console.log('='.repeat(60));
    console.log(`  Slides processed: ${result.slideCount}`);
    console.log(`  Objects deleted: ${result.totalDeleted}`);
    console.log(`  Errors: ${result.totalErrors}`);

    process.exit(result.totalErrors > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nError during cleanup:', err.message);
    process.exit(1);
  }
}

main();
