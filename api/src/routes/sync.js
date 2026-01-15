/**
 * Sync Status Routes
 */

import { getPool } from '../db/index.js';

const CLOUD_SYNC_URL = process.env.CLOUD_SYNC_URL || 'http://mock-cloud:4000';

/**
 * Get sync status and outbox statistics
 */
async function getSyncStatus() {
  const pool = getPool();

  // Get pending count
  const pendingResult = await pool.query(
    'SELECT COUNT(*) as count FROM outbox_events WHERE synced_at IS NULL'
  );
  const pendingCount = parseInt(pendingResult.rows[0].count, 10);

  // Get synced count
  const syncedResult = await pool.query(
    'SELECT COUNT(*) as count FROM outbox_events WHERE synced_at IS NOT NULL'
  );
  const syncedCount = parseInt(syncedResult.rows[0].count, 10);

  // Get last synced event
  const lastSyncedResult = await pool.query(
    'SELECT synced_at FROM outbox_events WHERE synced_at IS NOT NULL ORDER BY synced_at DESC LIMIT 1'
  );
  const lastSyncedAt = lastSyncedResult.rows[0]?.synced_at || null;

  // Get oldest pending event
  const oldestPendingResult = await pool.query(
    'SELECT created_at FROM outbox_events WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT 1'
  );
  const oldestPendingAt = oldestPendingResult.rows[0]?.created_at || null;

  // Try to reach cloud
  let cloudReachable = false;
  try {
    const response = await fetch(`${CLOUD_SYNC_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    cloudReachable = response.ok;
  } catch {
    cloudReachable = false;
  }

  return {
    cloudReachable,
    cloudUrl: CLOUD_SYNC_URL,
    pendingCount,
    syncedCount,
    totalCount: pendingCount + syncedCount,
    lastSyncedAt,
    oldestPendingAt
  };
}

/**
 * Get pending outbox events
 */
async function getPendingEvents(limit = 50, offset = 0) {
  const pool = getPool();

  const result = await pool.query(
    `SELECT event_id, entity_type, entity_id, op, payload, created_at
     FROM outbox_events
     WHERE synced_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows.map(row => ({
    eventId: row.event_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    op: row.op,
    payload: row.payload,
    createdAt: row.created_at
  }));
}

export default async function syncRoutes(app) {
  // GET /v1/sync/status - Get sync status
  app.get('/sync/status', async (request, reply) => {
    try {
      const status = await getSyncStatus();
      return status;
    } catch (err) {
      request.log.error({ err }, 'Failed to get sync status');
      return reply.code(500).send({ error: 'Failed to get sync status' });
    }
  });

  // GET /v1/sync/pending - List pending events
  app.get('/sync/pending', async (request, reply) => {
    try {
      const limit = Math.min(parseInt(request.query.limit) || 50, 200);
      const offset = parseInt(request.query.offset) || 0;

      const events = await getPendingEvents(limit, offset);
      const status = await getSyncStatus();

      return {
        total: status.pendingCount,
        limit,
        offset,
        items: events
      };
    } catch (err) {
      request.log.error({ err }, 'Failed to list pending events');
      return reply.code(500).send({ error: 'Failed to list pending events' });
    }
  });
}
