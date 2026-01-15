# Sync Engine v0

Push-only synchronization from local outbox to cloud.

## Architecture

```
┌────────────────┐       ┌──────────────────┐       ┌────────────────┐
│    Local DB    │       │   Sync Engine    │       │   Cloud API    │
│                │       │                  │       │                │
│ outbox_events  │──────►│  Batch Reader    │──────►│ POST /v1/sync  │
│                │       │  Push Worker     │       │     /push      │
│ synced_at=NULL │       │  Backoff Logic   │       │                │
└────────────────┘       └──────────────────┘       └────────────────┘
```

## Flow

1. **Outbox Pattern**: All collaboration events (annotations, threads, messages, cases) are recorded to `outbox_events` table with `synced_at = NULL`

2. **Sync Loop**: Every `SYNC_INTERVAL_MS` (default 5s):
   - Fetch up to `SYNC_BATCH_SIZE` (default 50) pending events
   - Build payload with agent/lab identifiers
   - POST to cloud `/v1/sync/push`
   - Mark accepted events as synced
   - Handle rejections (permanent vs temporary)

3. **Error Handling**:
   - Exponential backoff on failure (1s → 2s → 4s → ... → 60s max)
   - Reset backoff on success
   - Max retry limit before pausing

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `DATABASE_URL` | postgres://...localhost | PostgreSQL connection string |
| `CLOUD_SYNC_URL` | http://mock-cloud:4000 | Cloud API base URL |
| `SYNC_TOKEN` | dev-token | Bearer token for authentication |
| `AGENT_ID` | local-agent-001 | Unique identifier for this agent |
| `LAB_ID` | lab-001 | Lab identifier |
| `SYNC_BATCH_SIZE` | 50 | Max events per sync cycle |
| `SYNC_INTERVAL_MS` | 5000 | Interval between sync cycles (ms) |
| `SYNC_MAX_RETRY` | 10 | Max consecutive failures before pause |

## API Endpoints

### GET /v1/sync/status

Returns current sync status.

```bash
curl http://localhost:3000/v1/sync/status
```

Response:
```json
{
  "cloudReachable": true,
  "cloudUrl": "http://mock-cloud:4000",
  "pendingCount": 5,
  "syncedCount": 123,
  "totalCount": 128,
  "lastSyncedAt": "2024-01-15T10:30:00.000Z",
  "oldestPendingAt": "2024-01-15T10:35:00.000Z"
}
```

### GET /v1/sync/pending

List pending events in outbox.

```bash
curl "http://localhost:3000/v1/sync/pending?limit=10"
```

Response:
```json
{
  "total": 5,
  "limit": 10,
  "offset": 0,
  "items": [
    {
      "eventId": "uuid",
      "entityType": "annotation",
      "entityId": "annotation-uuid",
      "op": "create",
      "payload": { ... },
      "createdAt": "2024-01-15T10:35:00.000Z"
    }
  ]
}
```

## Cloud Push Protocol

### POST /v1/sync/push

Request:
```json
{
  "agentId": "local-agent-001",
  "labId": "lab-001",
  "events": [
    {
      "eventId": "uuid",
      "entityType": "annotation",
      "entityId": "annotation-uuid",
      "op": "create",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "payload": {
        "slideId": "slide-uuid",
        "type": "polygon",
        "geometry": { "points": [...] },
        "style": { ... },
        "authorId": "user-123"
      }
    }
  ]
}
```

Headers:
```
Content-Type: application/json
Authorization: Bearer <SYNC_TOKEN>
X-Agent-Id: <AGENT_ID>
X-Lab-Id: <LAB_ID>
```

Response:
```json
{
  "accepted": ["event-uuid-1", "event-uuid-2"],
  "rejected": [
    {
      "eventId": "event-uuid-3",
      "reason": "invalid: missing required field"
    }
  ],
  "timestamp": "2024-01-15T10:30:01.000Z"
}
```

### Rejection Handling

- **Permanent rejections** (reason contains "invalid", "schema", "duplicate"): Mark as synced to prevent retry
- **Temporary rejections**: Keep pending for retry with backoff

## Outbox Events Schema

Events in `outbox_events` table:

| Field | Type | Description |
|-------|------|-------------|
| event_id | TEXT | Primary key (UUID) |
| entity_type | TEXT | "annotation", "thread", "message", "case" |
| entity_id | TEXT | ID of the entity |
| op | TEXT | "create", "update", "delete" |
| payload | JSONB | Full entity data |
| created_at | TIMESTAMP | Event creation time |
| synced_at | TIMESTAMP | When synced (NULL = pending) |

## Mock Cloud Server

For local testing, a mock cloud server is provided at `infra/mock-cloud/`.

Features:
- Accepts all valid events
- Simulates ~5% random temporary failures (for testing retry logic)
- Lists received events: `GET /v1/events`
- Clears events: `DELETE /v1/events`
- Health check: `GET /health`

```bash
# Check mock cloud health
curl http://localhost:4000/health

# List events received by mock cloud
curl http://localhost:4000/v1/events

# Clear mock cloud events
curl -X DELETE http://localhost:4000/v1/events
```

## Testing Sync Flow

1. Start all services:
```bash
docker compose up -d --build
```

2. Create some collaboration data:
```bash
# Create annotation
curl -X POST http://localhost:3000/v1/slides/{slideId}/annotations \
  -H "Content-Type: application/json" \
  -d '{"type":"rectangle","geometry":{"x":100,"y":100,"width":200,"height":150},"authorId":"test"}'
```

3. Check sync status:
```bash
curl http://localhost:3000/v1/sync/status
```

4. Check events received by mock cloud:
```bash
curl http://localhost:4000/v1/events
```

5. View sync engine logs:
```bash
docker compose logs -f sync
```

## Future Enhancements (v1+)

- **Bidirectional sync**: Pull changes from cloud
- **Conflict resolution**: Handle concurrent edits
- **Compression**: Gzip payload for large batches
- **Delta sync**: Only sync changed fields
- **Offline queue persistence**: Survive container restarts
- **Webhook notifications**: Real-time push from cloud
