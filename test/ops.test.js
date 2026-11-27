// Yondr Ops notifications (src/ops.js): what is sent, when, and that no personal data leaves this Worker.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { criticalEvent, opsCallsFor, opsPayload, redact } from '../src/ops.js';
import { resetSchemaCache } from '../src/schema.js';
import { fakeD1, fakeKV } from './helpers.js';

const OWNER = 'ada.owner@overyondr.com';
const STAFF = 'cy.staff@overyondr.com';
const BASE = 'https://feedback.overyondrdev.com';
const ORIGIN = 'https://v1.overyondrdev.com';
const TOKEN = 'test-ingest-token-0123456789abcdef0123456789';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-key' };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function session(email) {
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ typ: 'session', iss: 'https://auth.overyondrdev.com', aud: 'overyondrdev.com', exp: Date.now() / 1000 + 3600, email, name: 'Test' }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

let env;
let sent;
let waits;
let ctx;
beforeEach((t) => {
  resetSchemaCache();
  env = { DB: fakeD1(), SHOTS: fakeKV(), YONDR_AUTH_PUBLIC_JWK: JSON.stringify(pub), ALLOWED_EMAIL_DOMAINS: 'overyondr.com', OPS_INGEST_TOKEN: TOKEN };
  sent = [];
  waits = [];
  ctx = { waitUntil: (p) => waits.push(p) };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response('{}', { status: 201 });
  };
  t.after(() => { globalThis.fetch = orig; });
});

async function call(path, { method = 'GET', as = STAFF, body } = {}) {
  const headers = { cookie: `yondr_session=${await session(as)}`, origin: ORIGIN };
  if (method !== 'GET') headers['x-yondr-feedback'] = '1';
  if (body) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(BASE + '/api/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  const data = await res.json();
  await Promise.all(waits.splice(0));
  return { status: res.status, data };
}
async function makeOwner() {
  await call('me'); // applies the schema
  env.DB.sqlite.prepare("INSERT INTO admins (email, role, added_at) VALUES (?, 'owner', 'x')").run(OWNER);
}

test('redact removes e-mail addresses and phone numbers but keeps dates, ids and paths', () => {
  assert.equal(redact('Ask cy.staff@overyondr.com or call +44 20 7946 0958'), 'Ask [email removed] or call [number removed]');
  assert.equal(redact('Broken since 2026-11-27, order 12345, /blog?offset=1700000000000'), 'Broken since 2026-11-27, order 12345, /blog?offset=1700000000000');
});

test('the payload carries what triage needs and nothing personal', () => {
  const item = { id: 7, project: 'v1', asset: null, type: 'bug', priority: 'high', status: 'new', title: 'Footer link 404', message: 'Tell ben.admin@overyondr.com',
    url: 'https://v1.overyondrdev.com/about?x=1', path: '/about', page_title: 'About', author_email: STAFF, assignee: OWNER, created_at: '2026-11-27T10:00:00Z' };
  const p = opsPayload(item, [{ id: 'abc' }]);
  assert.deepEqual(Object.keys(p).sort(), ['admin_url', 'asset', 'created_at', 'feedback_id', 'message', 'page_title', 'path', 'priority', 'project', 'reason', 'screenshots', 'status', 'title', 'type', 'url']);
  assert.doesNotMatch(JSON.stringify(p), /@overyondr\.com/);
  assert.deepEqual(p.screenshots, ['/api/attachments/abc']);
  const e = criticalEvent({ ...item, priority: 'critical' });
  assert.equal(e.type, 'feedback_critical');
  assert.equal(e.dedupe_key, 'feedback_critical|7');
  assert.doesNotMatch(JSON.stringify(e), /@overyondr\.com/);
});

test('which calls a change needs', () => {
  const a = { type: 'design', priority: 'normal' };
  assert.deepEqual(opsCallsFor(null, a), { triage: true, critical: false });
  assert.deepEqual(opsCallsFor(null, { ...a, priority: 'critical' }), { triage: true, critical: true });
  assert.deepEqual(opsCallsFor(a, { ...a, type: 'bug' }), { triage: true, critical: false });
  assert.deepEqual(opsCallsFor(a, { ...a, priority: 'critical' }), { triage: true, critical: true });
  assert.deepEqual(opsCallsFor({ ...a, priority: 'critical' }, { ...a, priority: 'critical', type: 'bug' }), { triage: true, critical: false });
  assert.deepEqual(opsCallsFor(a, { ...a }), { triage: false, critical: false });
});

test('new feedback is sent to ops in the background with the token; critical also raises an alert', async () => {
  const r = await call('feedback', { method: 'POST', body: { project: 'v1', type: 'bug', priority: 'critical', message: 'The contact form does not submit',
    url: 'https://v1.overyondrdev.com/contact', path: '/contact', pageTitle: 'Contact', screenshots: [{ dataUrl: PNG, width: 1, height: 1 }] } });
  assert.equal(r.status, 201);
  assert.equal(sent.length, 2);
  const triage = sent.find((s) => s.url === 'https://ops.overyondrdev.com/api/autofix/feedback');
  const alert = sent.find((s) => s.url === 'https://ops.overyondrdev.com/api/events');
  assert.equal(triage.headers['x-ops-token'], TOKEN);
  assert.equal(triage.body.feedback_id, r.data.id);
  assert.equal(triage.body.type, 'bug');
  assert.equal(triage.body.reason, 'created');
  assert.match(triage.body.screenshots[0], /^\/api\/attachments\/[0-9a-f-]{36}$/);
  assert.equal(alert.body.type, 'feedback_critical');
  assert.doesNotMatch(JSON.stringify(sent), /@overyondr\.com/, 'no personal data is sent');
});

test('admin changes of type or priority are re-sent; other changes are not', async () => {
  await makeOwner();
  const r = await call('feedback', { method: 'POST', body: { project: 'v2', type: 'design', message: 'Button is cut off at 375px', url: 'https://v2.overyondrdev.com/', path: '/' } });
  assert.equal(sent.length, 1);
  sent.length = 0;
  await call(`feedback/${r.data.id}`, { method: 'PATCH', as: OWNER, body: { status: 'reviewing' } });
  assert.equal(sent.length, 0);
  await call(`feedback/${r.data.id}`, { method: 'PATCH', as: OWNER, body: { type: 'bug' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.type, 'bug');
  assert.equal(sent[0].body.reason, 'updated');
  sent.length = 0;
  await call(`feedback/${r.data.id}`, { method: 'PATCH', as: OWNER, body: { priority: 'critical' } });
  assert.deepEqual(sent.map((s) => s.url).sort(), ['https://ops.overyondrdev.com/api/autofix/feedback', 'https://ops.overyondrdev.com/api/events']);
});

test('without OPS_INGEST_TOKEN nothing is sent; an ops outage never fails the request', async () => {
  delete env.OPS_INGEST_TOKEN;
  const a = await call('feedback', { method: 'POST', body: { project: 'v1', type: 'bug', priority: 'critical', message: 'x', url: 'https://v1.overyondrdev.com/', path: '/' } });
  assert.equal(a.status, 201);
  assert.equal(sent.length, 0);
  env.OPS_INGEST_TOKEN = TOKEN;
  globalThis.fetch = async () => { throw new Error('ops is down'); };
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const b = await call('feedback', { method: 'POST', body: { project: 'v1', type: 'bug', message: 'y', url: 'https://v1.overyondrdev.com/', path: '/' } });
    assert.equal(b.status, 201);
  } finally { console.error = origErr; }
  assert.ok(errors.some((e) => /ops notify failed/.test(e)));
});
