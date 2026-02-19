-- Add OCR status tracking columns to slides table
ALTER TABLE slides ADD COLUMN IF NOT EXISTS ocr_status TEXT DEFAULT NULL;
ALTER TABLE slides ADD COLUMN IF NOT EXISTS dsmeta_path TEXT DEFAULT NULL;

-- ocr_status values:
--   NULL    = no .dsmeta, OCR not applicable
--   pending = OCR failed, awaiting retry
--   done    = OCR succeeded, file renamed
