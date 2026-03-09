-- Add BIGTIFF to allowed job types (for BigTIFF pipeline processing)
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('P0', 'P1', 'CLEANUP', 'TILEGEN', 'BIGTIFF'));
