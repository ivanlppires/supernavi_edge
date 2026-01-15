/**
 * SuperNavi Sync Engine v0
 *
 * Push-only synchronization from local outbox to cloud.
 * Reads outbox_events, batches them, and POSTs to cloud API.
 */

import pg from 'pg';
import { config, log } from './config.js';

const { Pool } = pg;

let pool = null;
let currentBackoffMs = config.initialBackoffMs;
let consecutiveFailures = 0;
let lastSyncAt = null;
let syncEnabled = true;

/**
 * Get database pool
 */
function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl });
    pool.on('error', (err) => {
      log.error('Database pool error', { error: err.message });
    });
  }
  return pool;
}

/**
 * Fetch pending events from outbox
 */
async function fetchPendingEvents(limit) {
  const result = await getPool().query(
    `SELECT event_id, entity_type, entity_id, op, payload, created_at
     FROM outbox_events
     WHERE synced_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Mark events as synced
 */
async function markEventsSynced(eventIds) {
  if (eventIds.length === 0) return;

  await getPool().query(
    `UPDATE outbox_events
     SET synced_at = NOW()
     WHERE event_id = ANY($1)`,
    [eventIds]
  );
}

/**
 * Get pending count
 */
async function getPendingCount() {
  const result = await getPool().query(
    'SELECT COUNT(*) as count FROM outbox_events WHERE synced_at IS NULL'
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Build sync payload
 */
function buildPayload(events) {
  return {
    agentId: config.agentId,
    labId: config.labId,
    events: events.map(e => ({
      eventId: e.event_id,
      entityType: e.entity_type,
      entityId: e.entity_id,
      op: e.op,
      createdAt: e.created_at,
      payload: e.payload
    }))
  };
}

/**
 * Push events to cloud
 */
async function pushToCloud(payload) {
  const url = `${config.cloudSyncUrl}/v1/sync/push`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.syncToken}`,
      'X-Agent-Id': config.agentId,
      'X-Lab-Id': config.labId
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000) // 30s timeout
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'No body');
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

/**
 * Process sync response
 */
async function processSyncResponse(response, sentEvents) {
  const accepted = response.accepted || [];
  const rejected = response.rejected || [];

  // Mark accepted events as synced
  if (accepted.length > 0) {
    await markEventsSynced(accepted);
    log.info('Events synced successfully', { count: accepted.length });
  }

  // Handle rejected events
  for (const rejection of rejected) {
    const { eventId, reason } = rejection;

    // Check if it's a permanent error (invalid schema, etc.)
    const isPermanent = reason?.includes('invalid') ||
                        reason?.includes('schema') ||
                        reason?.includes('duplicate');

    if (isPermanent) {
      // Mark as synced to prevent retry
      await markEventsSynced([eventId]);
      log.warn('Event permanently rejected', { eventId, reason });
    } else {
      // Keep pending for retry
      log.warn('Event temporarily rejected', { eventId, reason });
    }
  }

  return {
    accepted: accepted.length,
    rejected: rejected.length
  };
}

/**
 * Calculate exponential backoff
 */
function calculateBackoff() {
  currentBackoffMs = Math.min(
    currentBackoffMs * 2,
    config.maxBackoffMs
  );
  return currentBackoffMs;
}

/**
 * Reset backoff on success
 */
function resetBackoff() {
  currentBackoffMs = config.initialBackoffMs;
  consecutiveFailures = 0;
}

/**
 * Main sync cycle
 */
async function syncCycle() {
  if (!syncEnabled) return;

  try {
    // Fetch pending events
    const events = await fetchPendingEvents(config.syncBatchSize);

    if (events.length === 0) {
      log.debug('No pending events');
      resetBackoff();
      return;
    }

    log.info('Syncing events', { count: events.length });

    // Build and send payload
    const payload = buildPayload(events);
    const response = await pushToCloud(payload);

    // Process response
    const result = await processSyncResponse(response, events);

    lastSyncAt = new Date().toISOString();
    resetBackoff();

    log.info('Sync cycle complete', {
      accepted: result.accepted,
      rejected: result.rejected
    });

  } catch (err) {
    consecutiveFailures++;
    const backoff = calculateBackoff();

    log.error('Sync failed', {
      error: err.message,
      consecutiveFailures,
      nextRetryMs: backoff
    });

    // Check if we've exceeded max retries
    if (consecutiveFailures >= config.syncMaxRetry) {
      log.error('Max retries exceeded, pausing sync', {
        maxRetry: config.syncMaxRetry
      });
      // Will resume after backoff
    }

    // Wait for backoff before next cycle
    await new Promise(r => setTimeout(r, backoff));
  }
}

/**
 * Start sync loop
 */
async function startSyncLoop() {
  log.info('Starting sync loop', {
    cloudUrl: config.cloudSyncUrl,
    agentId: config.agentId,
    labId: config.labId,
    batchSize: config.syncBatchSize,
    intervalMs: config.syncIntervalMs
  });

  // Wait for database to be ready
  let dbReady = false;
  let retries = 10;

  while (!dbReady && retries > 0) {
    try {
      await getPool().query('SELECT 1');
      dbReady = true;
      log.info('Database connected');
    } catch (err) {
      retries--;
      log.warn('Database not ready', { retriesLeft: retries });
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!dbReady) {
    log.error('Failed to connect to database');
    process.exit(1);
  }

  // Initial pending count
  const pending = await getPendingCount();
  log.info('Sync engine ready', { pendingEvents: pending });

  // Main loop
  while (true) {
    await syncCycle();
    await new Promise(r => setTimeout(r, config.syncIntervalMs));
  }
}

/**
 * Get sync status (for API endpoint)
 */
export async function getSyncStatus() {
  try {
    const pendingCount = await getPendingCount();

    // Try to reach cloud
    let cloudReachable = false;
    try {
      const response = await fetch(`${config.cloudSyncUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      cloudReachable = response.ok;
    } catch {
      cloudReachable = false;
    }

    return {
      cloudReachable,
      lastSyncAt,
      pendingCount,
      consecutiveFailures,
      syncEnabled,
      config: {
        cloudSyncUrl: config.cloudSyncUrl,
        agentId: config.agentId,
        labId: config.labId,
        batchSize: config.syncBatchSize,
        intervalMs: config.syncIntervalMs
      }
    };
  } catch (err) {
    return {
      cloudReachable: false,
      lastSyncAt,
      pendingCount: -1,
      error: err.message
    };
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  log.info('Shutting down sync engine');
  syncEnabled = false;
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('Shutting down sync engine');
  syncEnabled = false;
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

// Start
startSyncLoop();
