-- Migration: 007_scanner_adapter
-- Scanner adapter: track discovered scanner files + barcode metadata

CREATE TABLE IF NOT EXISTS scanner_files (
    id SERIAL PRIMARY KEY,
    file_path TEXT UNIQUE NOT NULL,
    slide_id TEXT REFERENCES slides(id),
    scanner_barcode TEXT,
    scanner_guid TEXT,
    scan_datetime TEXT,
    discovered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scanner_files_slide_id ON scanner_files(slide_id);
CREATE INDEX IF NOT EXISTS idx_scanner_files_barcode ON scanner_files(scanner_barcode);

ALTER TABLE slides ADD COLUMN IF NOT EXISTS scanner_barcode TEXT;
