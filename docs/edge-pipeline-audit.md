# Edge Pipeline Audit

**Date:** 2026-03-08
**Scope:** Complete audit of the SuperNavi Edge slide processing pipeline

---

## 1. Architecture Overview (Current)

```
SVS file → Inbox watcher → P0 (metadata + thumb) → TILEGEN (vips dzsave)
  → ~90k tiles → tmpfs (2GB RAM) → serve immediately
  → background persist: tmpfs → NTFS (Docker bind mount) ← BOTTLENECK
  → optional: preview upload (levels 0-6) → Wasabi S3
  → optional: cloud upload (full pyramid TAR) → Wasabi S3
```

**Key problem:** The `tmpfs → NTFS` persistence step through Docker's bind mount on Windows creates a catastrophic I/O bottleneck. Observed processing times of **20+ hours** for a single slide.

---

## 2. Pipeline Entry Points

### 2.1 File Watcher (Primary)
- **File:** `api/src/services/watcher.js`
- Watches `/data/inbox` for `.svs`, `.tif`, `.tiff`, `.ndpi`, `.mrxs`, `.jpg`, `.jpeg`, `.png`
- Uses `fs.watch()` with stability detection (15s for WSI, 3.75s for images)
- SHA256 hash of file content → `slideId`
- Atomic rename to `/data/raw/{slideId}_{filename}`

### 2.2 Scanner Adapter (Secondary)
- **File:** `api/src/services/scanner-adapter.js`
- Polls `/scanner` directory every 120s
- Discovers `.svs` files, deduplicates via `scanner_files` table
- Optional OCR on `dsmeta/label.jpg` via Claude Vision API
- Raw files stay in-place (not copied)

### 2.3 API Upload
- **File:** `api/src/routes/slides.js` (line 159)
- `POST /v1/slides/upload` — accepts raw binary stream
- Writes to `/data/inbox` for watcher to process

---

## 3. Tile Generation Pipeline

### 3.1 P0 — Fast Metadata Extraction
- **File:** `processor/src/pipeline-svs.js` (lines 241-304)
- Extracts dimensions via `openslide-show-properties` or `vipsheader`
- Calculates `maxLevel = ceil(log2(max(width, height)))`
- Generates thumbnail using tissue-density detection
- Creates `manifest.json` (DeepZoom format)
- Marks slide `status='ready'` — **instant viewer access**

### 3.2 On-Demand Tile Generation
- **File:** `api/src/services/tilegen-svs.js`
- Generates individual tiles on API request while TILEGEN hasn't completed
- Request coalescing prevents duplicate vips processes
- Semaphore limits concurrency (default 4 via `TILE_CONCURRENCY`)
- Uses OpenSlide pyramid levels for efficient extraction

### 3.3 TILEGEN — Full Pyramid (THE BOTTLENECK)
- **File:** `processor/src/pipeline-svs.js` (lines 324-426)
- **Command:** `vips dzsave "{rawPath}" "{output}" --suffix .jpg[Q=80] --tile-size 256 --overlap 0`
- **Phase 1:** Write to tmpfs `/data/tiles_hot` (2GB RAM) — tiles immediately servable
- **Phase 2:** Background persistence copies from tmpfs → `/data/derived` (NTFS bind mount)
- **Fallback:** If tmpfs overflows, write directly to NTFS (even slower)
- Generates ~90,000 tiles for a typical 40x WSI

### 3.4 Tile Serving Order
- **File:** `api/src/routes/slides.js` (lines 233-288)
1. Check `/data/tiles_hot/{slideId}/tiles/{z}/{x}_{y}.jpg` (tmpfs, fastest)
2. Check `/data/derived/{slideId}/tiles/{z}/{x}_{y}.jpg` (persistent NTFS)
3. If WSI: call `generateTile()` on-demand (fallback)
4. If non-WSI: 404

---

## 4. Storage Architecture

### 4.1 Local Volumes
| Path | Type | Purpose |
|------|------|---------|
| `/data/inbox` | Bind mount → `./data/inbox` | Ingest queue |
| `/data/raw` | Bind mount → `./data/raw` | Original SVS files |
| `/data/derived` | Bind mount → `./data/derived` | Tiles + manifests (NTFS!) |
| `/data/tiles_hot` | tmpfs (2GB RAM) | Active tiles being served |

### 4.2 Remote Storage (Wasabi S3)
- **Preview upload:** `processor/src/preview/publisher.js`
  - Rebased low-res tiles (levels 0-6, target 2048px max dim)
  - Uploaded to `previews/{slideId}/` in Wasabi
- **Cloud upload:** `processor/src/cloud-uploader.js`
  - Full tile pyramid as TAR archive (50MB parts)
  - Uploaded via presigned multipart URLs from cloud
  - No S3 credentials on edge — security model

### 4.3 S3 Key Structure (Current)
```
previews/{slideId}/
  ├── thumb.jpg
  ├── manifest.json
  └── tiles/
      ├── 0/0_0.jpg
      ├── 1/0_0.jpg ... 1_1.jpg
      └── ...6/

labs/{labId}/slides/{slideId}/dzi/
  ├── manifest.json
  ├── thumb.jpg
  └── {level}/{x}_{y}.jpg
```

---

## 5. Job Queue System

### 5.1 Implementation
- **Queue:** Redis list (`jobs:pending`), FIFO with `BRPOP` (5s timeout)
- **Worker:** `processor/src/worker.js` — single-threaded, blocking pop loop
- **State tracking:** PostgreSQL `jobs` table + `slides` columns

### 5.2 Job Types
| Type | Trigger | Handler |
|------|---------|---------|
| P0 | File ingested | `processP0()` |
| P1 | P0 complete (images only) | `processP1()` |
| TILEGEN | P0 complete (WSI only) | `generateFullTilePyramid()` |
| CLEANUP | Slide deleted | Cloud cleanup |
| PREVIEW_REPUBLISH | Manual | `publishRemotePreview()` |

### 5.3 State Machine
```
slides.status:      queued → processing → ready | failed
slides.tilegen_status:  NULL → queued → running → done | failed
slides.cloud_upload_status: NULL → uploading → done | failed
```

---

## 6. Docker Services

| Service | Image | Role |
|---------|-------|------|
| api | node:20-bookworm-slim + libvips + openslide | Watcher, API, tile serving |
| processor | node:20-bookworm-slim + libvips-dev + openslide | Worker, tile generation |
| sync | node.js | Cloud sync polling |
| db | postgres:16-alpine | Slide/job metadata |
| redis | redis:7-alpine | Job queue |
| caddy | caddy:2-alpine | HTTPS reverse proxy |

**Key dependency:** Both `api` and `processor` containers install `libvips` and `openslide` for tile generation.

---

## 7. Cloud Integration Points

### 7.1 Tile Proxy (WebSocket Tunnel)
- Edge connects to cloud via `wss://cloud.supernavi.app/edge/connect`
- Cloud proxies tile requests through HTTP-over-WebSocket
- Cloud caches tiles in LRU (256MB, 10min TTL)
- Timeout: 30s for tiles, 2s for health checks

### 7.2 Event Sync
- Outbox table → `POST /sync/v1/events`
- Events: `SlideRegistered`, `PreviewPublished`, `CaseUpserted`

### 7.3 Upload Signing
- Edge requests presigned URLs from cloud
- Cloud generates S3 presigned PUT URLs (15min TTL)
- Supports multipart for TAR archives

---

## 8. Frontend Viewer

### 8.1 OpenSeadragon Configuration
- **Component:** `supernavi_frontend/src/components/DziViewer.vue`
- Uses `loadTilesWithAjax: true` with auth headers
- DZI format exclusively — no IIIF support
- Two tile source modes:
  - Edge-first: tiles from edge API via tunnel
  - Signed S3: presigned Wasabi URLs

### 8.2 Tile Source Construction
- **Edge-first:** `composables/useEdgeFirstTileSource.ts`
  - Fetches DZI XML from `/api/v1/slides/{slideId}/dzi.xml`
  - Tile URLs: `/api/v1/tiles/{slideId}/{level}/{x}_{y}.{format}`
- **Signed S3:** `composables/useSignedTileSource.ts`
  - Parses DZI XML for dimensions
  - Tile URLs: `/api/slides/{slideId}/tiles/{level}/{x}_{y}.{format}`

---

## 9. Extension Impact

The Chrome extension is a **UI bridge only** — discovers cases on PathoWeb and routes to the viewer. **No changes needed** for the pipeline migration.

---

## 10. Gargalos Identificados

### CRITICAL: NTFS Persistence via Docker Bind Mount
- `vips dzsave` generates ~90,000 tiles per WSI
- tmpfs (2GB) holds one slide's tiles
- Background `tar` copy from tmpfs → NTFS bind mount is catastrophically slow on Windows
- **Observed:** 20+ hours for a single slide
- **Root cause:** Windows NTFS + Docker bind mount + 90k small file writes

### HIGH: Serial Processing
- Single worker processes one job at a time
- TILEGEN blocks the worker for minutes/hours
- No parallel tile generation across slides

### MEDIUM: Redundant Processing
- Full DZI pyramid generated even when only preview needed
- Cloud upload sends all tiles again as TAR
- Preview upload regenerates tiles at different resolution

### LOW: tmpfs Size Limit
- 2GB tmpfs limits to one slide at a time
- Overflow to NTFS fallback defeats purpose

---

## 11. Refactoring Opportunities

1. **Replace DZI tiles with single BigTIFF file** — eliminates 90k file I/O problem entirely
2. **Direct Wasabi upload** — skip local persistence, upload BigTIFF directly
3. **Cantaloupe image server** — serves IIIF tiles from BigTIFF on Wasabi
4. **Parallel processing** — concurrent BigTIFF generation + upload
5. **Eliminate tmpfs dependency** — single file write instead of 90k tiles
6. **Simplify cloud architecture** — remove TAR extraction, tile proxy complexity
