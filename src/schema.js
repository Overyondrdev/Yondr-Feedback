// D1 schema for the feedback tool. Applied idempotently on the first request of each isolate, so a fresh database
// needs no manual migration and the existing `yondr-feedback` database (created by the website Worker) is upgraded in
// place. Every change must be ADDITIVE and IDEMPOTENT: the website Worker may still read and write the same database.
// Keep migrations/*.sql in sync (they document the same statements for `wrangler d1 execute`).
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    author_email TEXT NOT NULL,
    site TEXT NOT NULL,                -- legacy: v1 | v2 | portal (now = project; see ADDED_COLUMNS)
    url TEXT NOT NULL,
    path TEXT NOT NULL,
    page_title TEXT,
    type TEXT NOT NULL,                -- bug | design | content | idea | question | praise | other
    priority TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high | critical
    status TEXT NOT NULL DEFAULT 'new',       -- new | reviewing | agreed | planned | done | wont_do
    title TEXT,
    message TEXT NOT NULL,
    assignee TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    context TEXT NOT NULL DEFAULT '{}',
    score INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    attachment_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS feedback_author ON feedback(author_email, created_at)`,
  `CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    feedback_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'screenshot',
    content_type TEXT NOT NULL,
    width INTEGER, height INTEGER, bytes INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS attachments_feedback ON attachments(feedback_id)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id INTEGER NOT NULL,
    author_email TEXT NOT NULL,
    body TEXT NOT NULL,
    internal INTEGER NOT NULL DEFAULT 0,  -- 1 = admin-only note
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS comments_feedback ON comments(feedback_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS votes (
    feedback_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    value INTEGER NOT NULL,              -- 1 agree / -1 disagree
    created_at TEXT NOT NULL,
    PRIMARY KEY (feedback_id, email)
  )`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id INTEGER,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS activity_feedback ON activity(feedback_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS admins (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'admin',  -- owner | admin
    added_by TEXT,
    added_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    content TEXT NOT NULL
  )`,
  // Browser errors from pages that embed the widget (src/client-errors.js). One row per project + page + message +
  // source; `count` adds up repeats. No user, no query strings, no email addresses.
  `CREATE TABLE IF NOT EXISTS client_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    page_path TEXT NOT NULL,
    message TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',     -- script URL without query string, plus :line:column
    count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS client_errors_key ON client_errors(project, page_path, message, source)`,
  `CREATE INDEX IF NOT EXISTS client_errors_recent ON client_errors(last_seen)`,
  // Short-lived counters (pruned after a day): reports per project for the 15-minute Ops window, and requests per
  // person per hour for the rate limit (user_key = SHA-256 of the email, not the email).
  `CREATE TABLE IF NOT EXISTS client_error_hits (
    project TEXT NOT NULL,
    at TEXT NOT NULL,
    n INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS client_error_hits_project ON client_error_hits(project, at)`,
  `CREATE TABLE IF NOT EXISTS client_error_limits (
    user_key TEXT NOT NULL,
    hour TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (user_key, hour)
  )`,
];

// Columns added after the first release (2026-11, universal feedback tool). SQLite has no ADD COLUMN IF NOT EXISTS,
// so ensureSchema() adds whichever are missing. All nullable: rows written before (or by the old website Worker)
// stay valid.
//   project      which site or tool the feedback is about (v1, v2, portal, ads, requests, cards, ...)
//   asset        optional id of one item inside that project (an ad, a request, a card design)
//   asset_label  human-readable name of that item, as the embedding tool described it
export const ADDED_COLUMNS = [
  ['feedback', 'project', 'TEXT'],
  ['feedback', 'asset', 'TEXT'],
  ['feedback', 'asset_label', 'TEXT'],
];

// Run after the columns exist.
export const AFTER = [
  `CREATE INDEX IF NOT EXISTS feedback_project ON feedback(project, created_at)`,
  `CREATE INDEX IF NOT EXISTS feedback_asset ON feedback(project, asset)`,
  // Backfill: before `project` existed, `site` (v1 | v2 | portal) said which website the feedback was about.
  // Also catches rows the old website Worker writes during the switch-over.
  `UPDATE feedback SET project = site WHERE project IS NULL`,
];

async function addMissingColumns(db) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (results.some((c) => c.name === col)) continue;
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
    } catch (e) {
      // Another isolate added it at the same moment.
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }
  }
}

export async function applySchema(db) {
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  await addMissingColumns(db);
  await db.batch(AFTER.map((s) => db.prepare(s)));
}

let ready = null;
export function ensureSchema(db) {
  if (!ready) ready = applySchema(db).catch((e) => { ready = null; throw e; });
  return ready;
}
/** For tests: forget that the schema was applied in this isolate. */
export function resetSchemaCache() { ready = null; }
