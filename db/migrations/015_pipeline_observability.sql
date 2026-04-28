-- Pipeline observability: structured event log + sync rejection tracking
-- Migration: 015_pipeline_observability

-- Per-slide chronological event log for every pipeline stage.
-- Used to surface "what happened, why" in the dashboard's Failures tab.
CREATE TABLE IF NOT EXISTS slide_pipeline_events (
    id BIGSERIAL PRIMARY KEY,
    slide_id TEXT REFERENCES slides(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    -- stage values: ingest | p0 | p1 | tilegen | bigtiff | cloud_upload | outbox | sync | preview
    level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    message TEXT,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_slide_id ON slide_pipeline_events(slide_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_level ON slide_pipeline_events(level, created_at DESC) WHERE level = 'error';
CREATE INDEX IF NOT EXISTS idx_pipeline_events_stage ON slide_pipeline_events(stage, created_at DESC);

-- Persistent record of cloud sync rejections (currently silent in worker logs).
CREATE TABLE IF NOT EXISTS sync_failures (
    event_id TEXT PRIMARY KEY REFERENCES outbox_events(event_id) ON DELETE CASCADE,
    entity_type TEXT,
    entity_id TEXT,
    reason TEXT,
    http_status INTEGER,
    is_permanent BOOLEAN DEFAULT FALSE,
    attempts INTEGER DEFAULT 1,
    first_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_failures_entity ON sync_failures(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_failures_last_attempt ON sync_failures(last_attempt_at DESC);

-- Denormalized "latest error" fields on slides so the slides list can render
-- a warning indicator without joining the event log on every page load.
ALTER TABLE slides ADD COLUMN IF NOT EXISTS latest_error TEXT;
ALTER TABLE slides ADD COLUMN IF NOT EXISTS latest_error_stage TEXT;
ALTER TABLE slides ADD COLUMN IF NOT EXISTS latest_error_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_slides_latest_error ON slides(latest_error_at DESC) WHERE latest_error IS NOT NULL;
