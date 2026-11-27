import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema, ADDED_COLUMNS } from '../src/schema.js';
import { fakeD1, legacyDb } from './helpers.js';

const columns = (db) => db.sqlite.prepare('PRAGMA table_info(feedback)').all().map((c) => c.name);

test('upgrading the existing database is additive, idempotent and backfills project from site', async () => {
  const db = legacyDb();
  const before = columns(db);
  await applySchema(db);
  await applySchema(db); // second run (another isolate, or the next deploy) changes nothing and doesn't fail
  const after = columns(db);
  assert.deepEqual(after.slice(0, before.length), before, 'existing columns untouched');
  for (const [, col] of ADDED_COLUMNS) assert.equal(after.filter((c) => c === col).length, 1, col);
  const rows = db.sqlite.prepare('SELECT site, project, asset, asset_label, message FROM feedback ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.site, r.project, r.asset, r.asset_label]), [['v1', 'v1', null, null], ['v2', 'v2', null, null], ['portal', 'portal', null, null]]);
  const idx = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(idx.includes('feedback_project') && idx.includes('feedback_asset'));
});

test('rows written later by the old website Worker (no project) get backfilled on the next start', async () => {
  const db = legacyDb();
  await applySchema(db);
  db.sqlite.prepare(`INSERT INTO feedback (created_at, updated_at, author_email, site, url, path, type, message)
    VALUES ('2026-11-28T10:00:00Z', '2026-11-28T10:00:00Z', 'cy.staff@overyondr.com', 'v2', 'u', '/', 'bug', 'via old worker')`).run();
  await applySchema(db);
  assert.equal(db.sqlite.prepare("SELECT project FROM feedback WHERE message = 'via old worker'").get().project, 'v2');
});

test('a brand-new database gets the full schema', async () => {
  const db = fakeD1();
  await applySchema(db);
  await applySchema(db);
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['activity', 'admins', 'attachments', 'comments', 'feedback', 'summaries', 'votes']) assert.ok(tables.includes(t), t);
  assert.ok(columns(db).includes('asset_label'));
});
