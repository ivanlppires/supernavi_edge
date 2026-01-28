/**
 * Preview Integrity Check
 *
 * Validates that all preview tiles exist locally and remotely (S3).
 * Used to diagnose upload issues and ensure complete publishing.
 */

import { S3Client, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { readdir, stat, access } from 'fs/promises';
import { join } from 'path';

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

// Expected tile counts per level for rebased 2048px preview (levels 0-6)
const EXPECTED_TILE_COUNTS = {
  // For a ~2048x2048 image with 256px tiles:
  // Level 6: 8x8 = 64 tiles (full res)
  // Level 5: 4x4 = 16 tiles
  // Level 4: 2x2 = 4 tiles
  // Level 3: 1x1 = 1 tile
  // Level 2: 1x1 = 1 tile
  // Level 1: 1x1 = 1 tile
  // Level 0: 1x1 = 1 tile
};

/**
 * Check if file/directory exists
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Calculate expected tile count for a level
 */
export function calculateExpectedTiles(width, height, level, maxLevel) {
  const scale = Math.pow(2, maxLevel - level);
  const levelWidth = Math.ceil(width / scale);
  const levelHeight = Math.ceil(height / scale);
  const tileSize = 256;

  const tilesX = Math.ceil(levelWidth / tileSize);
  const tilesY = Math.ceil(levelHeight / tileSize);

  return { tilesX, tilesY, total: tilesX * tilesY, levelWidth, levelHeight };
}

/**
 * Verify local tiles exist and have content
 */
export async function verifyLocalTiles(slideId, maxLevel = 6) {
  const previewTilesDir = join(DERIVED_DIR, slideId, 'preview_tiles');
  const results = {
    success: true,
    slideId,
    maxLevel,
    previewTilesDir,
    levels: {},
    totalTiles: 0,
    totalBytes: 0,
    errors: [],
    warnings: []
  };

  console.log(`\n[IntegrityCheck] Verifying local tiles for ${slideId}`);
  console.log(`  Directory: ${previewTilesDir}`);

  // Check base directory exists
  if (!(await exists(previewTilesDir))) {
    results.success = false;
    results.errors.push(`preview_tiles directory does not exist: ${previewTilesDir}`);
    return results;
  }

  for (let z = 0; z <= maxLevel; z++) {
    const levelDir = join(previewTilesDir, String(z));
    const levelResult = {
      level: z,
      directory: levelDir,
      exists: false,
      tiles: [],
      tileCount: 0,
      totalBytes: 0,
      errors: [],
      emptyFiles: []
    };

    // Check level directory exists
    if (!(await exists(levelDir))) {
      levelResult.errors.push(`Level directory does not exist`);
      results.errors.push(`Level ${z}: directory missing at ${levelDir}`);
      results.success = false;
      results.levels[z] = levelResult;
      continue;
    }

    levelResult.exists = true;

    // List files in level directory
    let files;
    try {
      files = await readdir(levelDir);
    } catch (err) {
      levelResult.errors.push(`Failed to read directory: ${err.message}`);
      results.errors.push(`Level ${z}: failed to read directory - ${err.message}`);
      results.success = false;
      results.levels[z] = levelResult;
      continue;
    }

    // Check each tile file
    const jpgFiles = files.filter(f => f.endsWith('.jpg'));

    for (const file of jpgFiles) {
      const match = file.match(/^(\d+)_(\d+)\.jpg$/);
      if (!match) {
        results.warnings.push(`Level ${z}: unexpected filename format: ${file}`);
        continue;
      }

      const x = parseInt(match[1], 10);
      const y = parseInt(match[2], 10);
      const filePath = join(levelDir, file);

      try {
        const stats = await stat(filePath);

        if (stats.size === 0) {
          levelResult.emptyFiles.push(file);
          results.errors.push(`Level ${z}: empty file ${file}`);
          results.success = false;
        } else {
          levelResult.tiles.push({ x, y, file, bytes: stats.size });
          levelResult.tileCount++;
          levelResult.totalBytes += stats.size;
        }
      } catch (err) {
        levelResult.errors.push(`Failed to stat ${file}: ${err.message}`);
        results.errors.push(`Level ${z}: failed to stat ${file} - ${err.message}`);
        results.success = false;
      }
    }

    results.levels[z] = levelResult;
    results.totalTiles += levelResult.tileCount;
    results.totalBytes += levelResult.totalBytes;

    console.log(`  Level ${z}: ${levelResult.tileCount} tiles (${levelResult.totalBytes} bytes)${levelResult.errors.length > 0 ? ' [ERRORS]' : ''}`);
  }

  return results;
}

/**
 * Verify tiles exist in S3/Wasabi
 * Checks the standard DZI tiles/ path (not preview_tiles/)
 */
export async function verifyRemoteTiles(slideId, maxLevel = 6, config) {
  // FIXED: Use tiles/ path to match upload and viewer expectation
  const results = {
    success: true,
    slideId,
    maxLevel,
    bucket: config.bucket,
    prefix: `${config.prefixBase}/${slideId}/tiles/`,
    levels: {},
    totalFound: 0,
    totalMissing: 0,
    errors: [],
    missingTiles: []
  };

  console.log(`\n[IntegrityCheck] Verifying remote tiles in S3`);
  console.log(`  Bucket: ${config.bucket}`);
  console.log(`  Endpoint: ${config.endpoint}`);
  console.log(`  Prefix: ${results.prefix}`);

  const s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: config.forcePathStyle !== false
  });

  // List all objects under the preview_tiles prefix
  const allObjects = new Map();
  let continuationToken = undefined;

  try {
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: results.prefix,
        ContinuationToken: continuationToken
      });

      const response = await s3Client.send(listCommand);

      for (const obj of (response.Contents || [])) {
        allObjects.set(obj.Key, { size: obj.Size, key: obj.Key });
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    console.log(`  Found ${allObjects.size} objects in S3`);

  } catch (err) {
    results.success = false;
    results.errors.push(`Failed to list S3 objects: ${err.message}`);
    console.error(`  ERROR: Failed to list S3 objects: ${err.message}`);
    return results;
  }

  // Check each level
  for (let z = 0; z <= maxLevel; z++) {
    const levelResult = {
      level: z,
      prefix: `${results.prefix}${z}/`,
      found: 0,
      missing: [],
      tiles: []
    };

    // Find all tiles for this level
    for (const [key, info] of allObjects) {
      if (key.startsWith(levelResult.prefix)) {
        const filename = key.slice(levelResult.prefix.length);
        const match = filename.match(/^(\d+)_(\d+)\.jpg$/);
        if (match) {
          levelResult.found++;
          levelResult.tiles.push({
            x: parseInt(match[1], 10),
            y: parseInt(match[2], 10),
            key,
            size: info.size
          });
        }
      }
    }

    results.levels[z] = levelResult;
    results.totalFound += levelResult.found;

    console.log(`  Level ${z}: ${levelResult.found} tiles in S3`);
  }

  return results;
}

/**
 * Compare local vs remote tiles and report discrepancies
 */
export async function compareLocalRemote(localResults, remoteResults) {
  const comparison = {
    success: true,
    slideId: localResults.slideId,
    local: {
      totalTiles: localResults.totalTiles,
      totalBytes: localResults.totalBytes
    },
    remote: {
      totalTiles: remoteResults.totalFound
    },
    levels: {},
    missingRemote: [],
    extraRemote: []
  };

  console.log(`\n[IntegrityCheck] Comparing local vs remote`);

  for (let z = 0; z <= localResults.maxLevel; z++) {
    const local = localResults.levels[z] || { tiles: [], tileCount: 0 };
    const remote = remoteResults.levels[z] || { tiles: [], found: 0 };

    const localSet = new Set(local.tiles.map(t => `${t.x}_${t.y}`));
    const remoteSet = new Set(remote.tiles.map(t => `${t.x}_${t.y}`));

    const missing = [...localSet].filter(t => !remoteSet.has(t));
    const extra = [...remoteSet].filter(t => !localSet.has(t));

    const levelComparison = {
      level: z,
      localCount: local.tileCount,
      remoteCount: remote.found,
      match: missing.length === 0 && extra.length === 0,
      missing,
      extra
    };

    if (missing.length > 0) {
      comparison.success = false;
      comparison.missingRemote.push(...missing.map(t => ({ level: z, tile: t })));
      console.log(`  Level ${z}: LOCAL=${local.tileCount} REMOTE=${remote.found} MISSING=${missing.length} [MISMATCH]`);
      console.log(`    Missing tiles: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`);
    } else {
      console.log(`  Level ${z}: LOCAL=${local.tileCount} REMOTE=${remote.found} [OK]`);
    }

    comparison.levels[z] = levelComparison;
  }

  return comparison;
}

/**
 * Verify a sample of tiles with HEAD requests
 */
export async function verifySampleTilesHEAD(slideId, maxLevel, config, samplesPerLevel = 2) {
  const results = {
    success: true,
    slideId,
    checks: [],
    errors: []
  };

  console.log(`\n[IntegrityCheck] Verifying sample tiles with HEAD requests`);

  const s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: config.forcePathStyle !== false
  });

  // Check thumb and manifest first
  const fixedFiles = [
    { key: `${config.prefixBase}/${slideId}/thumb.jpg`, name: 'thumb.jpg' },
    { key: `${config.prefixBase}/${slideId}/manifest.json`, name: 'manifest.json' }
  ];

  for (const file of fixedFiles) {
    try {
      const cmd = new HeadObjectCommand({ Bucket: config.bucket, Key: file.key });
      const resp = await s3Client.send(cmd);
      results.checks.push({
        type: 'fixed',
        key: file.key,
        name: file.name,
        exists: true,
        size: resp.ContentLength,
        contentType: resp.ContentType
      });
      console.log(`  ${file.name}: OK (${resp.ContentLength} bytes, ${resp.ContentType})`);
    } catch (err) {
      results.success = false;
      results.errors.push(`${file.name}: ${err.message}`);
      results.checks.push({
        type: 'fixed',
        key: file.key,
        name: file.name,
        exists: false,
        error: err.message
      });
      console.log(`  ${file.name}: MISSING - ${err.message}`);
    }
  }

  // Sample tiles from each level
  for (let z = 0; z <= maxLevel; z++) {
    // Check tile at (0,0) which should always exist
    const sampleCoords = [{ x: 0, y: 0 }];

    // Add a few more samples for higher levels
    if (z >= 4) {
      sampleCoords.push({ x: 0, y: 1 }, { x: 1, y: 0 });
    }
    if (z >= 5) {
      sampleCoords.push({ x: 1, y: 1 }, { x: 2, y: 0 });
    }

    for (const coord of sampleCoords.slice(0, samplesPerLevel)) {
      // FIXED: Use tiles/ path to match upload and viewer expectation
      const key = `${config.prefixBase}/${slideId}/tiles/${z}/${coord.x}_${coord.y}.jpg`;

      try {
        const cmd = new HeadObjectCommand({ Bucket: config.bucket, Key: key });
        const resp = await s3Client.send(cmd);
        results.checks.push({
          type: 'tile',
          level: z,
          x: coord.x,
          y: coord.y,
          key,
          exists: true,
          size: resp.ContentLength,
          contentType: resp.ContentType
        });
        console.log(`  Level ${z} (${coord.x},${coord.y}): OK (${resp.ContentLength} bytes)`);
      } catch (err) {
        results.success = false;
        results.errors.push(`Level ${z} (${coord.x},${coord.y}): ${err.message}`);
        results.checks.push({
          type: 'tile',
          level: z,
          x: coord.x,
          y: coord.y,
          key,
          exists: false,
          error: err.message
        });
        console.log(`  Level ${z} (${coord.x},${coord.y}): MISSING - ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * Full integrity check pipeline
 */
export async function runFullIntegrityCheck(slideId, maxLevel, s3Config) {
  console.log('='.repeat(70));
  console.log(`[IntegrityCheck] Full integrity check for ${slideId}`);
  console.log('='.repeat(70));

  const startTime = Date.now();

  // 1. Verify local tiles
  const localResults = await verifyLocalTiles(slideId, maxLevel);

  // 2. Verify remote tiles (if S3 config provided)
  let remoteResults = null;
  let comparison = null;
  let headResults = null;

  if (s3Config && s3Config.accessKeyId && s3Config.secretAccessKey) {
    remoteResults = await verifyRemoteTiles(slideId, maxLevel, s3Config);
    comparison = await compareLocalRemote(localResults, remoteResults);
    headResults = await verifySampleTilesHEAD(slideId, maxLevel, s3Config);
  } else {
    console.log('\n[IntegrityCheck] Skipping remote verification (no S3 credentials)');
  }

  const elapsed = Date.now() - startTime;

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('[IntegrityCheck] Summary');
  console.log('='.repeat(70));
  console.log(`  Local tiles: ${localResults.totalTiles} (${localResults.totalBytes} bytes)`);
  console.log(`  Local status: ${localResults.success ? 'OK' : 'ERRORS FOUND'}`);

  if (remoteResults) {
    console.log(`  Remote tiles: ${remoteResults.totalFound}`);
    console.log(`  Remote status: ${remoteResults.success ? 'OK' : 'ERRORS FOUND'}`);
  }

  if (comparison) {
    console.log(`  Comparison: ${comparison.success ? 'MATCH' : 'MISMATCH'}`);
    if (!comparison.success) {
      console.log(`  Missing in remote: ${comparison.missingRemote.length} tiles`);
    }
  }

  if (headResults) {
    console.log(`  HEAD checks: ${headResults.success ? 'ALL OK' : 'SOME FAILED'}`);
  }

  console.log(`  Elapsed: ${elapsed}ms`);
  console.log('='.repeat(70));

  return {
    slideId,
    maxLevel,
    local: localResults,
    remote: remoteResults,
    comparison,
    headChecks: headResults,
    success: localResults.success && (!comparison || comparison.success) && (!headResults || headResults.success),
    elapsedMs: elapsed
  };
}
