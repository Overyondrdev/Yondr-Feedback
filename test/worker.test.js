// End to end through the Worker's fetch handler: sign-in gate, static files, CORS/CSRF, the API with project/asset,
// admin rules. Data lives in an in-memory SQLite database standing in for D1.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetSchemaCache } from '../src/schema.js';
import { fakeD1, fakeKV, legacyDb } from './helpers.js';

const OWNER = 'ada.owner@overyondr.com';
const ADMIN = 'ben.admin@overyondr.com';
const STAFF = 'cy.staff@overyondr.com';
const ORIGIN = 'https://ads.overyondrdev.com';
const BASE = 'https://feedback.overyondrdev.com';

// A real ES256 key pair, so the session cookie is verified exactly as in production (src/yondr-session.js).
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-key' };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function session(email, { exp = Date.now() / 1000 + 3600, iss = 'https://auth.overyondrdev.com' } = {}) {
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ typ: 'session', iss, aud: 'overyondrdev.com', exp, email, name: 'Test' }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

let env;
beforeEach(async () => {
  resetSchemaCache();
  env = { DB: legacyDb(), SHOTS: fakeKV(), YONDR_AUTH_PUBLIC_JWK: JSON.stringify(pub), ALLOWED_EMAIL_DOMAINS: 'overyondr.com' };
  env.DB.sqlite.prepare("INSERT INTO admins (email, role, added_at) VALUES (?, 'owner', 'x'), (?, 'admin', 'x')").run(OWNER, ADMIN);
});

async function call(path, { method = 'GET', as = STAFF, body, origin = ORIGIN, csrf = true, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.cookie = `other=1; yondr_session=${await session(as)}`;
  if (origin) h.origin = origin;
  if (method !== 'GET' && csrf) h['x-yondr-feedback'] = '1';
  if (body) h['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  const type = res.headers.get('content-type') || '';
  return { res, status: res.status, data: type.includes('json') ? await res.json() : null };
}

test('widget.js and brand files are public, with CORS * and the right caching', async () => {
  const w = await call('/widget.js', { as: null });
  assert.equal(w.status, 200);
  assert.match(w.res.headers.get('content-type'), /javascript/);
  assert.equal(w.res.headers.get('cache-control'), 'public, max-age=300');
  assert.match(await w.res.text(), /YondrFeedback/);
  const f = await call('/brand/fonts/inter-tight-latin-400-normal.woff2', { as: null });
  assert.equal(f.status, 200);
  assert.equal(f.res.headers.get('content-type'), 'font/woff2');
  assert.equal(f.res.headers.get('access-control-allow-origin'), '*');
  const bytes = new Uint8Array(await f.res.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'wOF2');
  const again = await call('/widget.js', { as: null, headers: { 'if-none-match': w.res.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('signed out: pages redirect to the Yondr sign-in, the API answers 401 JSON (with CORS)', async () => {
  for (const p of ['/', '/admin', '/admin.js', '/nope']) {
    const r = await call(p, { as: null });
    assert.equal(r.status, 302, p);
    assert.equal(r.res.headers.get('location'), 'https://auth.overyondrdev.com/login?return=' + encodeURIComponent(BASE + p));
  }
  const api = await call('/api/me', { as: null });
  assert.equal(api.status, 401);
  assert.match(api.data.error, /sign in/);
  assert.equal(api.res.headers.get('access-control-allow-origin'), ORIGIN);
  const post = await call('/api/feedback', { as: null, method: 'POST', body: { message: 'x' } });
  assert.equal(post.status, 401);
});

test('forged, expired or foreign sessions are refused', async () => {
  const bad = [await session(STAFF, { exp: Date.now() / 1000 - 10 }), await session('someone@gmail.com'),
    await session(STAFF, { iss: 'https://evil.example' }), (await session(STAFF)).slice(0, -4) + 'AAAA'];
  for (const tok of bad) {
    const res = await worker.fetch(new Request(BASE + '/api/me', { headers: { cookie: `yondr_session=${tok}` } }), env);
    assert.equal(res.status, 401);
  }
  const res = await worker.fetch(new Request(BASE + '/api/me', { headers: { 'cf-access-jwt-assertion': 'x.y.z' } }), env);
  assert.equal(res.status, 401, 'no Cloudflare Access fallback');
});

test('signed in: / goes to /admin, which is the dashboard page with a strict CSP', async () => {
  const root = await call('/');
  assert.equal(root.status, 302);
  assert.equal(root.res.headers.get('location'), BASE + '/admin');
  const admin = await call('/admin');
  assert.equal(admin.status, 200);
  const html = await admin.res.text();
  assert.match(html, /\/admin\.js\?v=[0-9a-f]{16}/);
  assert.match(admin.res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  // The shared people picker (auth.overyondrdev.com) may load and look people up; nothing else.
  assert.match(admin.res.headers.get('content-security-policy'), /script-src 'self' https:\/\/auth\.overyondrdev\.com;/);
  assert.match(admin.res.headers.get('content-security-policy'), /connect-src 'self' https:\/\/auth\.overyondrdev\.com;/);
});

test('create feedback about an asset from another site, list it by project and asset', async () => {
  const created = await call('/api/feedback', { method: 'POST', body: {
    project: 'ads', asset: 'ad-42', assetLabel: 'Spring LinkedIn ad', type: 'design', priority: 'high', message: 'Logo too small',
    url: 'https://ads.overyondrdev.com/ads/42', path: '/ads/42', pageTitle: 'Ad 42', context: { viewport: { w: 375, h: 800 } },
    screenshots: [{ dataUrl: 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64'), width: 1, height: 1 }],
  } });
  assert.equal(created.status, 201);
  assert.equal(created.res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(created.res.headers.get('access-control-allow-credentials'), 'true');
  assert.deepEqual({ project: created.data.project, asset: created.data.asset }, { project: 'ads', asset: 'ad-42' });
  const id = created.data.id;

  const mine = await call('/api/feedback?scope=mine&sort=updated');
  const item = mine.data.items.find((i) => i.id === id);
  assert.equal(item.project, 'ads');
  assert.equal(item.site, 'ads');
  assert.equal(item.asset_label, 'Spring LinkedIn ad');
  assert.equal(item.attachment_count, 1);

  const byAsset = await call('/api/feedback?scope=all&project=ads&asset=ad-42', { as: ADMIN });
  assert.deepEqual(byAsset.data.items.map((i) => i.id), [id]);
  const pagesOnly = await call('/api/feedback?scope=all&project=ads&asset=', { as: ADMIN });
  assert.equal(pagesOnly.data.items.length, 0);
  const legacy = await call('/api/feedback?scope=all&site=v2', { as: ADMIN });
  assert.deepEqual(legacy.data.items.map((i) => i.message), ['Old V2 feedback']);
  const search = await call('/api/feedback?scope=all&q=LinkedIn', { as: ADMIN });
  assert.deepEqual(search.data.items.map((i) => i.id), [id]);

  const detail = await call(`/api/feedback/${id}`);
  const shot = await call(`/api/attachments/${detail.data.attachments[0].id}`);
  assert.equal(shot.status, 200);
  assert.equal(shot.res.headers.get('content-type'), 'image/png');

  const stats = await call('/api/stats', { as: ADMIN });
  assert.equal(stats.data.byProject.ads, 1);
  assert.equal(stats.data.byProject.v1, 1);
  assert.deepEqual(stats.data.topAssets.map((a) => [a.project, a.asset, a.label, a.n]), [['ads', 'ad-42', 'Spring LinkedIn ad', 1]]);

  const csv = await worker.fetch(new Request(BASE + '/api/export.csv', { headers: { cookie: `yondr_session=${await session(ADMIN)}` } }), env);
  const head = (await csv.text()).split('\r\n')[0];
  assert.match(head, /"?project"?,"?asset"?,"?asset_label"?|project,asset,asset_label/);
});

test('older clients that send only `site` still work; unknown projects fall back', async () => {
  const a = await call('/api/feedback', { method: 'POST', body: { site: 'v2', message: 'old widget', url: 'u', path: '/' } });
  const b = await call('/api/feedback', { method: 'POST', body: { project: 'Not valid!', message: 'x', url: 'u', path: '/' } });
  const rows = env.DB.sqlite.prepare('SELECT id, project, site FROM feedback WHERE id IN (?, ?) ORDER BY id').all(a.data.id, b.data.id);
  assert.deepEqual(rows.map((r) => [r.project, r.site]), [['v2', 'v2'], ['general', 'general']]);
});

test('CSRF: changes without the header or from a foreign origin are refused before anything happens', async () => {
  const count = () => env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get().n;
  const before = count();
  const noHeader = await call('/api/feedback', { method: 'POST', csrf: false, body: { message: 'x' } });
  assert.equal(noHeader.status, 403);
  const evil = await call('/api/feedback', { method: 'POST', origin: 'https://evil.example', body: { message: 'x' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.res.headers.get('access-control-allow-origin'), null);
  const noOrigin = await call('/api/feedback', { method: 'POST', origin: null, body: { message: 'x' } });
  assert.equal(noOrigin.status, 403);
  assert.equal(count(), before);
  const ok = await call('/api/feedback', { method: 'POST', origin: BASE, body: { message: 'from the admin page', url: 'u', path: '/' } });
  assert.equal(ok.status, 201, 'same-origin admin page');
});

test('preflight from an allowed and a disallowed origin', async () => {
  const ok = await worker.fetch(new Request(BASE + '/api/feedback', { method: 'OPTIONS', headers: { origin: 'https://v1.overyondrdev.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-yondr-feedback' } }), env);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://v1.overyondrdev.com');
  const no = await worker.fetch(new Request(BASE + '/api/feedback', { method: 'OPTIONS', headers: { origin: 'https://example.com' } }), env);
  assert.equal(no.status, 403);
});

test('admins: an admin cannot demote or remove an owner; an owner can', async () => {
  const demote = await call('/api/admins', { as: ADMIN, method: 'POST', body: { email: OWNER, role: 'admin' } });
  assert.equal(demote.status, 403);
  assert.equal(env.DB.sqlite.prepare('SELECT role FROM admins WHERE email = ?').get(OWNER).role, 'owner');
  const remove = await call('/api/admins', { as: ADMIN, method: 'DELETE', body: { email: OWNER } });
  assert.equal(remove.status, 403);
  const add = await call('/api/admins', { as: ADMIN, method: 'POST', body: { email: 'dee.new@overyondr.com', role: 'owner' } });
  assert.equal(add.status, 200);
  assert.equal(add.data.admins.find((a) => a.email === 'dee.new@overyondr.com').role, 'admin', 'an admin can only add admins');
  const staff = await call('/api/admins', { as: STAFF });
  assert.equal(staff.status, 403);
  const self = await call('/api/admins', { as: OWNER, method: 'DELETE', body: { email: OWNER } });
  assert.equal(self.status, 400);
  const promote = await call('/api/admins', { as: OWNER, method: 'POST', body: { email: 'dee.new@overyondr.com', role: 'owner' } });
  assert.equal(promote.data.admins.find((a) => a.email === 'dee.new@overyondr.com').role, 'owner');
  const rm = await call('/api/admins', { as: OWNER, method: 'DELETE', body: { email: 'dee.new@overyondr.com' } });
  assert.equal(rm.status, 200);
  assert.equal(rm.data.admins.some((a) => a.email === 'dee.new@overyondr.com'), false);
});

test('people only see their own feedback; admins see everything', async () => {
  const a = await call('/api/feedback', { as: STAFF, method: 'POST', body: { project: 'cards', message: 'mine', url: 'u', path: '/' } });
  const other = await call(`/api/feedback/${a.data.id}`, { as: 'dee.new@overyondr.com' });
  assert.equal(other.status, 404);
  const all = await call('/api/feedback?scope=all', { as: 'dee.new@overyondr.com' });
  assert.equal(all.data.scope, 'mine');
  assert.equal(all.data.items.length, 0);
  const admin = await call(`/api/feedback/${a.data.id}`, { as: ADMIN });
  assert.equal(admin.status, 200);
});
