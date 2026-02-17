# Full Tile Pre-generation with `vips dzsave` - Design

## Problem

On-demand tile generation at high zoom levels (12-14) takes up to 60s per tile because each tile runs a separate `vips crop` + `vips resize` process. Even with TILE_CONCURRENCY=12, navigating to a new region at high zoom causes timeouts and broken tiles. The current pre-generation (levels 0-8 via `vips thumbnail` + `vips crop` per tile) doesn't cover the levels users actually navigate.

## Solution

Replace on-demand tile generation with full DeepZoom pyramid pre-generation using `vips dzsave` after P0 completes. `vips dzsave` reads the SVS file once and generates ALL tiles (~3000-5000 for a typical slide) in a single optimized pass, taking 30-120s total instead of 60s per tile.

## Architecture

```
P0 Job (~1s) - NO CHANGE
  ├─ Metadata + Thumbnail + Manifest
  ├─ Slide marked "ready" (viewer opens immediately)
  └─ Enqueue TILEGEN job
       ↓
TILEGEN Job (30-120s) - NEW
  ├─ tilegen_status → 'running'
  ├─ vips dzsave "{rawPath}" "{tempDir}/dz" --suffix .jpg[Q=90] --tile-size 256 --overlap 0
  ├─ Atomic rename: dz_files/ → tiles/
  ├─ tilegen_status → 'done', level_ready_max → maxLevel
  └─ SSE event: tiles:ready
       ↓
Tile Request (API) - NO CHANGE
  ├─ Tile exists on disk? → 200 (fast path, <5ms)
  └─ Not found? → generateTile() on-demand (fallback)
```

### Key Behaviors

**Instant open preserved:** P0 still completes in ~1s. Viewer opens immediately with thumbnail and low-level navigation.

**Fallback during generation:** While TILEGEN runs, on-demand generation still works for any tile the user requests. This handles the 30-120s window between P0 and full tile availability.

**Atomic tile directory swap:** To avoid races between on-demand and dzsave:
1. `vips dzsave` writes to `{slideDir}/.dzsave_tmp/dz` → creates `.dzsave_tmp/dz_files/`
2. On completion, if `tiles/` doesn't exist: `rename('.dzsave_tmp/dz_files', 'tiles')` (atomic on same filesystem)
3. If `tiles/` exists (on-demand tiles created during generation): `rename('tiles', '.tiles_old')` → `rename('.dzsave_tmp/dz_files', 'tiles')` → `rm -rf .tiles_old`
4. Cleanup `.dzsave_tmp/`

The race window between the two renames is negligible (~microseconds), and the on-demand fallback handles any missed requests.

## Database Changes

New migration `008_add_tilegen_status.sql`:

```sql
ALTER TABLE slides ADD COLUMN tilegen_status TEXT DEFAULT NULL;
-- NULL = not applicable (non-WSI) or legacy slide
-- 'queued' = TILEGEN job enqueued
-- 'running' = dzsave in progress
-- 'done' = all tiles pre-generated
-- 'failed' = dzsave failed (on-demand fallback active)
```

`level_ready_max` (already exists) gets updated to `maxLevel` when TILEGEN completes, providing progress tracking.

## Component Changes

### 1. Pipeline SVS (`processor/src/pipeline-svs.js`)

- Remove `pregenerateLowLevelTiles()` function (replaced by dzsave)
- Add `generateFullTilePyramid(slideId, rawPath, width, height, maxLevel)`:
  - Creates temp dir `.dzsave_tmp/`
  - Runs `vips dzsave` with `--suffix .jpg[Q=90] --tile-size 256 --overlap 0`
  - Performs atomic rename to `tiles/`
  - Cleans up temp artifacts
  - Returns `{ tileCount, elapsed }`

### 2. Worker (`processor/src/worker.js`)

- Add `TILEGEN` job type handler
- After P0 for WSI formats: enqueue TILEGEN job (instead of calling pregenerateLowLevelTiles inline)
- TILEGEN handler: calls `generateFullTilePyramid()`, updates `tilegen_status` and `level_ready_max`, publishes SSE event
- `TILEGEN_CONCURRENCY=1` (only one dzsave at a time to avoid overwhelming the machine)
- Timeout: 10 minutes per slide (configurable via `TILEGEN_TIMEOUT_MS`)

### 3. Tile Route (`api/src/routes/slides.js`)

- No changes needed. The existing flow works:
  - Tile on disk → 200 fast path
  - Not on disk + WSI → on-demand `generateTile()` fallback
  - On-demand coalescing still works for concurrent requests

### 4. What Gets Removed

- `pregenerateLowLevelTiles()` function in `pipeline-svs.js`
- `PREGENERATE_MAX_LEVEL` env var (no longer needed - dzsave generates everything)
- The inline call to `pregenerateLowLevelTiles()` in `worker.js` (lines 222-241)

## Operational Limits

| Parameter | Value | Notes |
|-----------|-------|-------|
| TILEGEN concurrency | 1 | Only one dzsave process at a time |
| TILEGEN timeout | 10 min | Configurable via `TILEGEN_TIMEOUT_MS` |
| On failure | fallback to on-demand | `tilegen_status = 'failed'`, tiles still work |
| Retry | manual re-import | Can add auto-retry later if needed |

## What Stays the Same

- P0 pipeline (instant open)
- Tile serving API (same endpoints, same behavior)
- On-demand `tilegen-svs.js` (fallback during/after dzsave)
- Remote preview publishing (separate pipeline)
- Manifest format (no viewer changes needed)
- Frontend (no changes)
