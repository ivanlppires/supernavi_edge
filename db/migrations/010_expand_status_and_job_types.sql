-- 010_expand_status_and_job_types.sql
-- Add 'ingesting' and 'tilegen' to slide status values for TILEGEN-first flow
-- Add 'PREVIEW' to job types (preview publishing as separate job)

ALTER TABLE slides DROP CONSTRAINT slides_status_check;
ALTER TABLE slides ADD CONSTRAINT slides_status_check
  CHECK (status IN ('queued', 'processing', 'ingesting', 'tilegen', 'ready', 'failed'));

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN ('P0', 'P1', 'CLEANUP', 'TILEGEN', 'PREVIEW'));

-- Migrate existing slides in transient states
UPDATE slides SET status = 'ingesting' WHERE status IN ('queued', 'processing');
