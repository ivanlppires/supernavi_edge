/**
 * Pipeline event logger for the sync service.
 *
 * Writes to slide_pipeline_events. Sync only logs events under the `sync` stage,
 * and only for slide-related entities (slide, preview).
 */

export async function pipelineLog(pool, slideId, stage, level, message, details = null) {
  if (!pool || !slideId || !stage || !level) return;
  try {
    await pool.query(
      `INSERT INTO slide_pipeline_events (slide_id, stage, level, message, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [slideId, stage, level, message || null, details ? JSON.stringify(details) : null]
    );
    if (level === 'error') {
      await pool.query(
        `UPDATE slides
           SET latest_error = $1, latest_error_stage = $2, latest_error_at = NOW()
         WHERE id = $3`,
        [message || 'sync error', stage, slideId]
      );
    } else if (level === 'info') {
      // Stage made progress — supersede any prior error from the same stage.
      await pool.query(
        `UPDATE slides
           SET latest_error = NULL, latest_error_stage = NULL, latest_error_at = NULL
         WHERE id = $1 AND latest_error_stage = $2`,
        [slideId, stage]
      );
    }
  } catch (err) {
    console.error(`[pipeline-log] failed (non-fatal): ${err.message}`);
  }
}

/**
 * Record a sync rejection in sync_failures (upsert, increments attempts).
 */
export async function recordSyncFailure(pool, eventId, entityType, entityId, reason, httpStatus, isPermanent) {
  try {
    await pool.query(
      `INSERT INTO sync_failures (event_id, entity_type, entity_id, reason, http_status, is_permanent, attempts, first_attempt_at, last_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, NOW(), NOW())
       ON CONFLICT (event_id) DO UPDATE
         SET reason = EXCLUDED.reason,
             http_status = EXCLUDED.http_status,
             is_permanent = EXCLUDED.is_permanent,
             attempts = sync_failures.attempts + 1,
             last_attempt_at = NOW()`,
      [eventId, entityType || null, entityId || null, reason || null, httpStatus || null, !!isPermanent]
    );
  } catch (err) {
    console.error(`[sync-failures] failed to record (non-fatal): ${err.message}`);
  }
}
