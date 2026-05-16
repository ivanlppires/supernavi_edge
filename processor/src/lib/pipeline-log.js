/**
 * Pipeline event logger — writes structured events to slide_pipeline_events
 * and (for errors) updates the denormalized latest_error fields on slides.
 *
 * Usage:
 *   await pipelineLog(pool, slideId, 'tilegen', 'error', 'vips dzsave failed: ENOSPC', { exitCode: 1 });
 *
 * Stages: ingest | p0 | p1 | tilegen | bigtiff | cloud_upload | outbox | sync | preview | cleanup
 * Levels: info | warn | error
 */

export async function pipelineLog(pool, slideId, stage, level, message, details = null) {
  if (!pool || !slideId || !stage || !level) {
    console.error('[pipeline-log] invalid call', { slideId, stage, level });
    return;
  }
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
        [message || 'unknown error', stage, slideId]
      );
    } else if (level === 'info') {
      // Stage made progress — supersede any prior error from the same stage.
      // A subsequent failure will re-set latest_error via the branch above.
      await pool.query(
        `UPDATE slides
           SET latest_error = NULL, latest_error_stage = NULL, latest_error_at = NULL
         WHERE id = $1 AND latest_error_stage = $2`,
        [slideId, stage]
      );
    }
  } catch (err) {
    // Logging must never break the pipeline.
    console.error(`[pipeline-log] failed to record event (non-fatal): ${err.message}`);
  }
}
