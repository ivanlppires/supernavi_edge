# Edge Architecture v2 — BigTIFF + IIIF

**Date:** 2026-03-08
**Feature Flag:** `EDGE_PIPELINE_MODE=bigtiff_iiif`

---

## Architecture Overview

```
SVS file → Inbox watcher → P0 (metadata + thumb)
  → BIGTIFF job: vips tiffsave → 1 pyramidal BigTIFF
  → S3 multipart upload (presigned URLs via cloud)
  → Cantaloupe reads BigTIFF from S3
  → OpenSeadragon loads IIIF info.json
```

### Key Improvement

| Metric | Legacy DZI | BigTIFF + IIIF |
|--------|-----------|----------------|
| Files per slide | ~90,000 tiles | 1 BigTIFF |
| Local persistence | Required (NTFS bottleneck) | Not required |
| Processing time | 20+ hours (worst case) | < 10 minutes |
| tmpfs needed | 2GB | No |
| Daily throughput | ~5 slides | 150+ slides |

---

## Pipeline Flow

### 1. SVS Detection (unchanged)
- File watcher monitors `/data/inbox`
- SHA256 hash → slideId
- Copy to `/data/raw/{slideId}_{filename}`

### 2. P0 — Metadata + Thumbnail (unchanged)
- Extract dimensions via openslide/vipsheader
- Generate thumbnail (tissue-density detection)
- Write manifest.json
- Mark slide `status='ready'` — instant viewer via on-demand tiles

### 3. BIGTIFF Job (replaces TILEGEN)
```
Input:  /data/raw/{slideId}_{filename}.svs
Output: /data/tmp/{slideId}.tif (temporary)

Command: vips tiffsave input.svs output.tif \
  --compression jpeg --Q 80 \
  --tile --tile-width 256 --tile-height 256 \
  --pyramid --bigtiff

Time: 2-5 minutes (vs 20+ hours for DZI on NTFS)
```

### 4. S3 Upload
```
Local BigTIFF → S3 multipart upload (50MB parts)
  → slides/{slideId}/slide.tif
  → slides/{slideId}/thumb.jpg

Upload uses presigned URLs from cloud API (no S3 credentials on edge).
Memory-efficient: reads file in 50MB chunks via file handle.
```

### 5. Cantaloupe IIIF
```
Cantaloupe reads: slides/{slideId}/slide.tif from Wasabi S3
Serves:
  GET /iiif/3/{slideId}/info.json
  GET /iiif/3/{slideId}/{region}/{size}/{rotation}/{quality}.{format}
```

### 6. OpenSeadragon Viewer
```
tileSource = "https://cantaloupe.supernavi.app/iiif/3/{slideId}/info.json"

OpenSeadragon has native IIIF 3.0 support.
No custom tile URL construction needed.
```

---

## S3 Key Structure

### New (BigTIFF)
```
slides/{slideId}/
  ├── slide.tif          # Pyramidal BigTIFF (500MB-2GB)
  └── thumb.jpg          # Thumbnail
```

### Legacy (DZI) — preserved, read-only
```
previews/{slideId}/          # Rebased DZI tiles
labs/{labId}/slides/{slideId}/dzi/   # Full DZI tiles
```

---

## Feature Flag

### Environment Variable
```bash
# Edge docker-compose.yml
EDGE_PIPELINE_MODE=bigtiff_iiif   # New pipeline
EDGE_PIPELINE_MODE=legacy_dzi     # Old pipeline (default)
```

### Behavior
| Aspect | `legacy_dzi` | `bigtiff_iiif` |
|--------|-------------|----------------|
| Post-P0 job | TILEGEN | BIGTIFF |
| Output | 90k DZI tiles | 1 BigTIFF |
| Local storage | /data/derived + tmpfs | /data/tmp (temporary) |
| S3 key | labs/{labId}/slides/{id}/dzi/ | slides/{id}/slide.tif |
| Viewer source | DZI (edge proxy or S3) | IIIF (Cantaloupe) |
| Local persist | Required (NTFS) | Not required |

### Slide-Level Tracking
Each slide stores `pipeline_mode` in the database, so old DZI slides
continue working even when the global mode changes.

---

## Components Modified

### Edge (supernavi_edge)
| File | Change |
|------|--------|
| `processor/src/bigtiff-generator.js` | NEW — vips tiffsave wrapper |
| `processor/src/bigtiff-uploader.js` | NEW — S3 multipart upload |
| `processor/src/worker.js` | Routes BIGTIFF vs TILEGEN based on flag |
| `db/migrations/013_add_bigtiff_fields.sql` | pipeline_mode, s3_bigtiff_key, bigtiff_size |
| `docker-compose.yml` | EDGE_PIPELINE_MODE, /data/tmp volume |

### Cloud (supernavi_cloud)
| File | Change |
|------|--------|
| `src/modules/edge-api/schemas.ts` | Accept pipelineMode, bigtiff flag, image/tiff |
| `src/modules/edge-api/routes.ts` | BigTIFF init (slides/ prefix) + ready (no extraction) |
| `src/modules/edge-api/upload-validation.ts` | Allow slides/{slideId}/ prefix |
| `src/sync/schemas.ts` | pipeline_mode in SlideRegistered |
| `src/sync/projections.ts` | Store pipelineMode |
| `prisma/schema.prisma` | pipelineMode, s3BigtiffKey, bigtiffSize |
| `cantaloupe/` | NEW — Cantaloupe config + Docker compose |

### Frontend (supernavi_frontend)
| File | Change |
|------|--------|
| `src/composables/useIIIFTileSource.ts` | NEW — IIIF tile source for OSD |
| `src/pages/viewer.vue` | IIIF priority in tile source selection |

---

## Rollback

### Immediate (no code change)
```bash
# Set env var and restart
EDGE_PIPELINE_MODE=legacy_dzi
docker compose up -d --build processor
```

### Code Rollback
```bash
# Branch with original code preserved
git checkout backup/legacy-dzi-pipeline

# Tag marking last DZI-only commit
git checkout legacy-dzi-final
```

### Data Compatibility
- Old DZI slides continue working via existing tile serving
- New BigTIFF slides continue working via Cantaloupe
- Both modes coexist indefinitely

---

## Cantaloupe Deployment

### Docker (Coolify)
```bash
cd supernavi_cloud
docker compose -f cantaloupe/docker-compose.cantaloupe.yml up -d
```

### Environment Variables
```
S3_ENDPOINT=https://s3.us-east-1.wasabisys.com
S3_ACCESS_KEY=<wasabi access key>
S3_SECRET_KEY=<wasabi secret key>
S3_BUCKET=supernavi-us-east
```

### URL Pattern
```
Base: https://cantaloupe.supernavi.app
Info: /iiif/3/{slideId}/info.json
Tile: /iiif/3/{slideId}/{region}/{size}/{rotation}/{quality}.{format}
```

### Frontend Config
```
VITE_CANTALOUPE_URL=https://cantaloupe.supernavi.app
```

---

## Testing

### End-to-End Test
```bash
# 1. Enable BigTIFF pipeline
export EDGE_PIPELINE_MODE=bigtiff_iiif
docker compose up -d --build

# 2. Place SVS file in inbox
cp test.svs ./data/inbox/

# 3. Monitor processing
docker compose logs -f processor

# 4. Verify BigTIFF in S3
# Check logs for: [BIGTIFF-UPLOAD] Complete: X MB in Ys

# 5. Verify IIIF (after Cantaloupe deployment)
curl https://cantaloupe.supernavi.app/iiif/3/{slideId}/info.json

# 6. Open viewer — should load via IIIF
```

### Performance Benchmark
```bash
# Time the full pipeline for a large SVS
time docker compose exec processor node -e "
  import { generateBigTIFF } from './src/bigtiff-generator.js';
  const r = await generateBigTIFF('test', '/data/raw/test.svs');
  console.log(r);
"
```

---

## Observability

### Structured Logs
```json
{
  "event": "bigtiff_complete",
  "slideId": "abc123...",
  "inputSize": 2147483648,
  "outputSize": 1073741824,
  "generationTimeMs": 180000,
  "uploadTimeMs": 120000,
  "totalTimeMs": 300000,
  "throughputMBs": 8.9
}
```

### Key Metrics
- BigTIFF generation time (vips tiffsave)
- S3 upload time and throughput (MB/s)
- Queue depth and wait time
- Temp disk space utilization
- Failed/retried jobs
