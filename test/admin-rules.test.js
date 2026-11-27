import test from 'node:test';
import assert from 'node:assert/strict';
import { adminChangeProblem, cleanProject, cleanAsset } from '../src/api.js';

const base = { actorEmail: 'ben.admin@overyondr.com', targetEmail: 'ada.owner@overyondr.com' };

test('only an owner can change an owner’s role (re-adding an owner as admin would demote them)', () => {
  assert.deepEqual(adminChangeProblem({ ...base, method: 'POST', actorRole: 'admin', targetRole: 'owner' }), [403, 'Only an owner can change an owner’s role.']);
  assert.equal(adminChangeProblem({ ...base, method: 'POST', actorRole: 'owner', targetRole: 'owner' }), null);
  assert.equal(adminChangeProblem({ ...base, method: 'POST', actorRole: 'admin', targetRole: 'admin' }), null);
  assert.equal(adminChangeProblem({ ...base, method: 'POST', actorRole: 'admin', targetRole: null }), null);
});

test('only an owner can remove an owner; nobody can remove themselves', () => {
  assert.deepEqual(adminChangeProblem({ ...base, method: 'DELETE', actorRole: 'admin', targetRole: 'owner' }), [403, 'Only an owner can remove an owner.']);
  assert.equal(adminChangeProblem({ ...base, method: 'DELETE', actorRole: 'owner', targetRole: 'owner' }), null);
  assert.equal(adminChangeProblem({ ...base, method: 'DELETE', actorRole: 'admin', targetRole: 'admin' }), null);
  assert.deepEqual(adminChangeProblem({ method: 'DELETE', actorRole: 'owner', actorEmail: 'ada.owner@overyondr.com', targetEmail: 'ada.owner@overyondr.com', targetRole: 'owner' }),
    [400, 'You can’t remove yourself.']);
});

test('admins must be @overyondr.com', () => {
  for (const e of ['someone@gmail.com', 'x@overyondr.com.evil.com', '', 'a b' + '@overyondr.com'])
    assert.equal(adminChangeProblem({ ...base, targetEmail: e, method: 'POST', actorRole: 'owner' })[0], 400, e);
});

test('project ids and asset ids are cleaned', () => {
  assert.equal(cleanProject('Ads'), 'ads');
  assert.equal(cleanProject(' requests '), 'requests');
  assert.equal(cleanProject('ad library'), null);
  assert.equal(cleanProject('-x'), null);
  assert.equal(cleanProject('x'.repeat(41)), null);
  assert.equal(cleanAsset('  ad-123 '), 'ad-123');
  assert.equal(cleanAsset(''), null);
  assert.equal(cleanAsset('a\nb'), 'ab');
  assert.equal(cleanAsset('x'.repeat(300)).length, 200);
});
