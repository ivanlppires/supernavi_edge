-- SuperNavi Local Agent - Add magnification metadata
-- Migration: 005_add_magnification

-- Add magnification metadata columns
ALTER TABLE slides ADD COLUMN IF NOT EXISTS app_mag REAL;
ALTER TABLE slides ADD COLUMN IF NOT EXISTS mpp REAL;

COMMENT ON COLUMN slides.app_mag IS 'Native scan magnification (e.g., 20, 40)';
COMMENT ON COLUMN slides.mpp IS 'Microns per pixel';
