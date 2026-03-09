-- BigTIFF pipeline support
-- Tracks which pipeline mode was used for each slide and BigTIFF-specific metadata

ALTER TABLE slides ADD COLUMN IF NOT EXISTS pipeline_mode TEXT DEFAULT 'legacy_dzi';
ALTER TABLE slides ADD COLUMN IF NOT EXISTS s3_bigtiff_key TEXT;
ALTER TABLE slides ADD COLUMN IF NOT EXISTS bigtiff_size BIGINT;
