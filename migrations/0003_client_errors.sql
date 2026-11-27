-- Browser-error reporting (src/client-errors.js). Applied automatically by src/schema.js; documented here for
-- `wrangler d1 execute`. Additive and idempotent.
CREATE TABLE IF NOT EXISTS client_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  page_path TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS client_errors_key ON client_errors(project, page_path, message, source);
CREATE INDEX IF NOT EXISTS client_errors_recent ON client_errors(last_seen);
CREATE TABLE IF NOT EXISTS client_error_hits (
  project TEXT NOT NULL,
  at TEXT NOT NULL,
  n INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS client_error_hits_project ON client_error_hits(project, at);
CREATE TABLE IF NOT EXISTS client_error_limits (
  user_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (user_key, hour)
);
