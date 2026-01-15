-- SuperNavi Local Agent - Initial Schema
-- Migration: 001_initial

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS slides (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    raw_path TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
    width INTEGER,
    height INTEGER,
    tile_size INTEGER DEFAULT 256,
    max_level INTEGER,
    thumb_path TEXT,
    manifest_path TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('P0', 'P1')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slides_status ON slides(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_slide_id ON jobs(slide_id);

-- Migrations tracking
CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
