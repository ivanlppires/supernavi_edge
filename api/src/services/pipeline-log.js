/**
 * Pipeline event logger (API service).
 *
 * Writes to slide_pipeline_events and, for errors, updates the denormalized
 * latest_error fields on slides. Also emits an SSE event so the dashboard
 * sees failures in real-time.
 *
 * Stages: ingest | p0 | p1 | tilegen | bigtiff | cloud_upload | outbox | sync | preview | cleanup
 * Levels: info | warn | error
 */

import { query } from '../db/index.js';
import { eventBus } from './events.js';

export async function pipelineLog(slideId, stage, level, message, details = null) {
  if (!slideId || !stage || !level) {
    console.error('[pipeline-log] invalid call', { slideId, stage, level });
    return;
  }
  try {
    await query(
      `INSERT INTO slide_pipeline_events (slide_id, stage, level, message, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [slideId, stage, level, message || null, details ? JSON.stringify(details) : null]
    );
    if (level === 'error') {
      await query(
        `UPDATE slides
           SET latest_error = $1, latest_error_stage = $2, latest_error_at = NOW()
         WHERE id = $3`,
        [message || 'unknown error', stage, slideId]
      );
      eventBus.emit('sse', {
        event: 'pipeline:error',
        data: { slideId, stage, message, timestamp: Date.now() }
      });
    } else if (level === 'info') {
      // Stage made progress — supersede any prior error from the same stage.
      // A subsequent failure will re-set latest_error via the branch above.
      await query(
        `UPDATE slides
           SET latest_error = NULL, latest_error_stage = NULL, latest_error_at = NULL
         WHERE id = $1 AND latest_error_stage = $2`,
        [slideId, stage]
      );
    }
  } catch (err) {
    console.error(`[pipeline-log] failed to record event (non-fatal): ${err.message}`);
  }
}
