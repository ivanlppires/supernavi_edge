-- Migration: 002_add_format
-- Add format field to slides table

ALTER TABLE slides ADD COLUMN IF NOT EXISTS format TEXT DEFAULT 'unknown';

-- Update existing records based on filename
UPDATE slides SET format = 'jpg' WHERE format = 'unknown' AND (original_filename LIKE '%.jpg' OR original_filename LIKE '%.jpeg');
UPDATE slides SET format = 'png' WHERE format = 'unknown' AND original_filename LIKE '%.png';
UPDATE slides SET format = 'svs' WHERE format = 'unknown' AND original_filename LIKE '%.svs';
UPDATE slides SET format = 'tiff' WHERE format = 'unknown' AND (original_filename LIKE '%.tif' OR original_filename LIKE '%.tiff');
UPDATE slides SET format = 'ndpi' WHERE format = 'unknown' AND original_filename LIKE '%.ndpi';
