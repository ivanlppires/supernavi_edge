/**
 * Pipeline observability routes
 *
 * GET /v1/slides/:slideId/pipeline — chronological event timeline for a slide
 * GET /v1/dashboard/failures      — aggregated list of slides with problems +
 *                                   advisor-suggested next actions
 */

import { query } from '../db/index.js';
import { advise } from '../services/failure-advisor.js';

const STAGE_ORDER = ['ingest', 'p0', 'p1', 'tilegen', 'bigtiff', 'cloud_upload', 'outbox', 'sync', 'preview', 'cleanup'];

export default async function pipelineRoutes(fastify) {
  // Per-slide pipeline timeline
  fastify.get('/slides/:slideId/pipeline', async (request, reply) => {
    const { slideId } = request.params;
    const limit = Math.min(parseInt(request.query.limit, 10) || 200, 1000);

    const slideRow = await query(
      `SELECT id, original_filename, status, format, created_at,
              tilegen_status, cloud_upload_status, latest_error,
              latest_error_stage, latest_error_at
         FROM slides WHERE id = $1`,
      [slideId]
    );
    if (!slideRow.rows[0]) {
      reply.code(404);
      return { error: 'Slide not found' };
    }
    const slide = slideRow.rows[0];

    const eventsRow = await query(
      `SELECT id, stage, level, message, details, created_at
         FROM slide_pipeline_events
        WHERE slide_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [slideId, limit]
    );

    const jobsRow = await query(
      `SELECT id, type, status, error, created_at, updated_at
         FROM jobs WHERE slide_id = $1 ORDER BY created_at ASC`,
      [slideId]
    );

    const syncFailuresRow = await query(
      `SELECT sf.event_id, sf.entity_type, sf.reason, sf.http_status,
              sf.is_permanent, sf.attempts, sf.last_attempt_at
         FROM sync_failures sf
         JOIN outbox_events oe ON oe.event_id = sf.event_id
        WHERE (oe.entity_type = 'slide' AND oe.entity_id = $1)
           OR (oe.entity_type = 'preview' AND oe.entity_id = $2)
        ORDER BY sf.last_attempt_at DESC`,
      [slideId, `preview:${slideId}`]
    );

    const advice = slide.latest_error
      ? advise(slide.latest_error_stage || 'unknown', slide.latest_error)
      : null;

    return {
      slide: {
        slideId: slide.id,
        originalFilename: slide.original_filename,
        status: slide.status,
        format: slide.format,
        tilegenStatus: slide.tilegen_status,
        cloudUploadStatus: slide.cloud_upload_status,
        latestError: slide.latest_error,
        latestErrorStage: slide.latest_error_stage,
        latestErrorAt: slide.latest_error_at,
        createdAt: slide.created_at,
      },
      advice,
      events: eventsRow.rows.map(e => ({
        id: e.id,
        stage: e.stage,
        level: e.level,
        message: e.message,
        details: e.details,
        createdAt: e.created_at,
      })),
      jobs: jobsRow.rows.map(j => ({
        id: j.id,
        type: j.type,
        status: j.status,
        error: j.error,
        createdAt: j.created_at,
        updatedAt: j.updated_at,
      })),
      syncFailures: syncFailuresRow.rows.map(sf => ({
        eventId: sf.event_id,
        entityType: sf.entity_type,
        reason: sf.reason,
        httpStatus: sf.http_status,
        isPermanent: sf.is_permanent,
        attempts: sf.attempts,
        lastAttemptAt: sf.last_attempt_at,
      })),
    };
  });

  // Aggregated failures view for the dashboard
  fastify.get('/dashboard/failures', async () => {
    // Slides with status=failed OR latest_error set OR cloud_upload_status=failed
    // OR tilegen_status=failed
    const failedSlidesRow = await query(`
      SELECT id, original_filename, status, format, created_at,
             tilegen_status, cloud_upload_status,
             latest_error, latest_error_stage, latest_error_at
        FROM slides
       WHERE status = 'failed'
          OR latest_error IS NOT NULL
          OR cloud_upload_status = 'failed'
          OR tilegen_status = 'failed'
       ORDER BY COALESCE(latest_error_at, created_at) DESC
       LIMIT 100
    `);

    // Outbox events that haven't synced after >5 minutes (stuck)
    const stuckSyncRow = await query(`
      SELECT oe.event_id, oe.entity_type, oe.entity_id, oe.op, oe.created_at,
             sf.reason, sf.attempts, sf.is_permanent, sf.last_attempt_at, sf.http_status
        FROM outbox_events oe
        LEFT JOIN sync_failures sf ON sf.event_id = oe.event_id
       WHERE oe.synced_at IS NULL
         AND oe.created_at < NOW() - INTERVAL '5 minutes'
       ORDER BY oe.created_at ASC
       LIMIT 100
    `);

    const items = failedSlidesRow.rows.map(s => {
      const stage = s.latest_error_stage
        || (s.tilegen_status === 'failed' ? 'tilegen' : null)
        || (s.cloud_upload_status === 'failed' ? 'cloud_upload' : null)
        || 'unknown';
      const errMsg = s.latest_error
        || (s.tilegen_status === 'failed' ? 'Tile generation failed' : null)
        || (s.cloud_upload_status === 'failed' ? 'Cloud upload failed' : null)
        || 'Unknown error';
      const advice = advise(stage, errMsg);
      return {
        slideId: s.id,
        originalFilename: s.original_filename,
        status: s.status,
        format: s.format,
        stage,
        message: errMsg,
        tilegenStatus: s.tilegen_status,
        cloudUploadStatus: s.cloud_upload_status,
        errorAt: s.latest_error_at || s.created_at,
        createdAt: s.created_at,
        advice,
      };
    });

    return {
      failures: items,
      stuckSync: stuckSyncRow.rows.map(r => ({
        eventId: r.event_id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        op: r.op,
        createdAt: r.created_at,
        reason: r.reason,
        httpStatus: r.http_status,
        isPermanent: r.is_permanent,
        attempts: r.attempts || 0,
        lastAttemptAt: r.last_attempt_at,
      })),
      total: items.length,
      stuckSyncTotal: stuckSyncRow.rows.length,
    };
  });
}
