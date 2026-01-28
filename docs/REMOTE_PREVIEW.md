# Remote Preview Publisher

Publishes slide previews (thumbnail, manifest, low-level tiles) to Wasabi S3 for remote viewing via the cloud application.

## Overview

The Remote Preview Publisher is part of the edge-first architecture. When a slide is processed locally, a preview is uploaded to Wasabi S3, allowing remote viewers to access low-resolution tiles without connecting to the local edge.

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   Local     │      │   Wasabi    │      │   Cloud     │
│   Edge      │─────►│   S3        │◄─────│   Viewer    │
│   (Full)    │      │   (Preview) │      │   (Remote)  │
└─────────────┘      └─────────────┘      └─────────────┘
```

## What Gets Uploaded

For each slide:
- `previews/{slideId}/thumb.jpg` - 256x256 thumbnail
- `previews/{slideId}/manifest.json` - DZI manifest with remote storage info
- `previews/{slideId}/tiles/{z}/{x}_{y}.jpg` - Tiles for levels 0..N (configurable)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_BUCKET` | `supernavi-eu` | Wasabi bucket name |
| `S3_ENDPOINT` | `https://s3.eu-central-1.wasabisys.com` | Wasabi endpoint |
| `S3_REGION` | `eu-central-1` | AWS region |
| `S3_ACCESS_KEY` | (required) | Wasabi access key |
| `S3_SECRET_KEY` | (required) | Wasabi secret key |
| `S3_FORCE_PATH_STYLE` | `true` | Use path-style URLs |
| `PREVIEW_REMOTE_ENABLED` | `false` | Enable preview publishing |
| `PREVIEW_MAX_LEVEL` | `6` | Maximum zoom level to upload |
| `PREVIEW_UPLOAD_CONCURRENCY` | `8` | Concurrent tile uploads |
| `PREVIEW_PREFIX_BASE` | `previews` | S3 key prefix |

## docker-compose.yml Example

```yaml
processor:
  environment:
    # Enable preview publishing
    PREVIEW_REMOTE_ENABLED: "true"
    PREVIEW_MAX_LEVEL: "6"

    # Wasabi credentials
    S3_BUCKET: supernavi-eu
    S3_ENDPOINT: https://s3.eu-central-1.wasabisys.com
    S3_REGION: eu-central-1
    S3_ACCESS_KEY: ${S3_ACCESS_KEY}
    S3_SECRET_KEY: ${S3_SECRET_KEY}
    S3_FORCE_PATH_STYLE: "true"
```

## How It Works

### Automatic Publishing (Pipeline Integration)

When `PREVIEW_REMOTE_ENABLED=true`, the preview is automatically published after P0 processing completes:

1. **P0 completes** → Slide has thumb.jpg and manifest.json
2. **ensureLowLevelTiles()** → Generates missing tiles 0..N (on-demand slides)
3. **Upload to Wasabi** → thumb, manifest, and tiles
4. **Save marker** → `preview_published.json` for idempotency
5. **Emit event** → `PreviewPublished` added to outbox

### Manual Publishing (Smoke Test)

```bash
# Set environment
export S3_ACCESS_KEY=your_key
export S3_SECRET_KEY=your_secret
export PREVIEW_REMOTE_ENABLED=true
export DERIVED_DIR=./data/derived
export DATABASE_URL=postgres://supernavi:supernavi@localhost:5432/supernavi

# Run smoke test
node scripts/publish_preview_smoke.js <slideId> [maxLevel]
```

## Idempotency

The publisher creates a marker file at `$DERIVED_DIR/{slideId}/preview_published.json`:

```json
{
  "status": "complete",
  "publishedAt": "2024-01-15T10:30:00.000Z",
  "maxLevel": 6,
  "thumbHash": "sha256...",
  "manifestHash": "sha256...",
  "tilesHash": "sha256...",
  "eventId": "uuid...",
  "uploadStats": {
    "tilesCount": 85,
    "totalBytes": 1234567
  }
}
```

Re-running publish will skip if:
- Marker exists with `status: "complete"`
- Content hashes match (thumb, manifest, tiles)
- maxLevel hasn't changed

## PreviewPublished Event

Emitted to the outbox when publishing completes:

```json
{
  "entity_type": "preview",
  "entity_id": "preview:{slideId}",
  "op": "published",
  "payload": {
    "slide_id": "abc123...",
    "case_id": "case-uuid (or null)",
    "wasabi_bucket": "supernavi-eu",
    "wasabi_region": "eu-central-1",
    "wasabi_endpoint": "https://s3.eu-central-1.wasabisys.com",
    "wasabi_prefix": "previews/abc123.../",
    "thumb_key": "previews/abc123.../thumb.jpg",
    "manifest_key": "previews/abc123.../manifest.json",
    "low_tiles_prefix": "previews/abc123.../tiles/",
    "max_preview_level": 6,
    "tile_size": 256,
    "format": "jpg",
    "published_at": "2024-01-15T10:30:00.000Z",
    "upload_stats": {
      "tiles_count": 85,
      "tiles_bytes": 1000000,
      "thumb_bytes": 5000,
      "manifest_bytes": 500,
      "tiles_generated": 20,
      "tiles_existing": 65
    }
  }
}
```

The Sync Engine picks this up and pushes to the cloud.

## Remote Manifest Format

The manifest uploaded to Wasabi includes remote-specific fields:

```json
{
  "protocol": "dzi",
  "tileSize": 256,
  "overlap": 0,
  "format": "jpg",
  "width": 50000,
  "height": 40000,
  "levelMin": 0,
  "levelMax": 16,
  "storage": {
    "provider": "s3",
    "bucket": "supernavi-eu",
    "region": "eu-central-1",
    "endpoint": "https://s3.eu-central-1.wasabisys.com",
    "prefix": "previews/abc123.../"
  },
  "lowTilesPrefix": "previews/abc123.../tiles/",
  "maxPreviewLevel": 6,
  "tilePathPattern": "tiles/{z}/{x}_{y}.jpg"
}
```

## Tile Level Guide

| Level | Tile Count | Typical Resolution | Use Case |
|-------|------------|-------------------|----------|
| 0 | 1 | 1-2px | Overview |
| 1-4 | ~10 | Low | Thumbnails |
| 5-6 | ~100 | Medium | **Preview default** |
| 7-10 | ~1000 | High | Detail viewing |
| 11+ | ~10000+ | Full | Diagnosis |

Level 6 (default) provides enough detail for remote preview without excessive storage.

## File Structure

```
processor/src/preview/
├── index.js              # Module exports
├── wasabiUploader.js     # S3 upload with retry
├── ensureLowLevelTiles.js # Tile materialization
└── publisher.js          # Orchestrator

scripts/
└── publish_preview_smoke.js  # Manual testing
```

## Error Handling

- **Upload failures**: Retry with exponential backoff (3 attempts)
- **Partial upload**: Marker set to `status: "incomplete"`, retryable
- **Non-fatal**: Pipeline continues even if preview fails
- **Idempotent**: Safe to retry, uploads overwrite existing objects

## Security Notes

- **No public ACL**: Objects are private, served via signed URLs
- **Credentials**: Use environment variables, never commit keys
- **Cache-Control**: Tiles/thumb use immutable caching, manifest expires in 5min
