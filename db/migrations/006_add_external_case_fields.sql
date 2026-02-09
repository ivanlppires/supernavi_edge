-- Migration: 006_add_external_case_fields
-- PathoWeb integration: add external case/slide metadata parsed from filenames

ALTER TABLE slides ADD COLUMN IF NOT EXISTS external_case_id TEXT;
ALTER TABLE slides ADD COLUMN IF NOT EXISTS external_case_base TEXT;
ALTER TABLE slides ADD COLUMN IF NOT EXISTS external_slide_label TEXT;

CREATE INDEX IF NOT EXISTS idx_slides_external_case_id ON slides(external_case_id);
CREATE INDEX IF NOT EXISTS idx_slides_external_case_base ON slides(external_case_base);
