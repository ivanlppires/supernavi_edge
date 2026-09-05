-- Viewer-only edge: the technician review queue, the OCR status and the
-- clinical-context form are gone. Names come from people and every
-- SlideRegistered is confirmed; nothing is gated any more.
-- dsmeta_path stays: it locates the Motic label photo.

DROP TABLE IF EXISTS case_contexts;
DROP INDEX IF EXISTS idx_slides_review_status;
ALTER TABLE slides DROP COLUMN IF EXISTS review_status;
ALTER TABLE slides DROP COLUMN IF EXISTS ocr_status;
