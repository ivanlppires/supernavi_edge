# SuperNavi Local Collaboration

## Overview

SuperNavi implements a **local-first collaboration layer** that enables:
- Organizing slides into diagnostic cases
- Geometric annotations on slides
- Discussion threads and messages
- Offline-capable collaboration with sync-ready architecture

All data is stored locally in PostgreSQL and changes are recorded in an **outbox table** for future cloud synchronization.

## Data Model

```
┌─────────────┐       ┌─────────────────┐       ┌─────────────┐
│   cases     │──────<│   case_slides   │>──────│   slides    │
└─────────────┘       └─────────────────┘       └──────┬──────┘
                                                       │
                                  ┌────────────────────┼────────────────────┐
                                  │                    │                    │
                                  ▼                    ▼                    ▼
                          ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
                          │ annotations │      │   threads   │──────│  messages   │
                          └─────────────┘      └─────────────┘      └─────────────┘

                          All changes ──────────────────────────────> outbox_events
```

### Tables

#### cases
Groups slides into diagnostic cases.

| Column | Type | Description |
|--------|------|-------------|
| case_id | TEXT PK | UUID identifier |
| title | TEXT | Case title |
| external_ref | TEXT | Optional external reference (LIS, etc.) |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last modification |

#### case_slides
Junction table linking cases to slides.

| Column | Type | Description |
|--------|------|-------------|
| case_id | TEXT FK | Reference to cases |
| slide_id | TEXT FK | Reference to slides |
| linked_at | TIMESTAMP | When the link was created |

#### annotations
Geometric annotations on slides with optimistic locking.

| Column | Type | Description |
|--------|------|-------------|
| annotation_id | TEXT PK | UUID identifier |
| slide_id | TEXT FK | Reference to slides |
| type | TEXT | polygon, rectangle, ellipse, point, line, freehand |
| geometry | JSONB | GeoJSON-like geometry data |
| style | JSONB | Visual style (color, stroke, etc.) |
| author_id | TEXT | User who created the annotation |
| version | INT | Optimistic locking version |
| idempotency_key | TEXT | For duplicate prevention |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last modification |
| deleted_at | TIMESTAMP | Soft delete timestamp |

#### threads
Discussion threads anchored to slides or annotations.

| Column | Type | Description |
|--------|------|-------------|
| thread_id | TEXT PK | UUID identifier |
| slide_id | TEXT FK | Reference to slides |
| anchor_type | TEXT | Optional: 'annotation', 'region', etc. |
| anchor_id | TEXT | Optional: ID of anchored element |
| title | TEXT | Thread title |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last modification |

#### messages
Messages within threads.

| Column | Type | Description |
|--------|------|-------------|
| message_id | TEXT PK | UUID identifier |
| thread_id | TEXT FK | Reference to threads |
| author_id | TEXT | User who wrote the message |
| text | TEXT | Message content |
| idempotency_key | TEXT | For duplicate prevention |
| created_at | TIMESTAMP | Creation time |

#### outbox_events
Event log for future cloud sync.

| Column | Type | Description |
|--------|------|-------------|
| event_id | TEXT PK | UUID identifier |
| entity_type | TEXT | case, annotation, thread, message, etc. |
| entity_id | TEXT | ID of the affected entity |
| op | TEXT | create, update, delete, link, unlink |
| payload | JSONB | Full entity state at time of operation |
| created_at | TIMESTAMP | When the operation occurred |
| synced_at | TIMESTAMP | When synced to cloud (null if pending) |

## API Endpoints

### Cases

#### Create Case
```http
POST /v1/cases
Content-Type: application/json

{
  "title": "Patient John Doe - Biopsy",
  "externalRef": "LIS-2024-001"  // optional
}
```

Response (201):
```json
{
  "caseId": "uuid",
  "title": "Patient John Doe - Biopsy",
  "externalRef": "LIS-2024-001",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

#### List Cases
```http
GET /v1/cases
```

Response:
```json
{
  "items": [
    {
      "caseId": "uuid",
      "title": "Patient John Doe - Biopsy",
      "externalRef": "LIS-2024-001",
      "slideCount": 3,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:35:00Z"
    }
  ]
}
```

#### Get Case (with linked slides)
```http
GET /v1/cases/:caseId
```

Response:
```json
{
  "caseId": "uuid",
  "title": "Patient John Doe - Biopsy",
  "externalRef": "LIS-2024-001",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:35:00Z",
  "slides": [
    {
      "slideId": "abc123...",
      "originalFilename": "slide1.svs",
      "status": "ready",
      "width": 50000,
      "height": 40000,
      "format": "svs",
      "linkedAt": "2024-01-15T10:32:00Z"
    }
  ]
}
```

#### Link Slide to Case
```http
POST /v1/cases/:caseId/slides
Content-Type: application/json

{
  "slideId": "abc123..."
}
```

Response (201):
```json
{
  "caseId": "uuid",
  "slideId": "abc123...",
  "linkedAt": "2024-01-15T10:32:00Z"
}
```

#### Unlink Slide from Case
```http
DELETE /v1/cases/:caseId/slides/:slideId
```

Response: 204 No Content

### Annotations

#### Get Annotations
```http
GET /v1/slides/:slideId/annotations?since=2024-01-15T00:00:00Z
```

Response:
```json
{
  "items": [
    {
      "annotationId": "uuid",
      "slideId": "abc123...",
      "type": "polygon",
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]]
      },
      "style": {
        "strokeColor": "#ff0000",
        "fillColor": "rgba(255,0,0,0.2)",
        "strokeWidth": 2
      },
      "authorId": "user-123",
      "version": 1,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

#### Create Annotation
```http
POST /v1/slides/:slideId/annotations
Content-Type: application/json

{
  "type": "polygon",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]]
  },
  "style": {
    "strokeColor": "#ff0000",
    "fillColor": "rgba(255,0,0,0.2)"
  },
  "authorId": "user-123",
  "idempotencyKey": "client-uuid-12345"  // optional, prevents duplicates
}
```

Response (201 if created, 200 if idempotent duplicate):
```json
{
  "annotationId": "uuid",
  "slideId": "abc123...",
  "type": "polygon",
  "geometry": {...},
  "style": {...},
  "authorId": "user-123",
  "version": 1,
  "createdAt": "2024-01-15T10:30:00Z",
  "created": true
}
```

#### Update Annotation (Optimistic Locking)
```http
PATCH /v1/annotations/:annotationId
Content-Type: application/json

{
  "expectedVersion": 1,
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[110, 110], [210, 110], [210, 210], [110, 210], [110, 110]]]
  }
}
```

Response (200 on success):
```json
{
  "annotationId": "uuid",
  "slideId": "abc123...",
  "type": "polygon",
  "geometry": {...},
  "style": {...},
  "authorId": "user-123",
  "version": 2,
  "updatedAt": "2024-01-15T10:35:00Z"
}
```

Response (409 on version conflict):
```json
{
  "error": "Version conflict",
  "expectedVersion": 1,
  "currentVersion": 3
}
```

#### Delete Annotation (Soft Delete)
```http
DELETE /v1/annotations/:annotationId?expectedVersion=2
```

Response: 204 No Content (on success)
Response: 409 Conflict (on version mismatch)

### Threads & Messages

#### Get Threads
```http
GET /v1/slides/:slideId/threads
```

Response:
```json
{
  "items": [
    {
      "threadId": "uuid",
      "slideId": "abc123...",
      "title": "Suspicious region",
      "anchorType": "annotation",
      "anchorId": "annotation-uuid",
      "messageCount": 5,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:45:00Z"
    }
  ]
}
```

#### Create Thread
```http
POST /v1/slides/:slideId/threads
Content-Type: application/json

{
  "title": "Discussion about this area",
  "anchor": {
    "type": "annotation",
    "id": "annotation-uuid"
  }
}
```

Response (201):
```json
{
  "threadId": "uuid",
  "slideId": "abc123...",
  "title": "Discussion about this area",
  "anchorType": "annotation",
  "anchorId": "annotation-uuid",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

#### Get Messages
```http
GET /v1/threads/:threadId/messages?since=2024-01-15T00:00:00Z
```

Response:
```json
{
  "threadId": "uuid",
  "items": [
    {
      "messageId": "uuid",
      "threadId": "uuid",
      "authorId": "user-123",
      "text": "I think this area needs further analysis.",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

#### Create Message
```http
POST /v1/threads/:threadId/messages
Content-Type: application/json

{
  "authorId": "user-456",
  "text": "I agree, let's discuss with the team.",
  "idempotencyKey": "client-uuid-67890"
}
```

Response (201):
```json
{
  "messageId": "uuid",
  "threadId": "uuid",
  "authorId": "user-456",
  "text": "I agree, let's discuss with the team.",
  "createdAt": "2024-01-15T10:31:00Z",
  "created": true
}
```

## SSE Events

All collaboration operations emit real-time events via SSE at `/v1/events`.

### Collaboration Events

| Event | Payload |
|-------|---------|
| `case.created` | `{ caseId, title, timestamp }` |
| `case.slide_linked` | `{ caseId, slideId, timestamp }` |
| `case.slide_unlinked` | `{ caseId, slideId, timestamp }` |
| `annotation.created` | `{ annotationId, slideId, type, authorId, timestamp }` |
| `annotation.updated` | `{ annotationId, slideId, version, timestamp }` |
| `annotation.deleted` | `{ annotationId, slideId, version, timestamp }` |
| `thread.created` | `{ threadId, slideId, title, anchorType, anchorId, timestamp }` |
| `message.created` | `{ messageId, threadId, slideId, authorId, timestamp }` |

### Example SSE Client

```javascript
const events = new EventSource('http://localhost:3000/v1/events');

events.addEventListener('annotation.created', (e) => {
  const data = JSON.parse(e.data);
  console.log(`New annotation: ${data.annotationId} on slide ${data.slideId}`);
});

events.addEventListener('message.created', (e) => {
  const data = JSON.parse(e.data);
  console.log(`New message in thread ${data.threadId}`);
});
```

## Local-First Architecture

### Offline Capability

All operations work offline because:
1. Data is stored in local PostgreSQL
2. No network requests required for CRUD operations
3. Changes are queued in outbox for later sync

### Conflict Resolution

**Annotations** use optimistic locking:
- Each annotation has a `version` field
- Updates require `expectedVersion` parameter
- Server rejects updates if versions don't match
- Client must fetch latest and retry

**Messages/Threads** are append-only:
- No updates, only creates
- Idempotency keys prevent duplicates
- Natural conflict-free design

### Outbox Pattern

Every operation records an event in `outbox_events`:

```sql
SELECT * FROM outbox_events WHERE synced_at IS NULL ORDER BY created_at;
```

Example outbox entry:
```json
{
  "event_id": "uuid",
  "entity_type": "annotation",
  "entity_id": "annotation-uuid",
  "op": "create",
  "payload": {
    "annotation_id": "...",
    "slide_id": "...",
    "type": "polygon",
    "geometry": {...},
    "version": 1,
    "created_at": "..."
  },
  "created_at": "2024-01-15T10:30:00Z",
  "synced_at": null
}
```

### Future Sync Implementation

When sync is implemented:
1. Sync service reads pending outbox events
2. Sends to cloud API
3. Marks as synced: `UPDATE outbox_events SET synced_at = NOW() WHERE event_id = $1`
4. Receives remote changes and applies locally
5. Handles conflicts using version numbers

## Testing

### Create a Case with Slides

```bash
# Create case
CASE_ID=$(curl -s -X POST http://localhost:3000/v1/cases \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Case"}' | jq -r '.caseId')

echo "Created case: $CASE_ID"

# Get available slides
SLIDE_ID=$(curl -s http://localhost:3000/v1/slides | jq -r '.items[0].slideId')

# Link slide to case
curl -X POST http://localhost:3000/v1/cases/$CASE_ID/slides \
  -H "Content-Type: application/json" \
  -d "{\"slideId\": \"$SLIDE_ID\"}"

# View case with slides
curl -s http://localhost:3000/v1/cases/$CASE_ID | jq
```

### Create and Update Annotation

```bash
SLIDE_ID=$(curl -s http://localhost:3000/v1/slides | jq -r '.items[0].slideId')

# Create annotation
ANNOTATION=$(curl -s -X POST http://localhost:3000/v1/slides/$SLIDE_ID/annotations \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rectangle",
    "geometry": {"x": 100, "y": 100, "width": 200, "height": 150},
    "style": {"strokeColor": "#ff0000"},
    "authorId": "test-user"
  }')

ANNOTATION_ID=$(echo $ANNOTATION | jq -r '.annotationId')
echo "Created annotation: $ANNOTATION_ID (version 1)"

# Update annotation
curl -X PATCH http://localhost:3000/v1/annotations/$ANNOTATION_ID \
  -H "Content-Type: application/json" \
  -d '{
    "expectedVersion": 1,
    "geometry": {"x": 110, "y": 110, "width": 220, "height": 170}
  }'

# List annotations
curl -s http://localhost:3000/v1/slides/$SLIDE_ID/annotations | jq
```

### Create Thread with Messages

```bash
SLIDE_ID=$(curl -s http://localhost:3000/v1/slides | jq -r '.items[0].slideId')

# Create thread
THREAD=$(curl -s -X POST http://localhost:3000/v1/slides/$SLIDE_ID/threads \
  -H "Content-Type: application/json" \
  -d '{"title": "Discussion Thread"}')

THREAD_ID=$(echo $THREAD | jq -r '.threadId')
echo "Created thread: $THREAD_ID"

# Add messages
curl -X POST http://localhost:3000/v1/threads/$THREAD_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"authorId": "user-1", "text": "First message"}'

curl -X POST http://localhost:3000/v1/threads/$THREAD_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"authorId": "user-2", "text": "Reply to first message"}'

# List messages
curl -s http://localhost:3000/v1/threads/$THREAD_ID/messages | jq
```

### Check Outbox

```bash
docker compose exec db psql -U supernavi -d supernavi \
  -c "SELECT entity_type, op, created_at FROM outbox_events ORDER BY created_at DESC LIMIT 10;"
```
