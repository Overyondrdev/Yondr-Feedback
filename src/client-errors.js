// Browser-error reporting. The widget (public/widget.js) catches `error` and `unhandledrejection` on the page that
// embeds it (unless data-errors="off"), de-duplicates them, and sends at most 20 per page view in batches:
//   POST /api/client-errors   { project, page_path, errors: [{ message, source, count, page_path? }] }
// Any signed-in person may send (same CORS + CSRF rules as every other write); 60 requests per person per hour.
// Admins read them with GET /api/client-errors (the admin "Errors" tab).
// PRIVACY: no user is stored with an error. Query strings, fragments and email addresses are removed here as well as
// in the widget, and the widget never reads anything a person typed. The rate limit keys on a hash of the email.
// Yondr Ops: when a project's errors in the last 15 minutes cross a multiple of 10, a `client_errors` event is sent
// (src/ops.js; only with OPS_INGEST_TOKEN).
import { cleanProject } from './api.js';
import { clientErrorsEvent, forwardClientErrors, redact } from './ops.js';

export const MAX_ERRORS_PER_REQUEST = 20;
export const MAX_COUNT_PER_ERROR = 1000;
export const RATE_LIMIT_PER_HOUR = 60;
export const WINDOW_MINUTES = 15;
export const FORWARD_STEP = 10;

// Linear-time patterns only (no overlapping repeats), and every input is capped to MAX_SCAN characters first, so a
// crafted error message can't make the Worker spend long matching (ReDoS). The domain part has no '.' inside its
// repeated label, so it can't backtrack. Each pattern runs only if the text can contain a match.
const MAX_SCAN = 2000;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
// A URL's query string and fragment: everything from ? or # up to whitespace or a quote.
const URL_QUERY = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s?#'"<>]{0,2000})[?#][^\s'"<>]{0,2000}/gi;

/** Error text as it may be stored: no control characters, URL query strings, email addresses or secrets. Pure. */
export function cleanErrorText(v, max = 500) {
  let s = String(v ?? '').slice(0, MAX_SCAN).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (s.includes('://')) s = s.replace(URL_QUERY, '$1');
  if (s.includes('@')) s = s.replace(EMAIL, '[email]');
  s = s.replace(/\s+/g, ' ').trim();
  return redact(s).slice(0, max);
}

/** A page path: starts with /, no query string or fragment, no email addresses. Pure. */
export function cleanPagePath(v) {
  let p = String(v ?? '').split(/[?#]/)[0].trim();
  if (!p.startsWith('/')) p = '/' + p;
  return cleanErrorText(p, 500) || '/';
}

/** Validate a POST body. Returns { project, items } (items may be empty) or null if unusable. Pure. */
export function cleanReport(body, fallbackProject) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.errors)) return null;
  const project = cleanProject(body.project) || fallbackProject || 'general';
  const pagePath = cleanPagePath(body.page_path);
  const items = [];
  for (const e of body.errors.slice(0, MAX_ERRORS_PER_REQUEST)) {
    if (!e || typeof e !== 'object') continue;
    const message = cleanErrorText(e.message, 500);
    if (!message) continue;
    const count = Math.min(MAX_COUNT_PER_ERROR, Math.max(1, Number.parseInt(e.count, 10) || 1));
    items.push({
      page_path: e.page_path != null ? cleanPagePath(e.page_path) : pagePath,
      message,
      source: cleanErrorText(e.source, 500),
      count,
    });
  }
  return { project, items };
}

/** Did the count go past a multiple of `step` (10, 20, 30, ...)? Pure. */
export function crossesStep(before, after, step = FORWARD_STEP) {
  return Math.floor(after / step) > Math.floor(before / step);
}

async function userKey(email) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(email).toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

/** POST /api/client-errors */
export async function recordClientErrors(req, env, user, ctx, now = new Date()) {
  const body = await req.json().catch(() => null);
  const report = cleanReport(body);
  if (!report) return json({ error: 'Expected { project, page_path, errors: [...] }.' }, 400);
  const db = env.DB;
  const iso = now.toISOString();
  const hour = iso.slice(0, 13);

  // Rate limit: fixed one-hour window per person.
  const key = await userKey(user.email);
  const lim = await db.prepare(`INSERT INTO client_error_limits (user_key, hour, n) VALUES (?, ?, 1)
      ON CONFLICT(user_key, hour) DO UPDATE SET n = n + 1 RETURNING n`).bind(key, hour).first();
  if (lim && lim.n > RATE_LIMIT_PER_HOUR) {
    const retry = 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
    return json({ error: 'Too many error reports. Try again later.' }, 429, { 'retry-after': String(retry) });
  }
  if (!report.items.length) return json({ accepted: 0 }, 202);

  const { project, items } = report;
  const total = items.reduce((a, e) => a + e.count, 0);
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const [before] = await db.batch([
    db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM client_error_hits WHERE project = ? AND at >= ?').bind(project, since),
    db.prepare('INSERT INTO client_error_hits (project, at, n) VALUES (?, ?, ?)').bind(project, iso, total),
    ...items.map((e) => db.prepare(`INSERT INTO client_errors (project, page_path, message, source, count, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, page_path, message, source) DO UPDATE SET count = count + excluded.count, last_seen = excluded.last_seen`)
      .bind(project, e.page_path, e.message, e.source, e.count, iso, iso)),
    // Counters are only needed for an hour (rate limit) and 15 minutes (ops window); errors themselves are kept.
    db.prepare('DELETE FROM client_error_hits WHERE at < ?').bind(dayAgo),
    db.prepare('DELETE FROM client_error_limits WHERE hour < ?').bind(dayAgo.slice(0, 13)),
  ]);
  const prev = Number(before.results[0].n) || 0;
  const after = prev + total;
  let forwarded = false;
  if (env.OPS_INGEST_TOKEN && crossesStep(prev, after)) {
    const { results: samples } = await db.prepare(`SELECT message, source, page_path FROM client_errors
        WHERE project = ? AND last_seen >= ? ORDER BY last_seen DESC, count DESC LIMIT 5`).bind(project, since).all();
    forwardClientErrors(env, ctx, clientErrorsEvent(project, after, samples, WINDOW_MINUTES));
    forwarded = true;
  }
  return json({ accepted: items.length, forwarded }, 202);
}

/** GET /api/client-errors?project=&days= (admins): recent errors, newest first, and totals per project. */
export async function listClientErrors(url, env, now = new Date()) {
  const q = url.searchParams;
  const days = Math.min(90, Math.max(1, Number.parseInt(q.get('days') || '7', 10) || 7));
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const project = cleanProject(q.get('project'));
  const where = ['last_seen >= ?'];
  const args = [since];
  if (project) { where.push('project = ?'); args.push(project); }
  const [items, byProject] = await env.DB.batch([
    env.DB.prepare(`SELECT id, project, page_path, message, source, count, first_seen, last_seen FROM client_errors
        WHERE ${where.join(' AND ')} ORDER BY last_seen DESC LIMIT 300`).bind(...args),
    env.DB.prepare(`SELECT project, SUM(count) AS n, COUNT(*) AS distinct_errors, MAX(last_seen) AS last_seen FROM client_errors
        WHERE last_seen >= ? GROUP BY project ORDER BY n DESC`).bind(since),
  ]);
  return json({ days, project: project || null, items: items.results, byProject: byProject.results });
}
