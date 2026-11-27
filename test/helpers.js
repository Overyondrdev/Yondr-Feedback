// Test doubles: a D1-compatible database over node:sqlite (in memory) and a Map-backed KV namespace.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function fakeD1(sqlite = new DatabaseSync(':memory:')) {
  const plain = (r) => (r == null ? null : { ...r });
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Stmt(this.sql, args); }
    async first() { return plain(sqlite.prepare(this.sql).get(...this.args)); }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.args).map(plain), success: true }; }
    async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: r.changes } }; }
  }
  return {
    sqlite,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.all());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}

export function fakeKV() {
  const m = new Map();
  return {
    map: m,
    async put(k, v) { m.set(k, v instanceof Uint8Array ? v : new Uint8Array(v)); },
    async get(k) { const v = m.get(k); return v ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : null; },
    async delete(k) { m.delete(k); },
  };
}

/** A database as the website Worker left it: the original schema (migrations/0001) and some rows. */
export function legacyDb() {
  const db = fakeD1();
  db.sqlite.exec(readFileSync(new URL('../migrations/0001_feedback.sql', import.meta.url), 'utf8'));
  const ins = db.sqlite.prepare(`INSERT INTO feedback (created_at, updated_at, author_email, site, url, path, type, message)
    VALUES ('2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z', 'cy.staff@overyondr.com', ?, ?, '/', 'idea', ?)`);
  ins.run('v1', 'https://v1.overyondrdev.com/', 'Old V1 feedback');
  ins.run('v2', 'https://v2.overyondrdev.com/', 'Old V2 feedback');
  ins.run('portal', 'https://overyondrdev.com/', 'Old general feedback');
  return db;
}
