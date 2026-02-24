-- Drop case-related tables (replaced by cloud auto-matching)
DROP TABLE IF EXISTS case_slides;
DROP TABLE IF EXISTS cases;

-- Clean up orphaned outbox events
DELETE FROM outbox_events WHERE entity_type IN ('case', 'case_slide');
