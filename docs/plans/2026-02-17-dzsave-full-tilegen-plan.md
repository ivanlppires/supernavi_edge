# Full Tile Pre-generation with `vips dzsave` - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace slow per-tile on-demand generation with a single `vips dzsave` pass that pre-generates ALL DeepZoom tiles after P0, so navigation at any zoom level is instant.

**Architecture:** After P0 (instant open), a TILEGEN background job runs `vips dzsave` on the original SVS file to generate the full tile pyramid (~3000-5000 tiles in 30-120s). On-demand generation remains as fallback during/after the dzsave window. An atomic directory swap avoids race conditions.

**Tech Stack:** Node.js 20+, vips/openslide (Docker), PostgreSQL, Redis job queue

**Reference files to understand before starting:**
- `processor/src/pipeline-svs.js` - Current P0 pipeline + pregenerateLowLevelTiles (to be replaced)
- `processor/src/worker.js` - Job processing loop (add TILEGEN handler)
- `processor/src/preview/rebasedPreview.js:162-242` - Existing dzsave usage + level reorganization pattern
- `api/src/services/tilegen-svs.js` - On-demand tile generator (stays as fallback)
- `db/migrations/007_scanner_adapter.sql` - Latest migration (for naming next one)

---

### Task 1: Database Migration - Add `tilegen_status` Column

**Files:**
- Create: `db/migrations/008_add_tilegen_status.sql`

**Step 1: Create migration file**

```sql
-- 008_add_tilegen_status.sql
-- Track tile pre-generation status for WSI slides
ALTER TABLE slides ADD COLUMN tilegen_status TEXT DEFAULT NULL;
-- NULL = not applicable (non-WSI format) or legacy slide
-- 'queued' = TILEGEN job enqueued after P0
-- 'running' = vips dzsave in progress
-- 'done' = all tiles pre-generated
-- 'failed' = dzsave failed, on-demand fallback active

CREATE INDEX idx_slides_tilegen_status ON slides (tilegen_status) WHERE tilegen_status IS NOT NULL;
```

**Step 2: Verify migration applies on container restart**

```bash
docker compose down api && docker compose up -d api
docker compose logs api 2>&1 | grep -i "migration\|008"
```

Expected: Log shows `Applied migration: 008_add_tilegen_status.sql`

**Step 3: Verify column exists**

```bash
docker compose exec db psql -U supernavi -c "\d slides" | grep tilegen
```

Expected: `tilegen_status | text |`

**Step 4: Commit**

```bash
git add db/migrations/008_add_tilegen_status.sql
git commit -m "feat: add tilegen_status column for tile pre-generation tracking"
```

---

### Task 2: Implement `generateFullTilePyramid()` in pipeline-svs.js

**Files:**
- Modify: `processor/src/pipeline-svs.js`

**Context:** The existing `pregenerateLowLevelTiles()` (lines 180-252) generates tiles level-by-level using `vips thumbnail` + `vips crop`. We're replacing it with a single `vips dzsave` call that generates ALL tiles at once. The existing `rebasedPreview.js:162-242` shows the dzsave + reorganize pattern we'll follow.

**Important:** `vips dzsave` level numbering matches our DeepZoom convention (level 0 = 1x1, level N = full res), and `calculateMaxLevel()` uses the same formula as vips (`ceil(log2(max(w,h)))`). So **no level remapping is needed** when running dzsave on the original SVS.

**Step 1: Add imports**

At the top of `processor/src/pipeline-svs.js`, add `readdir`, `rename`, `rm` to the existing `fs/promises` import:

```javascript
import { mkdir, writeFile, unlink, access, readdir, rename, rm } from 'fs/promises';
```

**Step 2: Add `generateFullTilePyramid()` function**

Add this function AFTER the existing `generateThumbnail()` function (after line 96) and BEFORE `processSVS_P0()`:

```javascript
const TILEGEN_TIMEOUT_MS = parseInt(process.env.TILEGEN_TIMEOUT_MS || '600000', 10); // 10 min default

/**
 * Generate full DeepZoom tile pyramid using vips dzsave.
 *
 * vips dzsave reads the SVS file once and generates ALL tiles in a single
 * optimized pass. For a typical 10000x12000 slide this takes 30-120s total
 * (vs 60s PER TILE with on-demand crop+resize).
 *
 * Atomic directory swap:
 * 1. dzsave writes to .dzsave_tmp/dz → creates .dzsave_tmp/dz_files/{z}/{x}_{y}.jpg
 * 2. If tiles/ doesn't exist: rename dz_files → tiles (atomic)
 * 3. If tiles/ exists (on-demand created some): swap atomically
 * 4. Cleanup temp artifacts
 */
export async function generateFullTilePyramid(slideId, rawPath) {
  const slideDir = join(DERIVED_DIR, slideId);
  const tilesDir = join(slideDir, 'tiles');
  const tmpDir = join(slideDir, '.dzsave_tmp');
  const tmpOutput = join(tmpDir, 'dz');
  const dzsaveOutput = join(tmpDir, 'dz_files'); // vips creates {name}_files/
  const startTime = Date.now();

  console.log(`[TILEGEN] Starting vips dzsave for ${slideId.substring(0, 12)}...`);

  // Clean up any leftover temp from previous failed attempt
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    // Step 1: Run vips dzsave - generates full pyramid in one pass
    const cmd = `vips dzsave "${rawPath}" "${tmpOutput}" --suffix .jpg[Q=90] --tile-size 256 --overlap 0`;
    await execAsync(cmd, { timeout: TILEGEN_TIMEOUT_MS });

    // Step 2: Count generated tiles
    let tileCount = 0;
    const levelDirs = await readdir(dzsaveOutput);
    for (const dir of levelDirs) {
      if (/^\d+$/.test(dir)) {
        const files = await readdir(join(dzsaveOutput, dir));
        tileCount += files.filter(f => f.endsWith('.jpg')).length;
      }
    }

    // Step 3: Atomic swap into tiles/
    const tilesExist = await fileExists(tilesDir);
    if (tilesExist) {
      // On-demand tiles were created during generation window
      // Swap: tiles → .tiles_old, dzsave → tiles, rm .tiles_old
      const oldTilesDir = join(slideDir, '.tiles_old');
      await rm(oldTilesDir, { recursive: true, force: true });
      await rename(tilesDir, oldTilesDir);
      await rename(dzsaveOutput, tilesDir);
      await rm(oldTilesDir, { recursive: true, force: true });
    } else {
      // No on-demand tiles yet - simple rename
      await rename(dzsaveOutput, tilesDir);
    }

    // Step 4: Clean up dzsave artifacts (the .dzi XML file and temp dir)
    await rm(tmpDir, { recursive: true, force: true });

    const elapsed = Date.now() - startTime;
    console.log(`[TILEGEN] Complete: ${tileCount} tiles in ${elapsed}ms`);

    return { tileCount, elapsed };
  } catch (err) {
    // Clean up on failure
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}
```

**Step 3: Remove old `pregenerateLowLevelTiles()` function**

Delete the `pregenerateLowLevelTiles()` function (lines 180-252) and the `PREGENERATE_MAX_LEVEL` constant. Keep the `fileExists()` helper as it's still used internally.

Also remove `pregenerateLowLevelTiles` from the export in `processSVS_P0` (it's exported at function declaration level).

**Step 4: Verify no broken imports**

```bash
docker compose exec processor grep -n "pregenerateLowLevelTiles\|PREGENERATE_MAX_LEVEL" /app/src/pipeline-svs.js
```

Expected: No output (function fully removed).

**Step 5: Commit**

```bash
git add processor/src/pipeline-svs.js
git commit -m "feat: add generateFullTilePyramid using vips dzsave, remove pregenerateLowLevelTiles"
```

---

### Task 3: Add TILEGEN Job Handler to Worker

**Files:**
- Modify: `processor/src/worker.js`

**Context:** Currently after P0, the worker calls `pregenerateLowLevelTiles()` inline (lines 222-241). We need to:
1. Replace that with enqueueing a TILEGEN job
2. Add a TILEGEN job handler that calls `generateFullTilePyramid()`
3. Update `tilegen_status` at each stage

**Step 1: Update imports**

Change line 5 from:
```javascript
import { processSVS_P0, processSVS_P1, pregenerateLowLevelTiles } from './pipeline-svs.js';
```
To:
```javascript
import { processSVS_P0, processSVS_P1, generateFullTilePyramid } from './pipeline-svs.js';
```

**Step 2: Remove `PREGENERATE_MAX_LEVEL` constant**

Delete line 13:
```javascript
const PREGENERATE_MAX_LEVEL = parseInt(process.env.PREGENERATE_MAX_LEVEL || '8', 10);
```

**Step 3: Replace pregenerateLowLevelTiles call with TILEGEN enqueue**

Replace the block at lines 221-241 (the `// Pre-generate low-level tiles for WSI formats` block) with:

```javascript
      // Enqueue TILEGEN job for full tile pyramid generation
      if (isWSIFormat(format)) {
        try {
          const tilegenJobId = await createJob(job.slideId, 'TILEGEN');
          await updateSlide(job.slideId, { tilegen_status: 'queued' });
          await enqueueJob({
            jobId: tilegenJobId,
            slideId: job.slideId,
            type: 'TILEGEN',
            rawPath: job.rawPath,
            format: format,
            maxLevel: result.maxLevel
          });
          console.log(`Enqueued TILEGEN job for ${job.slideId.substring(0, 12)}`);
        } catch (tilegenErr) {
          // Non-fatal: on-demand tiles still work
          console.error(`Failed to enqueue TILEGEN (non-fatal): ${tilegenErr.message}`);
        }
      }
```

**Step 4: Add TILEGEN handler in processJob()**

In the `processJob()` function, add a new `else if` branch AFTER the existing `} else if (job.type === 'CLEANUP') {` block (before the closing `}` of the try block, around line 289):

```javascript
    } else if (job.type === 'TILEGEN') {
      // Full tile pyramid generation using vips dzsave
      await updateSlide(job.slideId, { tilegen_status: 'running' });
      await updateJob(job.jobId, { status: 'running' });

      try {
        const result = await generateFullTilePyramid(job.slideId, job.rawPath);

        await updateSlide(job.slideId, {
          tilegen_status: 'done',
          level_ready_max: job.maxLevel
        });
        await updateJob(job.jobId, { status: 'done' });

        await publishEvent('tiles:ready', {
          slideId: job.slideId,
          tileCount: result.tileCount,
          elapsed: result.elapsed,
          timestamp: Date.now()
        });

        console.log(`TILEGEN complete for ${job.slideId.substring(0, 12)}: ${result.tileCount} tiles in ${result.elapsed}ms`);
      } catch (tilegenErr) {
        console.error(`TILEGEN failed for ${job.slideId.substring(0, 12)}: ${tilegenErr.message}`);
        await updateSlide(job.slideId, { tilegen_status: 'failed' });
        await updateJob(job.jobId, { status: 'failed', error: tilegenErr.message });
        // Non-fatal: on-demand tiles still work as fallback
      }
```

**Step 5: Update worker startup log**

Change line 301 from:
```javascript
  console.log(`Tile pre-generation: levels 0-${PREGENERATE_MAX_LEVEL} (PREGENERATE_MAX_LEVEL=${PREGENERATE_MAX_LEVEL})`);
```
To:
```javascript
  console.log(`Tile generation: full pyramid via vips dzsave (TILEGEN job)`);
```

**Step 6: Rebuild and verify**

```bash
docker compose up -d --build processor
docker compose logs -f processor 2>&1 | head -20
```

Expected: Worker starts without errors, shows `Tile generation: full pyramid via vips dzsave (TILEGEN job)`

**Step 7: Commit**

```bash
git add processor/src/worker.js
git commit -m "feat: add TILEGEN job handler, replace inline pregen with dzsave enqueue"
```

---

### Task 4: Clean Up docker-compose.yml Environment

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Remove `PREGENERATE_MAX_LEVEL` from processor service**

In `docker-compose.yml`, find the processor service environment section and remove the `PREGENERATE_MAX_LEVEL` line (currently set to `8`).

**Step 2: Add `TILEGEN_TIMEOUT_MS` (optional, document default)**

In the processor environment section, add a comment for documentation:

```yaml
      # TILEGEN_TIMEOUT_MS: 600000  # 10 min default, uncomment to override
```

**Step 3: Verify compose config is valid**

```bash
docker compose config --quiet
```

Expected: No output (valid config).

**Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: remove PREGENERATE_MAX_LEVEL, document TILEGEN_TIMEOUT_MS"
```

---

### Task 5: Integration Test - Full Pipeline

**Files:** None (manual test using existing infrastructure)

**Step 1: Full rebuild and start**

```bash
docker compose down
docker compose up -d --build
```

**Step 2: Import a test SVS file**

```bash
cp /path/to/test.svs ./data/inbox/
```

(If no test SVS available, use the existing slide in the database.)

**Step 3: Watch processor logs for TILEGEN**

```bash
docker compose logs -f processor 2>&1 | grep -E "TILEGEN|dzsave|P0"
```

Expected log sequence:
```
Processing P0 [format: svs] for slide abc123...
SVS P0 complete - viewer ready (tiles on-demand)
Enqueued TILEGEN job for abc123...
[TILEGEN] Starting vips dzsave for abc123...
[TILEGEN] Complete: NNNN tiles in NNNNNms
TILEGEN complete for abc123...: NNNN tiles in NNNNNms
```

**Step 4: Verify tiles on disk**

```bash
docker compose exec api sh -c 'ls /data/derived/*/tiles/ | head -5'
docker compose exec api sh -c 'find /data/derived/*/tiles/ -name "*.jpg" | wc -l'
```

Expected: Thousands of .jpg tiles across multiple level directories.

**Step 5: Verify tilegen_status in database**

```bash
docker compose exec db psql -U supernavi -c "SELECT id, status, tilegen_status, level_ready_max, max_level FROM slides;"
```

Expected: `tilegen_status = 'done'`, `level_ready_max = max_level` (e.g., 14).

**Step 6: Verify tile serving is fast (all tiles pre-generated)**

```bash
# Pick a high zoom tile that would have been slow before
SLIDE_ID=$(docker compose exec db psql -U supernavi -t -c "SELECT id FROM slides LIMIT 1;" | tr -d ' ')
time curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/v1/slides/${SLIDE_ID}/tiles/13/4/4.jpg
```

Expected: HTTP 200 in <100ms (tile already on disk, no generation needed).

**Step 7: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: adjustments from integration testing"
```

---

### Task 6: Push and Deploy to Dell G15

**Step 1: Push all changes**

```bash
git push
```

**Step 2: On Dell G15, pull and rebuild**

```bash
cd C:\supernavi_edge
git pull
docker compose down
docker compose up -d --build
```

**Step 3: Import a slide and verify TILEGEN runs**

Watch logs: `docker compose logs -f processor`

Expected: P0 completes instantly, TILEGEN generates full pyramid within 30-120s.

**Step 4: Test in viewer**

Open `https://viewer.supernavi.app` and navigate the slide at high zoom. All tiles should load instantly with no timeouts.
