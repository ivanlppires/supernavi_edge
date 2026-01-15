# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuperNavi Local Agent is a Windows desktop application for digital pathology. It runs locally on pathologists' machines, providing:
- Local-first slide viewing (SVS, NDPI, TIFF, JPG, PNG)
- Offline capability with automatic cloud sync
- Seamless local/remote experience via `https://app.supernavi.app`

## Commands

```bash
# Start all services
docker compose up -d --build

# View logs
docker compose logs -f api processor

# Run dev test (imports sample file and tests endpoints)
./infra/dev-test.sh

# Stop all services
docker compose down

# Full reset (including data)
docker compose down -v && rm -rf ./data/raw/* ./data/derived/*

# Debug: inspect container internals
docker compose exec processor openslide-show-properties /data/raw/*.svs
docker compose exec processor vipsheader /data/raw/*.svs
docker compose exec api sh
```

## Architecture

```
┌─────────┐    ┌─────────────┐    ┌──────────────────┐
│   API   │◄───│   Redis     │───►│    Processor     │
│ Fastify │    │   (Queue)   │    │ Sharp/OpenSlide  │
└────┬────┘    └─────────────┘    └────────┬─────────┘
     │                                      │
     └──────────────┬───────────────────────┘
                    ▼
            ┌───────────────┐
            │  PostgreSQL   │
            └───────────────┘
```

### Key Components

| Component | Description | Port |
|-----------|-------------|------|
| **api** | Fastify server, file watcher, tile serving | 3000 |
| **processor** | Worker for image processing (Sharp/OpenSlide) | - |
| **sync** | Cloud synchronization engine | - |
| **mock-cloud** | Local testing server for sync | 4000 |

### Data Flow

1. File placed in `./data/inbox/`
2. Watcher (`api/src/services/watcher.js`) detects file, calculates SHA256 hash (slideId)
3. File moved to `./data/raw/{slideId}_{filename}`
4. P0 job queued via Redis
5. Processor executes pipeline based on format
6. For SVS/WSI: thumbnail + manifest generated (~1s), tiles on-demand
7. For JPG/PNG: levels 0-4 generated (P0), remaining levels (P1)

## Supported Formats

| Format | Extensions | Pipeline | Tiles |
|--------|------------|----------|-------|
| JPEG | .jpg, .jpeg | Sharp (Node.js) | Pre-generated |
| PNG | .png | Sharp (Node.js) | Pre-generated |
| **SVS** | **.svs** | **OpenSlide + libvips** | **On-demand** |
| TIFF | .tif, .tiff | OpenSlide + libvips | On-demand |
| NDPI | .ndpi | OpenSlide + libvips | On-demand |
| MRXS | .mrxs | OpenSlide + libvips | On-demand |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /v1/health` | Agent status |
| `GET /v1/capabilities` | Available features |
| `GET /v1/slides` | List all slides |
| `GET /v1/slides/:id` | Slide details |
| `GET /v1/slides/:id/manifest` | DZI manifest |
| `GET /v1/slides/:id/thumb` | Thumbnail |
| `GET /v1/slides/:id/tiles/:z/:x/:y.jpg` | Tile image (on-demand for WSI) |
| `GET /v1/slides/:id/availability` | Tile readiness status |
| `GET /v1/events` | SSE stream for real-time updates |

### Tile Responses (WSI formats)

- `200 OK` + image: Tile ready (generated or cached)
- `202 Accepted`: Tile being generated (client should retry)
- `404 Not Found`: Invalid coordinates or slide not found

### SSE Events

The `/v1/events` endpoint provides real-time updates:
- `slide:import` - New slide detected
- `slide:ready` - P0 complete, slide viewable
- `slide:progress` - Processing progress
- `tile:ready` - Individual tile generated

## Key Source Files

| File | Purpose |
|------|---------|
| `api/src/server.js` | Fastify app bootstrap, migrations, watcher start |
| `api/src/services/watcher.js` | File system watcher, ingestion logic |
| `api/src/services/tilegen-svs.js` | On-demand tile generation for WSI |
| `api/src/routes/slides.js` | Slide CRUD and tile endpoints |
| `processor/src/worker.js` | Job consumer, routes to pipelines |
| `processor/src/pipeline-svs.js` | OpenSlide + vips dzsave for WSI |
| `processor/src/pipeline-p0.js` | Sharp P0 (levels 0-4) for images |
| `processor/src/pipeline-p1.js` | Sharp P1 (remaining levels) for images |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | postgres://supernavi:supernavi@db:5432/supernavi | PostgreSQL connection |
| `REDIS_URL` | redis://redis:6379 | Redis connection |
| `INGEST_DIR` | /data/inbox | Watch directory for new files |
| `RAW_DIR` | /data/raw | Original files storage |
| `DERIVED_DIR` | /data/derived | Generated tiles/thumbnails |
| `PORT` | 3000 | API server port |

## Development Guidelines

- Local storage is primary; cloud is for sync/backup
- All features must work offline
- API exposed only on 127.0.0.1 (localhost)
- API contract is identical for all formats (viewer doesn't know the source format)
- Never implement LIS/laudo logic (this is a visualization tool, not a diagnostic system)

## Testing

1. Place `.svs` file in `./samples/sample.svs`
2. Run `./infra/dev-test.sh`
3. Or manually: `cp sample.svs ./data/inbox/`

Test tile endpoints:
```bash
# Get manifest
curl http://localhost:3000/v1/slides/{slideId}/manifest | jq

# Test on-demand tile generation
curl -o tile.jpg http://localhost:3000/v1/slides/{slideId}/tiles/10/0/0.jpg

# Check availability
curl http://localhost:3000/v1/slides/{slideId}/availability | jq
```
