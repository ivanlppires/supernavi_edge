-- 008_add_tilegen_status.sql
-- Track tile pre-generation status for WSI slides
ALTER TABLE slides ADD COLUMN tilegen_status TEXT DEFAULT NULL;
-- NULL = not applicable (non-WSI format) or legacy slide
-- 'queued' = TILEGEN job enqueued after P0
-- 'running' = vips dzsave in progress
-- 'done' = all tiles pre-generated
-- 'failed' = dzsave failed, on-demand fallback active

CREATE INDEX idx_slides_tilegen_status ON slides (tilegen_status) WHERE tilegen_status IS NOT NULL;
