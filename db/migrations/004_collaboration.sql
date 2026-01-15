-- SuperNavi Local Agent - Collaboration Schema
-- Migration: 004_collaboration
-- Local-first collaboration: Cases, Annotations, Threads, Messages

-- Cases: group slides into diagnostic cases
CREATE TABLE IF NOT EXISTS cases (
    case_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    title TEXT NOT NULL,
    external_ref TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Case-Slide junction table
CREATE TABLE IF NOT EXISTS case_slides (
    case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
    slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    linked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (case_id, slide_id)
);

-- Annotations: geometric annotations on slides
CREATE TABLE IF NOT EXISTS annotations (
    annotation_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    geometry JSONB NOT NULL,
    style JSONB,
    author_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Threads: discussion threads anchored to slides or annotations
CREATE TABLE IF NOT EXISTS threads (
    thread_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    anchor_type TEXT,
    anchor_id TEXT,
    title TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Messages: messages within threads
CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    text TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Outbox: events pending sync to cloud
CREATE TABLE IF NOT EXISTS outbox_events (
    event_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    synced_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_case_slides_slide_id ON case_slides(slide_id);
CREATE INDEX IF NOT EXISTS idx_annotations_slide_id ON annotations(slide_id);
CREATE INDEX IF NOT EXISTS idx_annotations_deleted_at ON annotations(deleted_at);
CREATE INDEX IF NOT EXISTS idx_annotations_idempotency ON annotations(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_threads_slide_id ON threads(slide_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_synced_at ON outbox_events(synced_at);
CREATE INDEX IF NOT EXISTS idx_outbox_entity ON outbox_events(entity_type, entity_id);
