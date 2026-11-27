// Browser-error reporting: the widget's collector (pure, between yfb-errors markers in public/widget.js) and the
// API (src/client-errors.js): redaction, de-duplication, the per-page cap, the rate limit and forwarding to Ops.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { cleanErrorText, cleanPagePath, cleanReport, crossesStep, recordClientErrors, RATE_LIMIT_PER_HOUR } from '../src/client-errors.js';
import { clientErrorsEvent } from '../src/ops.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { fakeD1, fakeKV } from './helpers.js';

const OWNER = 'ada.owner@overyondr.com';
const STAFF = 'cy.staff@overyondr.com';
const BASE = 'https://feedback.overyondrdev.com';
const ORIGIN = 'https://v1.overyondrdev.com';
const TOKEN = 'test-ingest-token-0123456789abcdef0123456789';

// ---- widget side -------------------------------------------------------------------------------------------------
const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* yfb-errors:start'), src.indexOf('/* yfb-errors:end */'));
const W = new Function(block + '; return { cleanErrText, cleanErrSource, errorCollector, rejectionText, stackSource };')();
const cfgBody = src.slice(src.indexOf('/* yfb-config:start'), src.indexOf('/* yfb-config:end */'));
const readConfig = new Function(cfgBody + '; return readConfig;')();

test('widget: error capture is on by default and off with data-errors="off"', () => {
  const cfg = (attrs) => readConfig((n) => (n in attrs ? attrs[n] : null), 'v1.overyondrdev.com', `${BASE}/widget.js`);
  assert.equal(cfg({}).errors, true);
  assert.equal(cfg({ 'data-errors': 'off' }).errors, false);
  assert.equal(cfg({ 'data-errors': ' OFF ' }).errors, false);
  assert.equal(cfg({ 'data-errors': 'on' }).errors, true);
});

test('widget: query strings, fragments and email addresses are stripped', () => {
  assert.equal(W.cleanErrText('Failed at https://v1.overyondrdev.com/x?email=a@b.co&t=1#frag now'), 'Failed at https://v1.overyondrdev.com/x now');
  assert.equal(W.cleanErrText('User ada.owner@overyondr.com not found'), 'User [email] not found');
  assert.equal(W.cleanErrText('a\n\tb'), 'a b');
  assert.equal(W.cleanErrText('x'.repeat(400)).length, 300);
  assert.equal(W.cleanErrSource('https://v1.overyondrdev.com/js/site.js?v=3#x', 12, 5), 'https://v1.overyondrdev.com/js/site.js:12:5');
  assert.equal(W.cleanErrSource('', 0, 0), '');
  assert.equal(W.stackSource('TypeError: x\n    at f (https://v2.overyondrdev.com/a.js?q=1:3:9)').url, 'https://v2.overyondrdev.com/a.js?q=1');
  assert.equal(W.cleanErrSource(W.stackSource('at f (https://v2.overyondrdev.com/a.js?q=1:3:9)').url, 3, 9), 'https://v2.overyondrdev.com/a.js:3:9');
  assert.equal(W.rejectionText(new TypeError('boom')), 'Unhandled rejection: TypeError: boom');
  assert.equal(W.rejectionText({ secret: 'typed text' }), 'Unhandled rejection (object)'); // arbitrary values are never sent
});

test('widget: de-duplicates by message + source, caps at 20 different errors per page view', () => {
  const c = W.errorCollector(20);
  assert.equal(c.add('TypeError: x is undefined', 'https://v1.overyondrdev.com/js/site.js', 10, 2, '/about?x=1'), true);
  assert.equal(c.add('TypeError: x is undefined', 'https://v1.overyondrdev.com/js/site.js', 10, 2, '/about'), true);
  assert.equal(c.add('TypeError: x is undefined', 'https://v1.overyondrdev.com/js/other.js', 10, 2, '/about'), true);
  assert.equal(c.add('Ext', 'chrome-extension://abc/content.js', 1, 1, '/'), false);
  const first = c.drain();
  assert.equal(first.length, 2);
  assert.deepEqual(first[0], { message: 'TypeError: x is undefined', source: 'https://v1.overyondrdev.com/js/site.js:10:2', page_path: '/about', count: 2 });
  assert.equal(c.size(), 0);
  for (let i = 0; i < 30; i++) c.add('Error ' + i, '', 0, 0, '/');
  assert.equal(c.drain().length, 18, 'only 20 different errors per page view (2 already seen)');
  // A repeat of an error already sent is reported again (as a count), and doesn't use up the cap.
  assert.equal(c.add('TypeError: x is undefined', 'https://v1.overyondrdev.com/js/site.js', 10, 2, '/about'), true);
  assert.equal(c.add('Brand new', '', 0, 0, '/'), false);
  assert.equal(c.drain()[0].count, 1);
});

// ---- API side ----------------------------------------------------------------------------------------------------
test('server: redaction and validation', () => {
  assert.equal(cleanErrorText('see https://x.overyondrdev.com/p?token=abc and ben.admin@overyondr.com'), 'see https://x.overyondrdev.com/p and [email]');
  assert.equal(cleanPagePath('/about?ref=mail#top'), '/about');
  assert.equal(cleanPagePath('about'), '/about');
  assert.equal(cleanReport(null), null);
  assert.equal(cleanReport({ errors: 'x' }), null);
  const r = cleanReport({ project: 'V1', page_path: '/a?x=1', errors: [{ message: 'm', count: 5000 }, { message: '' }, null, ...Array(30).fill({ message: 'n' })] });
  assert.equal(r.project, 'v1');
  assert.equal(r.items.length, 18, 'only the first 20 entries are read; empty ones dropped');
  assert.deepEqual(r.items[0], { page_path: '/a', message: 'm', source: '', count: 1000 });
});

test('server: forwarding threshold is every multiple of 10', () => {
  assert.equal(crossesStep(0, 9), false);
  assert.equal(crossesStep(9, 10), true);
  assert.equal(crossesStep(10, 19), false);
  assert.equal(crossesStep(18, 31), true);
  const ev = clientErrorsEvent('v1', 20, Array(7).fill({ message: 'm ada.owner@overyondr.com', source: 's', page_path: '/p', extra: 1 }));
  assert.deepEqual(Object.keys(ev), ['type', 'project', 'count', 'window_minutes', 'sample']);
  assert.equal(ev.sample.length, 5);
  assert.deepEqual(ev.sample[0], { message: 'm [email removed]', source: 's', page_path: '/p' });
  assert.equal(ev.window_minutes, 15);
});

const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-key' };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function session(email) {
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ typ: 'session', iss: 'https://auth.overyondrdev.com', aud: 'overyondrdev.com', exp: Date.now() / 1000 + 3600, email, name: 'Test' }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

let env, sent, origFetch;
beforeEach(() => {
  resetSchemaCache();
  env = { DB: fakeD1(), SHOTS: fakeKV(), YONDR_AUTH_PUBLIC_JWK: JSON.stringify(pub), ALLOWED_EMAIL_DOMAINS: 'overyondr.com', OPS_INGEST_TOKEN: TOKEN };
  sent = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response('{}', { status: 202 });
  };
});
afterEach(() => { globalThis.fetch = origFetch; });

async function call(path, { method = 'GET', as = STAFF, body, csrf = true, origin = ORIGIN } = {}) {
  const h = { cookie: `yondr_session=${await session(as)}` };
  if (origin) h.origin = origin;
  if (method !== 'GET' && csrf) h['x-yondr-feedback'] = '1';
  if (body) h['content-type'] = 'application/json';
  const waits = [];
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return { res, status: res.status, data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
}
const report = (errors, page_path = '/about') => ({ project: 'v1', page_path, errors });

test('POST /api/client-errors: signed in + CSRF; stored de-duplicated without query strings or emails', async () => {
  assert.equal((await call('/api/client-errors', { method: 'POST', body: report([{ message: 'x' }]), csrf: false })).status, 403);
  assert.equal((await call('/api/client-errors', { method: 'POST', body: report([{ message: 'x' }]), origin: 'https://evil.example' })).status, 403);
  const r = await call('/api/client-errors', { method: 'POST', body: report([{ message: 'TypeError at https://v1.overyondrdev.com/?e=cy.staff@overyondr.com', source: 'https://v1.overyondrdev.com/js/site.js?v=2:4:1', count: 3 }], '/about?utm=x') });
  assert.equal(r.status, 202);
  assert.equal(r.res.headers.get('access-control-allow-origin'), ORIGIN);
  await call('/api/client-errors', { method: 'POST', body: report([{ message: 'TypeError at https://v1.overyondrdev.com/?e=other', source: 'https://v1.overyondrdev.com/js/site.js?v=3:4:1' }]) });
  const rows = env.DB.sqlite.prepare('SELECT * FROM client_errors').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 4);
  assert.equal(rows[0].page_path, '/about');
  assert.equal(rows[0].message, 'TypeError at https://v1.overyondrdev.com/');
  assert.equal(rows[0].source, 'https://v1.overyondrdev.com/js/site.js');
  assert.doesNotMatch(JSON.stringify(rows), /cy\.staff|@overyondr/);
});

test('rate limit: 60 requests per person per hour, then 429', async () => {
  await applySchema(env.DB);
  const user = { email: STAFF };
  const at = new Date('2026-11-27T10:15:00Z');
  const req = () => new Request(BASE + '/api/client-errors', { method: 'POST', body: JSON.stringify(report([{ message: 'x' }])) });
  for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) assert.equal((await recordClientErrors(req(), env, user, null, at)).status, 202);
  const over = await recordClientErrors(req(), env, user, null, at);
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), String(45 * 60));
  assert.equal((await recordClientErrors(req(), env, { email: OWNER }, null, at)).status, 202, 'per person');
  assert.equal((await recordClientErrors(req(), env, user, null, new Date('2026-11-27T11:00:01Z'))).status, 202, 'next hour');
  const keys = env.DB.sqlite.prepare('SELECT user_key FROM client_error_limits').all().map((r) => r.user_key);
  assert.ok(keys.every((k) => /^[0-9a-f]{32}$/.test(k)), 'the limit is keyed on a hash, not the email');
});

test('ops: forwarded when the project’s 15-minute count crosses a multiple of 10, with the exact body', async () => {
  await applySchema(env.DB);
  const user = { email: STAFF };
  const t0 = new Date('2026-11-27T10:00:00Z');
  const req = (errors, path = '/about') => new Request(BASE + '/api/client-errors', { method: 'POST', body: JSON.stringify(report(errors, path)) });
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  let r = await recordClientErrors(req([{ message: 'A', count: 6 }]), env, user, ctx, t0);
  assert.equal((await r.json()).forwarded, false);
  r = await recordClientErrors(req([{ message: 'B', source: 'https://v1.overyondrdev.com/s.js:1:1', count: 5 }], '/contact'), env, user, ctx, new Date(t0.getTime() + 60_000));
  assert.equal((await r.json()).forwarded, true);
  await Promise.all(waits);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://ops.overyondrdev.com/api/events');
  assert.equal(sent[0].headers['x-ops-token'], TOKEN);
  assert.deepEqual(sent[0].body, {
    type: 'client_errors', project: 'v1', count: 11, window_minutes: 15,
    sample: [{ message: 'B', source: 'https://v1.overyondrdev.com/s.js:1:1', page_path: '/contact' }, { message: 'A', source: '', page_path: '/about' }],
  });
  // 11 → 19: no new multiple of 10. 19 → 20: forwarded again. After 15 minutes the window starts over.
  await recordClientErrors(req([{ message: 'A', count: 8 }]), env, user, ctx, new Date(t0.getTime() + 120_000));
  assert.equal(sent.length, 1);
  await recordClientErrors(req([{ message: 'A' }]), env, user, ctx, new Date(t0.getTime() + 180_000));
  await Promise.all(waits);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.count, 20);
  await recordClientErrors(req([{ message: 'A', count: 5 }]), env, user, ctx, new Date(t0.getTime() + 20 * 60_000));
  await Promise.all(waits);
  assert.equal(sent.length, 2, '5 in the new window');
  // Without OPS_INGEST_TOKEN nothing is sent.
  delete env.OPS_INGEST_TOKEN;
  await recordClientErrors(req([{ message: 'A', count: 50 }]), env, user, ctx, new Date(t0.getTime() + 21 * 60_000));
  assert.equal(sent.length, 2);
});

test('GET /api/client-errors: admins only; filter by project', async () => {
  await applySchema(env.DB);
  env.DB.sqlite.prepare("INSERT INTO admins (email, role, added_at) VALUES (?, 'owner', 'x')").run(OWNER);
  await call('/api/client-errors', { method: 'POST', body: report([{ message: 'v1 error', count: 2 }]) });
  await call('/api/client-errors', { method: 'POST', body: { project: 'ads', page_path: '/', errors: [{ message: 'ads error' }] } });
  assert.equal((await call('/api/client-errors')).status, 403);
  const all = await call('/api/client-errors', { as: OWNER });
  assert.equal(all.status, 200);
  assert.equal(all.data.items.length, 2);
  assert.deepEqual(all.data.byProject.map((p) => [p.project, p.n]), [['v1', 2], ['ads', 1]]);
  const ads = await call('/api/client-errors?project=ads', { as: OWNER });
  assert.deepEqual(ads.data.items.map((i) => i.message), ['ads error']);
});
