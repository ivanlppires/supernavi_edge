-- SuperNavi Local Agent - Add level_ready_max
-- Migration: 003_add_level_ready_max

ALTER TABLE slides ADD COLUMN IF NOT EXISTS level_ready_max INTEGER DEFAULT 0;

-- Index for querying by readiness
CREATE INDEX IF NOT EXISTS idx_slides_level_ready_max ON slides(level_ready_max);
