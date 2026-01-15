/**
 * Collaboration DB Queries
 * Cases, Annotations, Threads, Messages, Outbox
 */

import { query } from './index.js';

// ============================================================================
// Outbox Events
// ============================================================================

/**
 * Record an event in the outbox for future sync
 */
export async function recordOutboxEvent({ entityType, entityId, op, payload }) {
  const result = await query(
    `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [entityType, entityId, op, JSON.stringify(payload)]
  );
  return result.rows[0];
}

/**
 * Get pending outbox events (not yet synced)
 */
export async function getPendingOutboxEvents(limit = 100) {
  const result = await query(
    `SELECT * FROM outbox_events
     WHERE synced_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Mark outbox events as synced
 */
export async function markOutboxEventsSynced(eventIds) {
  if (eventIds.length === 0) return;
  await query(
    `UPDATE outbox_events
     SET synced_at = NOW()
     WHERE event_id = ANY($1)`,
    [eventIds]
  );
}

// ============================================================================
// Cases
// ============================================================================

/**
 * Create a new case
 */
export async function createCase({ title, externalRef = null }) {
  const result = await query(
    `INSERT INTO cases (title, external_ref)
     VALUES ($1, $2)
     RETURNING *`,
    [title, externalRef]
  );
  const caseRow = result.rows[0];

  // Record outbox event
  await recordOutboxEvent({
    entityType: 'case',
    entityId: caseRow.case_id,
    op: 'create',
    payload: caseRow
  });

  return caseRow;
}

/**
 * Get a case by ID with linked slides
 */
export async function getCase(caseId) {
  const caseResult = await query(
    'SELECT * FROM cases WHERE case_id = $1',
    [caseId]
  );
  if (caseResult.rows.length === 0) return null;

  const slidesResult = await query(
    `SELECT s.id, s.original_filename, s.status, s.width, s.height, s.format, cs.linked_at
     FROM case_slides cs
     JOIN slides s ON s.id = cs.slide_id
     WHERE cs.case_id = $1
     ORDER BY cs.linked_at ASC`,
    [caseId]
  );

  return {
    ...caseResult.rows[0],
    slides: slidesResult.rows
  };
}

/**
 * List all cases
 */
export async function listCases() {
  const result = await query(
    `SELECT c.*, COUNT(cs.slide_id) as slide_count
     FROM cases c
     LEFT JOIN case_slides cs ON cs.case_id = c.case_id
     GROUP BY c.case_id
     ORDER BY c.created_at DESC`
  );
  return result.rows;
}

/**
 * Link a slide to a case
 */
export async function linkSlideToCase(caseId, slideId) {
  const result = await query(
    `INSERT INTO case_slides (case_id, slide_id)
     VALUES ($1, $2)
     ON CONFLICT (case_id, slide_id) DO NOTHING
     RETURNING *`,
    [caseId, slideId]
  );

  if (result.rows.length > 0) {
    // Update case timestamp
    await query(
      'UPDATE cases SET updated_at = NOW() WHERE case_id = $1',
      [caseId]
    );

    // Record outbox event
    await recordOutboxEvent({
      entityType: 'case_slide',
      entityId: `${caseId}:${slideId}`,
      op: 'link',
      payload: { caseId, slideId, linkedAt: result.rows[0].linked_at }
    });
  }

  return result.rows[0] || null;
}

/**
 * Unlink a slide from a case
 */
export async function unlinkSlideFromCase(caseId, slideId) {
  const result = await query(
    `DELETE FROM case_slides
     WHERE case_id = $1 AND slide_id = $2
     RETURNING *`,
    [caseId, slideId]
  );

  if (result.rows.length > 0) {
    // Update case timestamp
    await query(
      'UPDATE cases SET updated_at = NOW() WHERE case_id = $1',
      [caseId]
    );

    // Record outbox event
    await recordOutboxEvent({
      entityType: 'case_slide',
      entityId: `${caseId}:${slideId}`,
      op: 'unlink',
      payload: { caseId, slideId }
    });
  }

  return result.rows.length > 0;
}

// ============================================================================
// Annotations
// ============================================================================

/**
 * Create a new annotation (with idempotency support)
 */
export async function createAnnotation({ slideId, type, geometry, style, authorId, idempotencyKey = null }) {
  // Check idempotency
  if (idempotencyKey) {
    const existing = await query(
      `SELECT * FROM annotations
       WHERE idempotency_key = $1 AND deleted_at IS NULL`,
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      return { annotation: existing.rows[0], created: false };
    }
  }

  const result = await query(
    `INSERT INTO annotations (slide_id, type, geometry, style, author_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [slideId, type, JSON.stringify(geometry), style ? JSON.stringify(style) : null, authorId, idempotencyKey]
  );
  const annotation = result.rows[0];

  // Record outbox event
  await recordOutboxEvent({
    entityType: 'annotation',
    entityId: annotation.annotation_id,
    op: 'create',
    payload: annotation
  });

  return { annotation, created: true };
}

/**
 * Get annotations for a slide (with optional since filter)
 */
export async function getAnnotations(slideId, since = null) {
  let sql = `SELECT * FROM annotations
             WHERE slide_id = $1 AND deleted_at IS NULL`;
  const params = [slideId];

  if (since) {
    sql += ` AND updated_at > $2`;
    params.push(since);
  }

  sql += ` ORDER BY created_at ASC`;

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Get a single annotation by ID
 */
export async function getAnnotation(annotationId) {
  const result = await query(
    'SELECT * FROM annotations WHERE annotation_id = $1',
    [annotationId]
  );
  return result.rows[0] || null;
}

/**
 * Update an annotation with optimistic locking
 */
export async function updateAnnotation(annotationId, expectedVersion, updates) {
  const { type, geometry, style } = updates;

  const setClauses = ['version = version + 1', 'updated_at = NOW()'];
  const params = [];
  let paramIndex = 1;

  if (type !== undefined) {
    setClauses.push(`type = $${paramIndex++}`);
    params.push(type);
  }
  if (geometry !== undefined) {
    setClauses.push(`geometry = $${paramIndex++}`);
    params.push(JSON.stringify(geometry));
  }
  if (style !== undefined) {
    setClauses.push(`style = $${paramIndex++}`);
    params.push(style ? JSON.stringify(style) : null);
  }

  params.push(annotationId, expectedVersion);

  const result = await query(
    `UPDATE annotations
     SET ${setClauses.join(', ')}
     WHERE annotation_id = $${paramIndex++}
       AND version = $${paramIndex++}
       AND deleted_at IS NULL
     RETURNING *`,
    params
  );

  if (result.rows.length === 0) {
    // Check if annotation exists
    const existing = await getAnnotation(annotationId);
    if (!existing) {
      return { annotation: null, error: 'not_found' };
    }
    if (existing.deleted_at) {
      return { annotation: null, error: 'deleted' };
    }
    return { annotation: null, error: 'version_conflict', currentVersion: existing.version };
  }

  const annotation = result.rows[0];

  // Record outbox event
  await recordOutboxEvent({
    entityType: 'annotation',
    entityId: annotation.annotation_id,
    op: 'update',
    payload: annotation
  });

  return { annotation, error: null };
}

/**
 * Soft delete an annotation with optimistic locking
 */
export async function deleteAnnotation(annotationId, expectedVersion) {
  const result = await query(
    `UPDATE annotations
     SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
     WHERE annotation_id = $1
       AND version = $2
       AND deleted_at IS NULL
     RETURNING *`,
    [annotationId, expectedVersion]
  );

  if (result.rows.length === 0) {
    const existing = await getAnnotation(annotationId);
    if (!existing) {
      return { success: false, error: 'not_found' };
    }
    if (existing.deleted_at) {
      return { success: false, error: 'already_deleted' };
    }
    return { success: false, error: 'version_conflict', currentVersion: existing.version };
  }

  const annotation = result.rows[0];

  // Record outbox event
  await recordOutboxEvent({
    entityType: 'annotation',
    entityId: annotation.annotation_id,
    op: 'delete',
    payload: { annotationId, version: annotation.version, deletedAt: annotation.deleted_at }
  });

  return { success: true, annotation };
}

// ============================================================================
// Threads
// ============================================================================

/**
 * Create a new thread
 */
export async function createThread({ slideId, title = null, anchorType = null, anchorId = null }) {
  const result = await query(
    `INSERT INTO threads (slide_id, title, anchor_type, anchor_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [slideId, title, anchorType, anchorId]
  );
  const thread = result.rows[0];

  // Record outbox event
  await recordOutboxEvent({
    entityType: 'thread',
    entityId: thread.thread_id,
    op: 'create',
    payload: thread
  });

  return thread;
}

/**
 * Get threads for a slide
 */
export async function getThreads(slideId) {
  const result = await query(
    `SELECT t.*, COUNT(m.message_id) as message_count
     FROM threads t
     LEFT JOIN messages m ON m.thread_id = t.thread_id
     WHERE t.slide_id = $1
     GROUP BY t.thread_id
     ORDER BY t.created_at DESC`,
    [slideId]
  );
  return result.rows;
}

/**
 * Get a single thread by ID
 */
export async function getThread(threadId) {
  const result = await query(
    'SELECT * FROM threads WHERE thread_id = $1',
    [threadId]
  );
  return result.rows[0] || null;
}

// ============================================================================
// Messages
// ============================================================================

/**
 * Create a new message (with idempotency support)
 */
export async function createMessage({ threadId, authorId, text, idempotencyKey = null }) {
  // Check idempotency
  if (idempotencyKey) {
    const existing = await query(
      'SELECT * FROM messages WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      return { message: existing.rows[0], created: false };
    }
  }

  const result = await query(
    `INSERT INTO messages (thread_id, author_id, text, idempotency_key)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [threadId, authorId, text, idempotencyKey]
  );
  const message = result.rows[0];

  // Update thread timestamp
  await query(
    'UPDATE threads SET updated_at = NOW() WHERE thread_id = $1',
    [threadId]
  );

  // Record outbox event
  await recordOutboxEvent({
    entityType: 'message',
    entityId: message.message_id,
    op: 'create',
    payload: message
  });

  return { message, created: true };
}

/**
 * Get messages for a thread (with optional since filter)
 */
export async function getMessages(threadId, since = null) {
  let sql = 'SELECT * FROM messages WHERE thread_id = $1';
  const params = [threadId];

  if (since) {
    sql += ' AND created_at > $2';
    params.push(since);
  }

  sql += ' ORDER BY created_at ASC';

  const result = await query(sql, params);
  return result.rows;
}
