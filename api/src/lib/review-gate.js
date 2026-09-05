import { query } from '../db/index.js';

/**
 * Pure decision: may a SlideRegistered event be written to the outbox?
 *  - NULL/undefined review_status → legacy slide, allowed
 *  - 'confirmed'                  → allowed
 *  - anything else (pending/rescan):
 *      - if a SlideRegistered was ALREADY synced for this slide, allow it —
 *        the cloud holds a (possibly wrong) name and a correction must reach
 *        it (incident 2026-09-04: rename after sync was silently dropped)
 *      - otherwise blocked until the technician confirms
 *
 * @param {{ reviewStatus: string|null|undefined, alreadyEmitted: boolean }} input
 * @returns {{ emit: boolean, reason: string }}
 */
export function decideEmitRegistered({ reviewStatus, alreadyEmitted }) {
  if (reviewStatus === null || reviewStatus === undefined || reviewStatus === 'confirmed') {
    return { emit: true, reason: 'allowed' };
  }
  if (alreadyEmitted) {
    return { emit: true, reason: 'correction_of_synced_name' };
  }
  return { emit: false, reason: `review_status=${reviewStatus}` };
}

/**
 * Returns true if the slide is allowed to emit SlideRegistered.
 *  - NULL review_status  → legacy slide, allowed (preserves pre-feature behavior)
 *  - 'confirmed'         → allowed
 *  - anything else       → blocked
 */
export async function canEmitRegistered(slideId) {
  const r = await query('SELECT review_status FROM slides WHERE id = $1', [slideId]);
  const status = r.rows[0]?.review_status;
  return status === null || status === undefined || status === 'confirmed';
}

/**
 * True if a SlideRegistered event was ever written to the outbox for this slide
 * (synced or not) — i.e. the cloud may already hold a name for it.
 */
export async function hasEmittedRegistered(slideId) {
  const r = await query(
    `SELECT 1 FROM outbox_events
      WHERE entity_type = 'slide' AND entity_id = $1 AND op = 'registered'
      LIMIT 1`,
    [slideId]
  );
  return r.rows.length > 0;
}

/**
 * Full decision for rename/re-OCR flows: gate + "already synced" override.
 * @returns {Promise<{ emit: boolean, reason: string, reviewStatus: string|null }>}
 */
export async function shouldEmitRegistered(slideId) {
  const r = await query('SELECT review_status FROM slides WHERE id = $1', [slideId]);
  const reviewStatus = r.rows[0]?.review_status ?? null;
  const alreadyEmitted = await hasEmittedRegistered(slideId);
  return { ...decideEmitRegistered({ reviewStatus, alreadyEmitted }), reviewStatus };
}
