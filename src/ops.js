// Tells Yondr Ops (https://ops.overyondrdev.com, repo Overyondrdev/yondr-ops) about feedback, server to server:
//   POST /api/autofix/feedback  every new item, and every admin change of type or priority. Ops triages it for the
//                               auto-fix engine (only objective bugs can be fixed automatically; the rules are in
//                               the ops README "Auto-fix"). Ops decides; this side only reports.
//   POST /api/events            `feedback_critical` when an item is created as, or changed to, critical (any type).
// Authenticated with the shared secret OPS_INGEST_TOKEN (Worker secret, optional): without it nothing is sent.
// Sent with ctx.waitUntil, so the person giving feedback never waits for ops, and an ops outage never fails a request.
// PRIVACY: no personal data leaves this Worker (bug reports may become PUBLIC GitHub issues). No author, assignee, voter
// or commenter; e-mail addresses, phone numbers, street addresses and postcodes, and secrets in URLs or text are
// redacted (redact() below); screenshots are referenced by their path here (which needs a Yondr sign-in), never sent.
export const OPS_URL = 'https://ops.overyondrdev.com';
export const ADMIN_URL = 'https://feedback.overyondrdev.com/admin';

const clip = (s, n) => String(s ?? '').slice(0, n);
// ---- personal-data redaction (keep identical in yondr-feedback src/ops.js and yondr-ops src/triage.js) ----
// Bug reports may end up in PUBLIC GitHub issues (auto-fix). Removed: e-mail addresses; phone numbers (international
// and local formats, 9+ digits, or 7+ after + / 00); street addresses (house number + street word, e.g. "12 High
// Street", "1600 Pennsylvania Ave NW", "5 rue de la Paix") with a town and postcode/ZIP that follow; UK postcodes
// anywhere; secrets: URL parameters whose name contains key/token/secret/password/auth/session/signature/code, Bearer
// and Basic credentials, and well-known token formats.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_PARAM = /([?&;#][\w.-]*?(?:key|token|secret|passw(?:or)?d|pwd|auth|session|signature|sig|code|credential)[\w.-]*=)[^&#\s"'<>]+/gi;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9_]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g;
const STREET = '(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Close|Court|Ct|Place|Pl|Square|Sq|Terrace|Crescent|Cres|Gardens|Grove|Hill|Row|Mews|Walk|Parkway|Pkwy|Highway|Hwy|Strasse|Straße|Weg|Gasse|Plaza)';
const POSTCODE = '(?:[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}|\\d{5}(?:-\\d{4})?|\\d{4}\\s?[A-Z]{2}|[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d|\\d{4})';
const TAIL = `(?:,?\\s+(?:N|S|E|W|NE|NW|SE|SW)\\b)?(?:,?\\s+[A-Z][A-Za-z.'-]+\\b){0,3}(?:,?\\s+${POSTCODE}\\b)?`;
const ADDRESS = new RegExp(
  `\\b\\d{1,5}[A-Za-z]?(?:[-–]\\d{1,5})?,?\\s+(?:(?:[A-Z][A-Za-z'.-]*|of|the)\\s+){1,4}(?:${STREET}|${STREET.toLowerCase()})\\b\\.?${TAIL}` +
  `|\\b\\d{1,5}[A-Za-z]?,?\\s+(?:[Rr]ue|[Aa]venue|[Vv]ia|[Cc]alle|[Bb]oulevard|[Pp]lace)\\s+(?:(?:de|du|des|la|le|del|di|della|von)\\s+)*[A-Z][A-Za-z'-]+(?:\\s+[A-Z][A-Za-z'-]+)?${TAIL}`, 'g');
const UK_POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]?|GIR)\s*\d[ABD-HJLNP-UW-Z]{2}\b/g;
const PHONE = /(?<![\w/=.#-])(?:\+|00)?\(?\d[\d (). -]{5,}\d(?![\w/])/g;

/** Remove personal details and secrets from free text before it can leave for a public place. Pure. */
export function redact(s) {
  return String(s ?? '')
    .replace(SECRET_PARAM, '$1[removed]')
    .replace(AUTH_HEADER, '$1 [removed]')
    .replace(TOKEN, '[token removed]')
    .replace(EMAIL, '[email removed]')
    .replace(ADDRESS, '[address removed]')
    .replace(UK_POSTCODE, '[postcode removed]')
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '').length;
      // Dates (2026-11-27, 27.11.2026), times and short numbers stay; phone numbers have 9+ digits (7+ after + / 00).
      if (/^\d{4}-\d{2}-\d{2}/.test(m) || /^\d{1,2}[.-]\d{1,2}[.-]\d{2,4}$/.test(m.trim())) return m;
      if (digits > 15 || digits < (/^(\+|00)/.test(m) ? 7 : 9)) return m;
      return '[number removed]';
    });
}
// ---- end of personal-data redaction ----

/** What ops gets about one feedback item. Pure. `attachments` = rows of the attachments table. */
export function opsPayload(item, attachments = [], reason = 'created') {
  return {
    feedback_id: item.id,
    reason, // created | updated
    project: item.project || item.site || null,
    asset: redact(clip(item.asset, 200)) || null,
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
