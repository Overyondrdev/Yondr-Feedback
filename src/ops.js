// Tells Yondr Ops (https://ops.overyondrdev.com, repo Overyondrdev/yondr-ops) about feedback, server to server:
//   POST /api/autofix/feedback  every new item, and every admin change of type or priority. Ops triages it for the
//                               auto-fix engine (only objective bugs can be fixed automatically; the rules are in
//                               the ops README "Auto-fix"). Ops decides; this side only reports.
//   POST /api/events            `feedback_critical` when an item is created as, or changed to, critical (any type).
// Authenticated with the shared secret OPS_INGEST_TOKEN (Worker secret, optional): without it nothing is sent.
// Sent with ctx.waitUntil, so the person giving feedback never waits for ops, and an ops outage never fails a request.
// PRIVACY: no personal data leaves this Worker. No author, assignee, voter or commenter; e-mail addresses and phone
// numbers in the text are redacted; screenshots are referenced by their path here (which needs a Yondr sign-in), never
// sent.
export const OPS_URL = 'https://ops.overyondrdev.com';
export const ADMIN_URL = 'https://feedback.overyondrdev.com/admin';

const clip = (s, n) => String(s ?? '').slice(0, n);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w/=.-])\+?\d[\d ()-]{7,}\d(?![\w/])/g;

/** Remove e-mail addresses and phone numbers from free text. Pure. */
export function redact(s) {
  return String(s ?? '').replace(EMAIL, '[email removed]').replace(PHONE, (m) => {
    // Phone numbers have 9+ digits; dates (2026-11-27) and short numbers stay.
    if (/^\d{4}-\d{2}-\d{2}/.test(m) || m.replace(/\D/g, '').length < 9) return m;
    return '[number removed]';
  });
}

/** What ops gets about one feedback item. Pure. `attachments` = rows of the attachments table. */
export function opsPayload(item, attachments = [], reason = 'created') {
  return {
    feedback_id: item.id,
    reason, // created | updated
    project: item.project || item.site || null,
    asset: item.asset || null,
    type: item.type,
    priority: item.priority,
    status: item.status,
    title: redact(clip(item.title, 200)) || null,
    message: redact(clip(item.message, 4000)),
    url: redact(clip(item.url, 2000)) || null,
    path: redact(clip(item.path, 1000)) || null,
    page_title: redact(clip(item.page_title, 300)) || null,
    screenshots: attachments.map((a) => `/api/attachments/${a.id}`),
    admin_url: `${ADMIN_URL}#item-${item.id}`,
    created_at: item.created_at,
  };
}

/** The feedback_critical event for ops' alerting. Pure. */
export function criticalEvent(item) {
  const what = redact(clip(item.title || item.message, 120)).replace(/\s+/g, ' ').trim();
  return {
    type: 'feedback_critical',
    title: `Critical feedback #${item.id}: ${what}`.slice(0, 200),
    site: item.project || item.site || null,
    source: 'yondr-feedback',
    message: `${item.type} on ${item.project || item.site || 'unknown project'}${item.path ? ` (${redact(item.path)})` : ''}, marked critical.\n\n${redact(clip(item.message, 1500))}`,
    url: `${ADMIN_URL}#item-${item.id}`,
    dedupe_key: `feedback_critical|${item.id}`,
  };
}

/**
 * Which ops calls one change needs. Pure.
 * @param prev the item before the change (null when created)
 * @param next the item after
 * @returns { triage: boolean, critical: boolean }
 */
export function opsCallsFor(prev, next) {
  if (!prev) return { triage: true, critical: next.priority === 'critical' };
  const typeOrPriority = prev.type !== next.type || prev.priority !== next.priority;
  return { triage: typeOrPriority, critical: next.priority === 'critical' && prev.priority !== 'critical' };
}

async function post(env, path, body) {
  const res = await fetch(OPS_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-token': env.OPS_INGEST_TOKEN, 'user-agent': 'yondr-feedback' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ops ${path}: HTTP ${res.status}`);
}

/**
 * Report a created or changed item to ops in the background. Never throws; does nothing without OPS_INGEST_TOKEN.
 * Returns the background promise (tests await it; the Worker hands it to ctx.waitUntil).
 */
export function notifyOps(env, ctx, prev, next, attachments = []) {
  if (!env.OPS_INGEST_TOKEN || !next) return null;
  const calls = opsCallsFor(prev, next);
  const jobs = [];
  if (calls.triage) jobs.push(post(env, '/api/autofix/feedback', opsPayload(next, attachments, prev ? 'updated' : 'created')));
  if (calls.critical) jobs.push(post(env, '/api/events', criticalEvent(next)));
  if (!jobs.length) return null;
  const p = Promise.allSettled(jobs).then((rs) => {
    for (const r of rs) if (r.status === 'rejected') console.error('ops notify failed', next.id, r.reason && r.reason.message);
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}
