/**
 * Returns true if the slide is allowed to emit SlideRegistered.
 *  - NULL review_status  → legacy slide, allowed (preserves pre-feature behavior)
 *  - 'confirmed'         → allowed
 *  - anything else       → blocked
 *
 * @param {object} pool  pg Pool instance (processor uses getPool())
 * @param {string} slideId
 */
export async function canEmitRegistered(pool, slideId) {
  const r = await pool.query('SELECT review_status FROM slides WHERE id = $1', [slideId]);
  const status = r.rows[0]?.review_status;
  return status === null || status === undefined || status === 'confirmed';
}
