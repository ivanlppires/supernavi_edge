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

# Run dev test
./infra/dev-test.sh

# Stop all services
docker compose down

# Full reset (including data)
docker compose down -v && rm -rf ./data/raw/* ./data/derived/*
```

## Project Structure

```
supernavi2_edge/
├── api/                 # API local (Fastify) - porta 3000
│   └── src/
│       ├── routes/      # Endpoints HTTP
│       ├── db/          # Database queries
│       ├── lib/         # Utilities (queue, hash)
│       └── services/    # Watcher
├── processor/           # Pipeline de processamento de tiles
│   └── src/
│       ├── worker.js       # Job consumer (routes by format)
│       ├── pipeline-p0.js  # JPG/PNG: Sharp (levels 0-4)
│       ├── pipeline-p1.js  # JPG/PNG: Sharp (remaining levels)
│       └── pipeline-svs.js # SVS/WSI: OpenSlide + vips dzsave
├── sync/                # Motor de sincronização (placeholder)
├── infra/               # Scripts de desenvolvimento
├── db/migrations/       # SQL migrations
├── data/                # Dados locais (não versionados)
│   ├── inbox/           # Drop files here to import
│   ├── raw/             # Original files
│   └── derived/         # Generated tiles
├── samples/             # Sample SVS files for testing
├── docs/                # Documentação técnica
└── docker-compose.yml
```

## Supported Formats

| Format | Extensions | Pipeline |
|--------|------------|----------|
| JPEG | .jpg, .jpeg | Sharp (Node.js) |
| PNG | .png | Sharp (Node.js) |
| **SVS** | **.svs** | **OpenSlide + libvips** |
| TIFF | .tif, .tiff | OpenSlide + libvips |
| NDPI | .ndpi | OpenSlide + libvips |
| MRXS | .mrxs | OpenSlide + libvips |

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

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /v1/health` | Agent status |
| `GET /v1/capabilities` | Available features |
| `GET /v1/slides` | List all slides (includes format) |
| `GET /v1/slides/:id` | Slide details |
| `GET /v1/slides/:id/manifest` | DZI manifest |
| `GET /v1/slides/:id/thumb` | Thumbnail |
| `GET /v1/slides/:id/tiles/:z/:x/:y.jpg` | Tile image |

## Pipeline Processing

**JPG/PNG (Sharp):**
- P0: Generates levels 0-4 quickly for immediate preview
- P1: Generates remaining levels for full zoom

**SVS/WSI (OpenSlide + libvips):**
- P0: Generates all levels at once via `vips dzsave`
- P1: Not needed (dzsave is complete)

**Output structure:**
```
./data/derived/{slideId}/
├── thumb.jpg
├── manifest.json
└── tiles/{level}/{col}_{row}.jpg
```

## Development Guidelines

- Local storage is primary; cloud is for sync/backup
- All features must work offline
- API exposed only on 127.0.0.1
- API contract is identical for all formats (viewer doesn't know the source format)
- Never implement LIS/laudo logic

## Database Tables

- `slides`: Slide metadata, status, and format
- `jobs`: Processing job queue tracking
- `migrations`: Applied migrations tracking

## Testing SVS

1. Place `.svs` file in `./samples/sample.svs`
2. Run `./infra/dev-test.sh`
3. Or manually: `cp sample.svs ./data/inbox/`
