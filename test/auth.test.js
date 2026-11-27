import test from 'node:test';
import assert from 'node:assert/strict';
import { currentUser } from '../src/auth.js';

const env = { DEV_EMAIL: 'dev@overyondr.com', ALLOWED_EMAIL_DOMAINS: 'overyondr.com' };

test('DEV_EMAIL signs in on localhost', async () => {
  const u = await currentUser(new Request('http://localhost:8787/api/me'), env);
  assert.equal(u.email, 'dev@overyondr.com');
});

test('DEV_EMAIL is ignored on a deployed host, so it cannot skip sign-in', async () => {
  const u = await currentUser(new Request('https://feedback.overyondrdev.com/api/me'), env).catch(() => null);
  assert.equal(u, null);
});
