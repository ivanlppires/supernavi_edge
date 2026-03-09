# Edge Pipeline Refactoring Plan: DZI → BigTIFF + IIIF

**Date:** 2026-03-08
**Status:** Implementation Plan
**Feature Flag:** `EDGE_PIPELINE_MODE` (values: `legacy_dzi` | `bigtiff_iiif`)

---

## 1. Executive Summary

Replace the DZI tile pipeline (90k files, tmpfs, NTFS bottleneck) with a single pyramidal BigTIFF file uploaded directly to Wasabi S3. Tile serving moves from edge-proxied DZI to Cantaloupe (IIIF image server) reading BigTIFF from S3.

**Before:** SVS → vips dzsave → 90k tiles → tmpfs → NTFS → TAR → S3
**After:** SVS → vips tiffsave → 1 BigTIFF → S3 multipart upload → Cantaloupe IIIF

---

## 2. Components to Modify

### 2.1 Edge — Processor (supernavi_edge)

| File | Change | Impact |
|------|--------|--------|
| `processor/src/pipeline-svs.js` | Add `processSVS_BigTIFF()` alongside existing P0 | New function |
| `processor/src/worker.js` | Route TILEGEN to new BigTIFF pipeline based on feature flag | Modified |
| `processor/src/bigtiff-generator.js` | **NEW** — BigTIFF generation with vips tiffsave | New module |
| `processor/src/s3-uploader.js` | **NEW** — Direct S3 multipart upload (no presigned URLs) | New module |
| `processor/src/preview/publisher.js` | Extract thumbnail from BigTIFF instead of separate generation | Modified |
| `processor/src/cloud-uploader.js` | Skip when `bigtiff_iiif` mode — upload handled by s3-uploader | Modified |

### 2.2 Edge — API (supernavi_edge)

| File | Change | Impact |
|------|--------|--------|
| `api/src/routes/slides.js` | Add IIIF redirect for tile requests when `bigtiff_iiif` mode | Modified |
| `api/src/services/tilegen-svs.js` | Bypass on-demand tilegen when `bigtiff_iiif` mode | Modified |
| `docker-compose.yml` | Add S3 credentials, feature flag, reduce tmpfs | Modified |
| `.env.example` | Add new config variables | Modified |

### 2.3 Edge — Database

| Migration | Purpose |
|-----------|---------|
| `013_add_bigtiff_fields.sql` | Add `bigtiff_path`, `bigtiff_size`, `s3_bigtiff_key`, `pipeline_mode` columns |

### 2.4 Cloud (supernavi_cloud)

| File | Change | Impact |
|------|--------|--------|
| `src/modules/edge-api/routes.ts` | Accept BigTIFF metadata registration | Modified |
| `src/modules/preview/routes.ts` | Add IIIF proxy/redirect for BigTIFF slides | Modified |
| `src/sync/schemas.ts` | Extend `SlideRegistered` with BigTIFF fields | Modified |
| `src/sync/projections.ts` | Store BigTIFF metadata in `slides_read` | Modified |
| `prisma/schema.prisma` | Add BigTIFF fields to `SlideRead` | Modified |

### 2.5 Frontend (supernavi_frontend)

| File | Change | Impact |
|------|--------|--------|
| `src/composables/useIIIFTileSource.ts` | **NEW** — IIIF tile source for OpenSeadragon | New module |
| `src/composables/useEdgeFirstTileSource.ts` | Add IIIF fallback path | Modified |
| `src/pages/viewer.vue` | Select tile source based on slide pipeline_mode | Modified |
| `src/components/DziViewer.vue` | Accept IIIF tile source (OSD native support) | Minimal change |

---

## 3. New Modules

### 3.1 `bigtiff-generator.js` (Edge Processor)

```
Input:  raw SVS path
Output: pyramidal BigTIFF file

Command: vips tiffsave input.svs output.tif \
  --compression jpeg \
  --Q 80 \
  --tile \
  --tile-width 256 \
  --tile-height 256 \
  --pyramid \
  --bigtiff

Output: single file, ~500MB-2GB depending on magnification
Time estimate: 2-5 minutes per slide (vs 20+ hours current)
```

### 3.2 `s3-uploader.js` (Edge Processor)

```
Direct S3 multipart upload to Wasabi
- Part size: 50MB (configurable)
- Concurrency: 4 parallel parts (configurable)
- Retry: 3 attempts with exponential backoff
- Integrity: ETag verification per part
- Progress tracking for observability
```

### 3.3 `useIIIFTileSource.ts` (Frontend)

```typescript
// IIIF tile source for OpenSeadragon
// OSD has native IIIF support — just provide info.json URL
const tileSource = {
  type: 'iiif',
  url: `${cantaloupeUrl}/iiif/3/${slideId}/info.json`
}
```

---

## 4. S3 Storage Structure (New)

```
{bucket}/
  slides/
    {slideId}/
      slide.tif              # Pyramidal BigTIFF (primary artifact)
      thumb.jpg              # Thumbnail (256x256 or similar)
      metadata.json          # Slide metadata (dimensions, mpp, mag, etc.)
```

Legacy structure (preserved, read-only):
```
previews/{slideId}/          # Rebased DZI tiles (legacy)
labs/{labId}/slides/{slideId}/dzi/  # Full DZI tiles (legacy)
```

---

## 5. Cantaloupe Configuration

### 5.1 Deployment
- Docker container alongside cloud services
- Reads BigTIFF from Wasabi S3 via `S3Source`
- Exposes IIIF Image API 3.0 endpoints
- Caches decoded tiles in memory/disk

### 5.2 Key Configuration
```properties
# Source
source.static = S3Source
S3Source.endpoint = https://s3.us-east-1.wasabisys.com
S3Source.BasicLookupStrategy.bucket.name = supernavi-us-east
S3Source.BasicLookupStrategy.path_prefix = slides/
S3Source.BasicLookupStrategy.path_suffix = /slide.tif

# Processing
processor.selection_strategy = AutomaticSelectionStrategy

# Cache
cache.server.resolve_first = true
cache.server.derivative.enabled = true
cache.server.derivative = FilesystemCache
cache.server.derivative.ttl_seconds = 86400

# IIIF
endpoint.iiif.2.enabled = false
endpoint.iiif.3.enabled = true
```

### 5.3 URL Pattern
```
GET /iiif/3/{slideId}/info.json          → IIIF manifest
GET /iiif/3/{slideId}/{region}/{size}/{rotation}/{quality}.{format}
                                          → Tile/region
```

---

## 6. New Pipeline Flow

```
1. SVS detected (watcher or scanner-adapter)
   ├── SHA256 → slideId
   └── Copy to /data/raw/

2. P0 job (unchanged)
   ├── Extract metadata (dimensions, mpp, magnification)
   ├── Generate thumbnail
   ├── Write manifest.json
   └── Mark slide status='ready' (instant viewer via on-demand tiles)

3. BIGTIFF job (replaces TILEGEN)
   ├── vips tiffsave → /data/tmp/{slideId}.tif (local temp, NOT persist)
   ├── S3 multipart upload → slides/{slideId}/slide.tif
   ├── Upload thumbnail → slides/{slideId}/thumb.jpg
   ├── Upload metadata → slides/{slideId}/metadata.json
   ├── Register with cloud (event sync)
   ├── Delete local temp file
   └── Mark bigtiff_status='done'

4. Slide is now viewable via:
   ├── Edge on-demand tiles (local network, during/after processing)
   └── Cantaloupe IIIF (remote, after S3 upload complete)
```

---

## 7. Feature Flag Strategy

### Environment Variable
```
EDGE_PIPELINE_MODE=bigtiff_iiif  # or legacy_dzi
```

### Behavior per Mode

| Aspect | `legacy_dzi` | `bigtiff_iiif` |
|--------|-------------|----------------|
| After P0 | Enqueue TILEGEN | Enqueue BIGTIFF |
| Tile generation | vips dzsave → 90k tiles | vips tiffsave → 1 BigTIFF |
| Local storage | /data/derived/{id}/tiles/ | /data/tmp/{id}.tif (temporary) |
| Remote storage | previews/{id}/ (rebased DZI) | slides/{id}/slide.tif |
| Cloud upload | TAR multipart (full DZI) | S3 multipart (BigTIFF) |
| Viewer tile source | DZI (edge proxy or S3) | IIIF (Cantaloupe) |
| tmpfs needed | Yes (2GB) | No |
| Local persistence | Required (NTFS) | Not required |

### Frontend Detection
- Cloud stores `pipeline_mode` per slide in `slides_read`
- Frontend checks `slide.pipelineMode` to select tile source
- Both modes can coexist — old DZI slides continue working

---

## 8. Queue System Enhancements

### New Job Type
```
BIGTIFF — replaces TILEGEN when pipeline_mode = bigtiff_iiif
```

### Enhanced States
```
queued → processing → uploading → completed | failed | retrying
```

### Concurrency Control
```
MAX_BIGTIFF_JOBS=2      # Concurrent BigTIFF generations
MAX_UPLOAD_JOBS=4       # Concurrent S3 uploads
BIGTIFF_TIMEOUT_MS=600000  # 10 min timeout
UPLOAD_TIMEOUT_MS=1800000  # 30 min timeout (large files)
```

### Backpressure
- Monitor disk space before starting new BIGTIFF job
- Monitor RAM before allocating vips buffers
- Pause queue if temp disk < 10GB free

---

## 9. Observability

### Structured Logs
```json
{
  "event": "bigtiff_complete",
  "slideId": "abc123",
  "inputFormat": "svs",
  "inputSize": 2147483648,
  "outputSize": 1073741824,
  "compressionRatio": 0.5,
  "generationTimeMs": 180000,
  "uploadTimeMs": 120000,
  "totalTimeMs": 300000,
  "tileSize": 256,
  "levels": 17,
  "width": 98304,
  "height": 65536
}
```

### Metrics to Track
- BigTIFF generation time per slide
- S3 upload time and throughput (MB/s)
- Queue depth and wait time
- Disk space utilization
- Failed/retried jobs

---

## 10. Rollback Strategy

### Immediate Rollback
1. Set `EDGE_PIPELINE_MODE=legacy_dzi`
2. Restart edge containers
3. All new slides processed with old DZI pipeline
4. Existing BigTIFF slides remain viewable via Cantaloupe

### Code Rollback
1. Branch `backup/legacy-dzi-pipeline` preserves current code
2. Tag `legacy-dzi-final` marks last DZI-only commit
3. No legacy code deleted — feature flag controls routing

### Data Compatibility
- Old DZI slides: continue working via existing tile serving
- New BigTIFF slides: viewable via Cantaloupe IIIF
- Both types can coexist in the same system indefinitely

---

## 11. Implementation Phases

### Phase 1: Foundation (Edge)
1. Create backup branch and tag
2. Add feature flag infrastructure
3. Add database migration for BigTIFF fields
4. Implement `bigtiff-generator.js`
5. Implement `s3-uploader.js`

### Phase 2: Pipeline Integration (Edge)
1. Modify worker to route based on feature flag
2. Modify pipeline-svs.js to support both modes
3. Update job queue with new states
4. Add observability logging

### Phase 3: Cloud + Cantaloupe
1. Add Cantaloupe Docker service
2. Configure Cantaloupe for Wasabi S3
3. Update cloud to store BigTIFF metadata
4. Add IIIF proxy/redirect routes

### Phase 4: Frontend
1. Create IIIF tile source composable
2. Update viewer to detect pipeline mode
3. Select appropriate tile source per slide

### Phase 5: Validation
1. End-to-end test: SVS → BigTIFF → S3 → Cantaloupe → OpenSeadragon
2. Performance benchmarks
3. Rollback verification

---

## 12. Performance Targets

| Metric | Current (DZI) | Target (BigTIFF) |
|--------|--------------|-------------------|
| Processing time (40x WSI) | 20+ hours | < 10 minutes |
| Files generated per slide | ~90,000 | 1 |
| Local disk I/O | Catastrophic | Minimal |
| Daily throughput | ~5 slides | 150+ slides |
| tmpfs required | 2GB | 0 |
| NTFS persistence | Required | Not required |
