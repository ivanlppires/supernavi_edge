-- 009_add_tilegen_job_type.sql
-- Add TILEGEN to allowed job types (for full tile pyramid generation via vips dzsave)
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('P0', 'P1', 'CLEANUP', 'TILEGEN'));
