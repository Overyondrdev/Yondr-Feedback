import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, preflight, csrfProblem, corsHeaders } from '../src/http.js';

const req = (method, headers = {}) => new Request('https://feedback.overyondrdev.com/api/feedback', { method, headers });

test('CORS: only https *.overyondrdev.com origins are allowed', () => {
  for (const o of ['https://overyondrdev.com', 'https://v1.overyondrdev.com', 'https://ads.overyondrdev.com',
    'https://feedback.overyondrdev.com', 'https://a.b-c.overyondrdev.com']) assert.equal(isAllowedOrigin(o), true, o);
  for (const o of ['http://v1.overyondrdev.com', 'https://overyondrdev.com.evil.com', 'https://evilyondrdev.com',
    'https://evil-overyondrdev.com', 'https://overyondr.com', 'https://v1.overyondrdev.com:8443', 'https://v1.overyondrdev.com/',
    'https://V1.overyondrdev.com', 'null', '', undefined, 'http://localhost:4321']) assert.equal(isAllowedOrigin(o), false, String(o));
});

test('CORS: localhost is allowed only when running locally (DEV_EMAIL set)', () => {
  const dev = { DEV_EMAIL: 'you@overyondr.com' };
  for (const o of ['http://localhost', 'http://localhost:4321', 'http://127.0.0.1:8787']) assert.equal(isAllowedOrigin(o, dev), true, o);
  for (const o of ['https://localhost:4321', 'http://localhost.evil.com', 'http://localhost:4321/x']) assert.equal(isAllowedOrigin(o, dev), false, o);
  assert.equal(isAllowedOrigin('http://localhost:4321', {}), false);
});

test('CORS: the exact origin is echoed with credentials and Vary: Origin', () => {
  const h = corsHeaders(req('GET', { origin: 'https://ads.overyondrdev.com' }), {});
  assert.deepEqual(h, { vary: 'Origin', 'access-control-allow-origin': 'https://ads.overyondrdev.com', 'access-control-allow-credentials': 'true' });
  assert.deepEqual(corsHeaders(req('GET', { origin: 'https://evil.example' }), {}), { vary: 'Origin' });
});

test('CORS preflight: allowed origin gets 204 with methods and headers, others 403', () => {
  const ok = preflight(req('OPTIONS', { origin: 'https://v2.overyondrdev.com', 'access-control-request-method': 'POST' }), {});
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://v2.overyondrdev.com');
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.match(ok.headers.get('access-control-allow-headers'), /X-Yondr-Feedback/);
  assert.match(ok.headers.get('access-control-allow-methods'), /PATCH/);
  const no = preflight(req('OPTIONS', { origin: 'https://evil.example' }), {});
  assert.equal(no.status, 403);
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('CSRF: changes need X-Yondr-Feedback: 1 and an allowed Origin; reads need neither', () => {
  const good = { origin: 'https://v1.overyondrdev.com', 'x-yondr-feedback': '1' };
  assert.equal(csrfProblem(req('GET'), {}), null);
  assert.equal(csrfProblem(req('HEAD'), {}), null);
  for (const m of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    assert.equal(csrfProblem(req(m, good), {}), null, m);
    assert.match(csrfProblem(req(m, { origin: good.origin }), {}), /X-Yondr-Feedback/, m);
    assert.match(csrfProblem(req(m, { 'x-yondr-feedback': '1' }), {}), /Origin/, m);
    assert.match(csrfProblem(req(m, { ...good, origin: 'https://evil.example' }), {}), /Origin/, m);
    assert.match(csrfProblem(req(m, { ...good, 'x-yondr-feedback': 'true' }), {}), /X-Yondr-Feedback/, m);
  }
});
