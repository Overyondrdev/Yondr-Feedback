-- Universal feedback tool (2026-11): which project (site or tool) and which asset feedback is about.
-- src/schema.js applies this automatically and idempotently (it skips columns that already exist).
-- Run by hand only on a database that has never been opened by the Worker: ALTER TABLE fails if a column exists.
ALTER TABLE feedback ADD COLUMN project TEXT;
ALTER TABLE feedback ADD COLUMN asset TEXT;
ALTER TABLE feedback ADD COLUMN asset_label TEXT;
CREATE INDEX IF NOT EXISTS feedback_project ON feedback(project, created_at);
CREATE INDEX IF NOT EXISTS feedback_asset ON feedback(project, asset);
UPDATE feedback SET project = site WHERE project IS NULL;
