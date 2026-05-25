-- Adds the technician-review workflow state used to gate the SlideRegistered
-- event. A slide only releases to the sync engine after review_status='confirmed'.

ALTER TABLE slides ADD COLUMN IF NOT EXISTS review_status TEXT;

-- review_status values:
--   NULL        = legacy slide (pre-feature) — treated as confirmed for sync
--   pending     = waiting for technician to confirm name + context
--   confirmed   = technician approved, SlideRegistered already emitted
--   rescan      = technician marked as unreadable; do not sync, leave tombstone

CREATE INDEX IF NOT EXISTS idx_slides_review_status
  ON slides(review_status)
  WHERE review_status = 'pending';
