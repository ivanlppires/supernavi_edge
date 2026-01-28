# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuperNavi EDGE is a local agent for digital pathology that runs on pathologists' machines, providing:
- Edge-first slide viewing (SVS, NDPI, TIFF, JPG, PNG) with instant open for WSI
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

# Check database
docker compose exec db psql -U supernavi -c "SELECT id, status, format FROM slides;"
docker compose exec db psql -U supernavi -c "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 5;"

# Check Redis queue
docker compose exec redis redis-cli LRANGE supernavi:jobs 0 -1
```

## Architecture

```
┌─────────┐    ┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│   API   │◄───│   Redis     │───►│    Processor     │───►│  Wasabi S3  │
│ Fastify │    │   (Queue)   │    │ Sharp/OpenSlide  │    │  (Preview)  │
└────┬────┘    └─────────────┘    └────────┬─────────┘    └─────────────┘
     │                                      │
     └──────────────┬───────────────────────┘
                    ▼
            ┌───────────────┐      ┌───────────────┐
            │  PostgreSQL   │◄─────│     Sync      │───► Cloud API
            └───────────────┘      └───────────────┘
```

### Key Components

| Component | Description | Port |
|-----------|-------------|------|
| **api** | Fastify server, file watcher, tile serving, SSE events | 3000 |
| **processor** | Worker for image processing + remote preview publishing | - |
| **sync** | Cloud synchronization engine (metadata push) | - |
| **mock-cloud** | Local testing server for sync | 4000 |

### Data Flow

1. File placed in `./data/inbox/`
2. Watcher detects file, calculates SHA256 hash (slideId)
3. File moved to `./data/raw/{slideId}_{filename}`
4. P0 job queued via Redis
5. Processor executes pipeline based on format:
   - **SVS/WSI**: thumbnail + manifest (~1s), tiles on-demand, remote preview upload
   - **JPG/PNG**: levels 0-4 (P0), then remaining levels (P1)
6. Sync engine pushes metadata to cloud

### Two Processing Models

| Model | Formats | P0 Time | Tiles |
|-------|---------|---------|-------|
| **Edge-first** | SVS, NDPI, TIFF, MRXS | ~1s | On-demand via `tilegen-svs.js` |
| **Pre-generated** | JPG, PNG | Varies | All levels pre-computed |

## API Endpoints

### Slides
| Endpoint | Description |
|----------|-------------|
| `GET /v1/slides` | List all slides |
| `GET /v1/slides/:id` | Slide details |
| `GET /v1/slides/:id/manifest` | DZI manifest |
| `GET /v1/slides/:id/thumb` | Thumbnail |
| `GET /v1/slides/:id/tiles/:z/:x/:y.jpg` | Tile (on-demand for WSI) |
| `GET /v1/slides/:id/availability` | Tile readiness status |

### Collaboration
| Endpoint | Description |
|----------|-------------|
| `GET/POST /v1/cases` | Case management |
| `GET/POST /v1/slides/:id/annotations` | Slide annotations |
| `GET/POST /v1/slides/:id/threads` | Discussion threads |

### System
| Endpoint | Description |
|----------|-------------|
| `GET /v1/health` | Agent status |
| `GET /v1/capabilities` | Available features |
| `GET /v1/events` | SSE stream for real-time updates |
| `POST /v1/sync/trigger` | Force sync |

### Tile Responses (WSI)
- `200 OK` + image: Ready (generated or cached)
- `202 Accepted`: Being generated (retry in 1s)
- `404 Not Found`: Invalid coordinates

## Remote Preview Publisher

When enabled, processor uploads low-level tiles to Wasabi S3 for remote viewing without full slide transfer.

```bash
# Enable in .env or docker-compose.yml
PREVIEW_REMOTE_ENABLED=true
PREVIEW_MAX_LEVEL=6          # Levels 0-6 uploaded
PREVIEW_UPLOAD_CONCURRENCY=8
S3_BUCKET=supernavi-eu
S3_ENDPOINT=https://s3.eu-central-1.wasabisys.com
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
```

Files: `processor/src/preview/` (publisher.js, wasabiUploader.js, rebasedPreview.js)

## Key Source Files

| File | Purpose |
|------|---------|
| `api/src/server.js` | Fastify bootstrap, migrations |
| `api/src/services/watcher.js` | File ingestion, SHA256 hashing |
| `api/src/services/tilegen-svs.js` | On-demand tile generation (vips) |
| `api/src/services/events.js` | SSE event broadcasting |
| `processor/src/worker.js` | Job consumer, pipeline routing |
| `processor/src/pipeline-svs.js` | WSI P0 (OpenSlide + vips) |
| `processor/src/preview/publisher.js` | Remote preview orchestration |
| `sync/src/worker.js` | Cloud sync polling loop |

## Database Schema

```sql
-- Core tables (db/migrations/)
slides     -- id (SHA256), status, width, height, max_level, format
jobs       -- slide_id, type (P0/P1), status
cases      -- Collaboration cases
annotations, threads -- Per-slide collaboration
```

## Development Guidelines

- Local storage is primary; cloud is for sync/backup
- All features must work offline
- API exposed only on 127.0.0.1 (localhost)
- API contract is identical for all formats (viewer doesn't know the source)
- Never implement LIS/laudo logic (visualization tool only)
- Node.js 20+, ES Modules (`"type": "module"`)

## Testing

```bash
# Run automated dev test
./infra/dev-test.sh

# Manual import
cp sample.svs ./data/inbox/

# Test endpoints
curl http://localhost:3000/v1/slides | jq
curl http://localhost:3000/v1/slides/{slideId}/manifest | jq
curl -o tile.jpg http://localhost:3000/v1/slides/{slideId}/tiles/10/0/0.jpg
curl http://localhost:3000/v1/slides/{slideId}/availability | jq
```
