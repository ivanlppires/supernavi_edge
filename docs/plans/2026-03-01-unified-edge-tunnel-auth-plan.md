# Unified Edge Tunnel Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate tunnel WebSocket auth from shared `EDGE_TUNNEL_TOKEN` to per-edge `EdgeKey` DB lookup, with backward compatibility.

**Architecture:** The cloud tunnel endpoint (`/edge/connect`) will hash the Bearer token with SHA-256 and look it up in the `edge_keys` table (same as Edge API auth). If no match, falls back to `EDGE_TUNNEL_TOKEN` env var. The edge tunnel client reads `EDGE_KEY` first, falling back to `EDGE_TUNNEL_TOKEN`.

**Tech Stack:** TypeScript (cloud, vitest), Node.js ES Modules (edge, node:test), Prisma, WebSocket

---

### Task 1: Add labId/labName to EdgeConnection (Cloud)

**Files:**
- Modify: `supernavi_cloud/src/modules/edge/connectionManager.ts:29-35` (EdgeConnection interface)
- Modify: `supernavi_cloud/src/modules/edge/connectionManager.ts:55-77` (registerEdge function)
- Modify: `supernavi_cloud/src/modules/edge/connectionManager.ts:115-122` (getConnectionInfo function)

**Step 1: Update EdgeConnection interface**

In `supernavi_cloud/src/modules/edge/connectionManager.ts`, add `labId` and `labName` to the `EdgeConnection` interface:

```typescript
interface EdgeConnection {
  ws: WebSocket;
  agentId: string;
  connectedAt: Date;
  lastSeen: Date;
  pendingRequests: Map<string, PendingRequest>;
  labId: string | null;
  labName: string | null;
}
```

**Step 2: Update registerEdge to accept lab info**

Change the `registerEdge` function signature and body:

```typescript
export function registerEdge(
  agentId: string,
  ws: WebSocket,
  options?: { labId?: string; labName?: string },
): void {
  // ... existing close-old-connection logic stays the same ...

  edgeConnections.set(agentId, {
    ws,
    agentId,
    connectedAt: new Date(),
    lastSeen: new Date(),
    pendingRequests: new Map(),
    labId: options?.labId ?? null,
    labName: options?.labName ?? null,
  });

  const labInfo = options?.labName ? ` (lab: ${options.labName})` : '';
  console.log(`[EdgeManager] Agent registered: ${agentId}${labInfo}`);
}
```

**Step 3: Update getConnectionInfo return type**

```typescript
export function getConnectionInfo(agentId: string): {
  connectedAt: Date;
  lastSeen: Date;
  labId: string | null;
  labName: string | null;
} | null {
  const connection = edgeConnections.get(agentId);
  if (!connection) return null;
  return {
    connectedAt: connection.connectedAt,
    lastSeen: connection.lastSeen,
    labId: connection.labId,
    labName: connection.labName,
  };
}
```

**Step 4: Verify it compiles**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_cloud && npx tsc --noEmit`
Expected: No errors (registerEdge callers still pass 2 args, third is optional)

**Step 5: Run existing tests**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_cloud && npm run test`
Expected: All pass (no behavioral change)

**Step 6: Commit**

```bash
cd /home/ivanpires/Business/supernavi/supernavi_cloud
git add src/modules/edge/connectionManager.ts
git commit -m "feat(edge): add labId/labName to EdgeConnection for per-edge tracking"
```

---

### Task 2: Replace validateTunnelToken with DB-backed auth (Cloud)

**Files:**
- Modify: `supernavi_cloud/src/modules/edge/routes.ts:1-17` (imports)
- Modify: `supernavi_cloud/src/modules/edge/routes.ts:49-56` (validateTunnelToken → authenticateTunnelConnection)
- Modify: `supernavi_cloud/src/modules/edge/routes.ts:78-106` (WebSocket handler auth logic)

**Step 1: Write the test**

Create `supernavi_cloud/tests/tunnel-auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '../src/db/index.js';
import { authenticateTunnelConnection } from '../src/modules/edge/routes.js';

// Helper: create a lab + edge key in DB, return raw key
async function createTestEdgeKey(labName: string) {
  const lab = await prisma.lab.create({ data: { name: labName } });
  const rawKey = randomBytes(32).toString('hex');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const edgeKey = await prisma.edgeKey.create({
    data: { labId: lab.id, name: `${labName}-edge`, keyHash },
  });
  return { lab, edgeKey, rawKey };
}

describe('authenticateTunnelConnection', () => {
  it('authenticates valid edge key from DB', async () => {
    const { rawKey, edgeKey, lab } = await createTestEdgeKey('test-lab-auth');
    const result = await authenticateTunnelConnection(rawKey, 'ignored-agent');
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe(edgeKey.id);
    expect(result!.labId).toBe(lab.id);
    expect(result!.labName).toBe('test-lab-auth');
    // Cleanup
    await prisma.edgeKey.delete({ where: { id: edgeKey.id } });
    await prisma.lab.delete({ where: { id: lab.id } });
  });

  it('rejects inactive edge key', async () => {
    const { rawKey, edgeKey, lab } = await createTestEdgeKey('test-lab-inactive');
    await prisma.edgeKey.update({ where: { id: edgeKey.id }, data: { isActive: false } });
    const result = await authenticateTunnelConnection(rawKey, 'ignored-agent');
    expect(result).toBeNull();
    // Cleanup
    await prisma.edgeKey.delete({ where: { id: edgeKey.id } });
    await prisma.lab.delete({ where: { id: lab.id } });
  });

  it('rejects unknown token when no EDGE_TUNNEL_TOKEN fallback', async () => {
    const result = await authenticateTunnelConnection('bogus-token', 'some-agent');
    expect(result).toBeNull();
  });

  it('returns null for undefined token', async () => {
    const result = await authenticateTunnelConnection(undefined, 'some-agent');
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_cloud && npm run test -- tunnel-auth`
Expected: FAIL — `authenticateTunnelConnection` is not exported from routes.ts

**Step 3: Implement authenticateTunnelConnection**

In `supernavi_cloud/src/modules/edge/routes.ts`:

1. Add imports at top:
```typescript
import { createHash } from 'crypto';
import { prisma } from '../../db/index.js';
```

2. Replace `validateTunnelToken` with:
```typescript
/**
 * Authenticate a tunnel connection token.
 * 1. Try EdgeKey DB lookup (SHA-256 hash match, isActive=true)
 * 2. Fallback: compare against EDGE_TUNNEL_TOKEN env var (deprecated)
 * Returns { agentId, labId, labName } on success, null on failure.
 */
export async function authenticateTunnelConnection(
  token: string | undefined,
  agentIdParam: string | undefined,
): Promise<{ agentId: string; labId: string | null; labName: string | null } | null> {
  if (!token) return null;

  // Path 1: EdgeKey DB lookup
  const keyHash = createHash('sha256').update(token).digest('hex');
  const edgeKey = await prisma.edgeKey.findFirst({
    where: { keyHash, isActive: true },
    include: { lab: true },
  });

  if (edgeKey) {
    return {
      agentId: edgeKey.id,
      labId: edgeKey.labId,
      labName: edgeKey.lab.name,
    };
  }

  // Path 2: Legacy EDGE_TUNNEL_TOKEN fallback (deprecated)
  if (config.EDGE_TUNNEL_TOKEN && token === config.EDGE_TUNNEL_TOKEN) {
    if (!agentIdParam) return null;
    console.warn('[EdgeRoutes] Using deprecated EDGE_TUNNEL_TOKEN — migrate to EdgeKey');
    return {
      agentId: agentIdParam,
      labId: null,
      labName: null,
    };
  }

  return null;
}
```

3. Update the WebSocket handler to use the new async auth:

Replace lines 78-106 (inside `fastify.get('/edge/connect', ...)`) with:

```typescript
  fastify.get('/edge/connect', { websocket: true }, async (socket, request) => {
    const query = request.query as { agentId?: string };
    const agentIdParam = query.agentId;
    const token = extractToken(request);

    // Authenticate (DB lookup with legacy fallback)
    const auth = await authenticateTunnelConnection(token, agentIdParam);

    if (!auth) {
      request.log.warn({ agentId: agentIdParam }, 'Edge connection rejected: invalid token');
      socket.close(4001, 'Unauthorized: Invalid token');
      return;
    }

    const agentId = auth.agentId;

    // Validate agentId format (UUIDs from DB always pass; legacy agentIds validated)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      request.log.warn({ agentId }, 'Edge connection rejected: invalid agentId format');
      socket.close(4003, 'Bad Request: Invalid agentId format');
      return;
    }

    request.log.info(
      { agentId, labName: auth.labName },
      'Edge agent connected',
    );
    registerEdge(agentId, socket, { labId: auth.labId ?? undefined, labName: auth.labName ?? undefined });
```

The rest of the handler (ping, pong, message, close, error) stays identical — they already use the `agentId` variable.

**Step 4: Run test to verify it passes**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_cloud && npm run test -- tunnel-auth`
Expected: All 4 tests pass

**Step 5: Verify typecheck**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_cloud && npx tsc --noEmit`
Expected: No errors

**Step 6: Run full test suite**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_cloud && npm run test`
Expected: All pass

**Step 7: Commit**

```bash
cd /home/ivanpires/Business/supernavi/supernavi_cloud
git add src/modules/edge/routes.ts tests/tunnel-auth.test.ts
git commit -m "feat(edge): replace shared tunnel token with per-edge EdgeKey auth"
```

---

### Task 3: Update /edge/status to show lab info (Cloud)

**Files:**
- Modify: `supernavi_cloud/src/modules/edge/routes.ts:152-166` (GET /edge/status handler)

**Step 1: Update the status endpoint**

In the `GET /edge/status` handler, add `labId` and `labName` to each agent object:

```typescript
  fastify.get('/edge/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const agents = getConnectedAgents().map((agentId) => {
      const info = getConnectionInfo(agentId);
      return {
        agentId,
        connectedAt: info?.connectedAt.toISOString(),
        lastSeen: info?.lastSeen.toISOString(),
        labId: info?.labId ?? null,
        labName: info?.labName ?? null,
      };
    });

    return reply.send({
      connectedAgents: agents.length,
      agents,
    });
  });
```

**Step 2: Verify typecheck**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_cloud && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
cd /home/ivanpires/Business/supernavi/supernavi_cloud
git add src/modules/edge/routes.ts
git commit -m "feat(edge): show labId/labName in /edge/status endpoint"
```

---

### Task 4: Update edge tunnel client to use EDGE_KEY (Edge)

**Files:**
- Modify: `supernavi_edge/api/src/services/tunnel.js:10-13` (env var reading)
- Modify: `supernavi_edge/api/src/services/tunnel.js:44-67` (startTunnel validation)
- Modify: `supernavi_edge/api/src/services/tunnel.js:78-86` (connect — URL and headers)
- Modify: `supernavi_edge/api/src/services/tunnel.js:284-291` (getTunnelStatus)

**Step 1: Update env var reading**

Replace lines 10-13:

```javascript
// Token resolution: EDGE_KEY (preferred) → EDGE_TUNNEL_TOKEN (deprecated fallback)
const EDGE_KEY = process.env.EDGE_KEY || '';
const EDGE_TUNNEL_TOKEN = process.env.EDGE_TUNNEL_TOKEN || '';
const TUNNEL_TOKEN = EDGE_KEY || EDGE_TUNNEL_TOKEN;
const EDGE_AGENT_ID = process.env.EDGE_AGENT_ID || '';

// Configuration from environment
const CLOUD_TUNNEL_URL = process.env.CLOUD_TUNNEL_URL || '';
```

**Step 2: Update startTunnel validation**

Replace the `startTunnel` function:

```javascript
export function startTunnel() {
  if (!CLOUD_TUNNEL_URL) {
    console.log('[Tunnel] CLOUD_TUNNEL_URL not configured, tunnel disabled');
    return;
  }

  if (!TUNNEL_TOKEN) {
    console.log('[Tunnel] Neither EDGE_KEY nor EDGE_TUNNEL_TOKEN configured, tunnel disabled');
    return;
  }

  if (!fastifyApp) {
    console.error('[Tunnel] Fastify app not initialized, call initTunnel first');
    return;
  }

  // Log which auth mechanism is in use
  if (EDGE_KEY) {
    console.log(`[Tunnel] Connecting to ${CLOUD_TUNNEL_URL} using EDGE_KEY...`);
  } else {
    console.warn(`[Tunnel] Connecting to ${CLOUD_TUNNEL_URL} using deprecated EDGE_TUNNEL_TOKEN — migrate to EDGE_KEY`);
  }

  if (EDGE_AGENT_ID) {
    console.log(`[Tunnel] Agent ID (display): ${EDGE_AGENT_ID}`);
  }

  connect();
}
```

**Step 3: Update connect function**

In the `connect()` function, update URL building and auth header:

```javascript
function connect() {
  if (isShuttingDown) {
    return;
  }

  // Build URL with query params
  const url = new URL(CLOUD_TUNNEL_URL);
  // agentId is optional now (cloud derives from EdgeKey), but still sent for display/legacy
  if (EDGE_AGENT_ID) {
    url.searchParams.set('agentId', EDGE_AGENT_ID);
  }

  try {
    ws = new WebSocket(url.toString(), {
      headers: {
        'Authorization': `Bearer ${TUNNEL_TOKEN}`,
      },
    });
```

Also update the `on('open')` log message:

```javascript
    ws.on('open', () => {
      const idInfo = EDGE_AGENT_ID ? ` as ${EDGE_AGENT_ID}` : '';
      console.log(`[Tunnel] Connected to cloud${idInfo}`);
      // Reset reconnect delay on successful connection
      reconnectDelay = INITIAL_RECONNECT_DELAY;
      // Start client-side keepalive pings
      startPingInterval();
    });
```

**Step 4: Update getTunnelStatus**

```javascript
export function getTunnelStatus() {
  return {
    configured: !!(CLOUD_TUNNEL_URL && TUNNEL_TOKEN),
    connected: isTunnelConnected(),
    agentId: EDGE_AGENT_ID || null,
    cloudUrl: CLOUD_TUNNEL_URL || null,
    authMode: EDGE_KEY ? 'edge_key' : (EDGE_TUNNEL_TOKEN ? 'legacy_token' : 'none'),
  };
}
```

**Step 5: Verify it works locally**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_edge && docker compose build api`
Expected: Build succeeds

**Step 6: Commit**

```bash
cd /home/ivanpires/Business/supernavi/supernavi_edge
git add api/src/services/tunnel.js
git commit -m "feat(tunnel): use EDGE_KEY for tunnel auth with EDGE_TUNNEL_TOKEN fallback"
```

---

### Task 5: Update docker-compose.yml and document deprecation (Edge)

**Files:**
- Modify: `supernavi_edge/docker-compose.yml:22-26` (api environment section)

**Step 1: Update docker-compose.yml**

In the `api` service environment section, add `EDGE_KEY` and add a comment marking `EDGE_TUNNEL_TOKEN` as deprecated:

```yaml
      # Edge Authentication (used for both tunnel and Edge API)
      EDGE_KEY: ${EDGE_KEY:-}
      # Edge Tunnel Configuration
      CLOUD_TUNNEL_URL: ${CLOUD_TUNNEL_URL:-}
      # DEPRECATED: Use EDGE_KEY instead. Kept for backward compatibility.
      EDGE_TUNNEL_TOKEN: ${EDGE_TUNNEL_TOKEN:-}
      EDGE_AGENT_ID: ${EDGE_AGENT_ID:-}
```

**Step 2: Commit**

```bash
cd /home/ivanpires/Business/supernavi/supernavi_edge
git add docker-compose.yml
git commit -m "chore: add EDGE_KEY to docker-compose, mark EDGE_TUNNEL_TOKEN as deprecated"
```

---

### Task 6: Add deprecation comment to cloud config (Cloud)

**Files:**
- Modify: `supernavi_cloud/src/config/index.ts:23-24` (EDGE_TUNNEL_TOKEN comment)

**Step 1: Update the comment**

```typescript
  // Edge Tunnel Authentication
  // DEPRECATED: Legacy shared token. Tunnel now uses EdgeKey (edge_keys table).
  // Keep for backward compatibility during migration. Remove once all edges use EDGE_KEY.
  EDGE_TUNNEL_TOKEN: z.string().optional(),
```

**Step 2: Commit**

```bash
cd /home/ivanpires/Business/supernavi/supernavi_cloud
git add src/config/index.ts
git commit -m "chore: mark EDGE_TUNNEL_TOKEN as deprecated in config schema"
```

---

### Task 7: End-to-end verification

**Step 1: Rebuild and start edge**

```bash
cd /home/ivanpires/Business/supernavi/supernavi_edge
docker compose down && docker compose up -d --build
```

**Step 2: Check tunnel connects with EDGE_KEY**

Set `EDGE_KEY` in `.env` (same value the processor uses). Remove or keep `EDGE_TUNNEL_TOKEN`.

```bash
docker compose logs -f api 2>&1 | grep '\[Tunnel\]'
```

Expected: `[Tunnel] Connecting to ... using EDGE_KEY...` followed by `[Tunnel] Connected to cloud`

**Step 3: Verify /edge/status on cloud shows lab info**

```bash
curl https://cloud.supernavi.app/edge/status | jq
```

Expected: Each agent entry includes `labId` and `labName` fields.

**Step 4: Verify tile proxy still works**

Open a slide via `https://cloud.supernavi.app/edge/<agentId>/v1/slides` and verify tiles load.

**Step 5: Commit any final adjustments**

If any env/config fixes were needed during verification, commit them.
