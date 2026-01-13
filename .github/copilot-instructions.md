# SuperNavi Local Agent - AI Coding Instructions

## Project Overview

SuperNavi Local Agent is a **Windows desktop application** for digital pathology that runs locally on pathologists' machines. It provides:
- Local-first slide viewing (SVS, NDPI formats)
- Offline capability with automatic cloud sync
- Seamless local/remote experience via `https://app.supernavi.app`

## Architecture (Edge-First Design)

```
┌─────────────────┐     ┌──────────────────┐
│  Browser UI     │────▶│  Local Agent     │──── Local Slide Storage
│  (app.supernavi)│     │  (Windows)       │
└─────────────────┘     └──────────────────┘
         │                      │
         └──────────┬───────────┘
                    ▼
            ┌───────────────┐
            │  Cloud Sync   │
            │  (Remote/Collab)
            └───────────────┘
```

**Key principle:** The system should work identically whether local agent is available or not. Users never choose between "local" or "remote" mode.

## Target Platform

- **Windows 10/11 (64-bit)** only
- Minimum: i5/Ryzen 5, 16GB RAM, SSD with 500GB+ free
- Consider offline-first patterns for all features

## Development Guidelines

### Slide File Handling
- Support SVS, NDPI and common digital pathology formats
- Files can be very large (multi-GB) - use streaming/tiling approaches
- Local storage is the primary data source; cloud is for sync/backup

### Sync & Offline Behavior
- All features must work offline
- Sync should be automatic, non-blocking, and resumable
- Handle network failures gracefully - never lose local work

### Updates & Reliability
- Auto-update mechanism with rollback capability
- Never interrupt active slide viewing sessions
- Diagnostic export feature for support (no clinical data auto-sent)

## Conventions

<!-- TODO: Update as codebase develops -->
- **Language/Framework:** TBD
- **Project structure:** TBD
- **Testing approach:** TBD
- **Build commands:** TBD

## Important Context

- This is a **proprietary commercial product** - no open source distribution
- It's a visualization tool, NOT a diagnostic/reporting system
- The pathologist remains responsible for diagnosis
