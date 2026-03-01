# Unified Edge Tunnel Auth Design

## Goal

Evolve tunnel authentication from a single shared `EDGE_TUNNEL_TOKEN` environment variable to per-edge authentication using the existing `edge_keys` table, enabling individual registration and revocation of edge devices.

## Current State

Two separate auth mechanisms exist:

1. **Edge API** (`X-EDGE-KEY` header): SHA-256 hash lookup against `edge_keys` table. Per-edge, revocable via `isActive` flag. Used by processor for uploads and sync.
2. **Tunnel WebSocket** (`Bearer` token): Direct string comparison against `EDGE_TUNNEL_TOKEN` env var. Single shared token for all edges. `agentId` passed as query parameter.

## Proposed Design

Unify both mechanisms: the tunnel validates the `Bearer` token against the `edge_keys` table using the same SHA-256 hash lookup the Edge API already uses.

### Auth Flow

```
Edge                              Cloud
  |                                 |
  ├─ GET /edge/connect              |
  │  Authorization: Bearer <EDGE_KEY>
  │  ?agentId=lab01 (optional)      |
  │                                 ├─ SHA-256(token)
  │                                 ├─ SELECT FROM edge_keys WHERE key_hash = ? AND is_active
  │                                 ├─ Found? → agentId = edgeKey.id, register
  │                                 ├─ Not found? → try EDGE_TUNNEL_TOKEN fallback
  │                                 └─ Neither? → close(4001)
  ← WebSocket connected ←
```

### agentId Derivation

- **New path (EdgeKey):** `agentId` = `edgeKey.id` (UUID). Unique per key. No manual configuration needed.
- **Legacy path (env var):** `agentId` from `?agentId=` query param (existing behavior).
- Edge can still pass `EDGE_AGENT_ID` as query param for display purposes, but the authoritative ID comes from the key.

### Cloud Changes

**`src/modules/edge/routes.ts`:**
- Replace `validateTunnelToken()` with `authenticateTunnelConnection(token, agentIdParam)`.
- New function: hash token with SHA-256, look up in `edge_keys` table via Prisma.
- Fallback: if not found in DB, compare against `EDGE_TUNNEL_TOKEN` env var (backward compat).
- Returns `{ agentId, labId, labName }` on success or `null` on failure.
- Pass `labId`/`labName` to `registerEdge()` for enriched status reporting.

**`src/modules/edge/connectionManager.ts`:**
- `EdgeConnection` gains optional `labId` and `labName` fields.
- `/edge/status` endpoint includes lab info per connected agent.

**`src/config/index.ts`:**
- `EDGE_TUNNEL_TOKEN` remains `optional()` for backward compat. Documented as deprecated.

### Edge Changes

**`api/src/services/tunnel.js`:**
- Token resolution order: `EDGE_KEY` (preferred) → `EDGE_TUNNEL_TOKEN` (deprecated fallback).
- `EDGE_AGENT_ID` becomes optional (cloud derives from key).
- Startup log indicates which auth mechanism is in use.

### Revocation

Set `isActive = false` on the `edge_keys` row. The edge is rejected on next WebSocket reconnect attempt (and on next Edge API request). No cloud restart needed.

### Backward Compatibility

During transition, the cloud accepts both:
- Token matching an `edge_key` hash → new path (agentId from key)
- Token matching `EDGE_TUNNEL_TOKEN` env var → legacy path (agentId from query param)

Once all edges migrate to `EDGE_KEY`, remove the `EDGE_TUNNEL_TOKEN` fallback.

### Files to Modify

| Repo | File | Change |
|------|------|--------|
| cloud | `src/modules/edge/routes.ts` | Replace `validateTunnelToken` with DB-backed auth |
| cloud | `src/modules/edge/connectionManager.ts` | Add `labId`/`labName` to EdgeConnection |
| cloud | `src/config/index.ts` | Mark `EDGE_TUNNEL_TOKEN` as deprecated |
| edge | `api/src/services/tunnel.js` | Use `EDGE_KEY` for tunnel auth |
| edge | `docker-compose.yml` | Document `EDGE_KEY` serves both tunnel and API |
