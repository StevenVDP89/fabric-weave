import assert from 'node:assert/strict';
import test from 'node:test';
import { adminsConfigured, identitiesOf, isAdmin, objectIdOf, parseAdmins, userRefOf } from '../dist/lib/access.js';
import { actorOf } from '../dist/lib/runtime.js';
import { parseRunStatus } from '../dist/lib/portfolio.js';

const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const ctx = (claims, admins) => ({
  accessToken: typeof claims === 'string' ? claims : token(claims),
  Secrets: admins === undefined ? {} : { APP_ADMINS: admins },
});

const OID = '5640125b-aa74-4163-b232-703c9729f1c3';
const RAYFIN_SUB = `/eid1/c/pub/t/dGVuYW50/a/YXBw/workspaces/4ef1a961-f577-4346-9c9b-2ed39b1563e9/projects/9d1b0f2e-0000-4000-8000-000000000000/users/${OID}`;

test('admins are split on commas, semicolons and whitespace, and lower-cased', () => {
  assert.deepEqual(parseAdmins(' Ann@Contoso.com, bob@contoso.com;00000000-0000-0000-0000-000000000001\n'), ['ann@contoso.com', 'bob@contoso.com', '00000000-0000-0000-0000-000000000001']);
  assert.deepEqual(parseAdmins(undefined), []);
  assert.deepEqual(parseAdmins('  , ; '), []);
});

test('the caller is matched on any identity claim, case-insensitively', () => {
  assert.equal(isAdmin(ctx({ preferred_username: 'Ann@Contoso.com' }, 'ann@contoso.com')), true);
  assert.equal(isAdmin(ctx({ upn: 'ann@contoso.com' }, 'ANN@contoso.com')), true);
  assert.equal(isAdmin(ctx({ oid: 'abc-123', preferred_username: 'someone@else.com' }, 'abc-123')), true);
  assert.equal(isAdmin(ctx({ preferred_username: 'eve@contoso.com' }, 'ann@contoso.com')), false);
});

test('the display name never counts as an identity', () => {
  assert.equal(isAdmin(ctx({ name: 'ann@contoso.com' }, 'ann@contoso.com')), false);
  assert.deepEqual(identitiesOf(ctx({ name: 'Ann', preferred_username: 'ann@contoso.com', oid: 'o-1', tid: 't' }, 'x')).sort(), ['ann@contoso.com', 'o-1']);
});

test('nobody is an admin when none are configured, or when the token is unreadable', () => {
  assert.equal(adminsConfigured(ctx({ upn: 'a@b.c' })), false);
  assert.equal(isAdmin(ctx({ upn: 'a@b.c' })), false);
  assert.equal(isAdmin(ctx({ upn: 'a@b.c' }, '   ')), false);
  assert.equal(isAdmin(ctx('not-a-token', 'a@b.c')), false);
  assert.deepEqual(identitiesOf(ctx('a.%%%.c', 'a@b.c')), []);
});

test('the object id comes from the oid claim, or from the end of Rayfin\'s path-style subject', () => {
  assert.equal(objectIdOf(ctx({ oid: OID.toUpperCase() })), OID);
  assert.equal(objectIdOf(ctx({ sub: RAYFIN_SUB })), OID);
  assert.equal(objectIdOf(ctx({ sub: `${RAYFIN_SUB}/` })), OID);
  assert.equal(objectIdOf(ctx({ oid: 'not-a-guid', sub: RAYFIN_SUB })), OID);
});

test('a plain subject is not an object id, and a path that does not end in a user is ignored', () => {
  assert.equal(objectIdOf(ctx({ sub: OID })), undefined);
  assert.equal(objectIdOf(ctx({ sub: `/eid1/c/pub/t/dA/a/YQ/workspaces/${OID}` })), undefined);
  assert.equal(objectIdOf(ctx({ sub: `${RAYFIN_SUB}/extra` })), undefined);
  assert.equal(objectIdOf(ctx('not-a-token')), undefined);
});

test('the person is looked up in Fabric by object id, else by sign-in name, never by display name', () => {
  assert.equal(userRefOf(ctx({ sub: RAYFIN_SUB, preferred_username: 'ann@contoso.com' })), OID);
  assert.equal(userRefOf(ctx({ preferred_username: 'Ann@Contoso.com' })), 'ann@contoso.com');
  assert.equal(userRefOf(ctx({ name: 'ann@contoso.com' })), undefined);
  assert.equal(userRefOf(ctx({ preferred_username: 'not an email' })), undefined);
  assert.equal(userRefOf(ctx({ sub: 'some-pairwise-subject' })), undefined);
});

test('an administrator can be listed by the object id found in the Rayfin subject', () => {
  assert.ok(identitiesOf(ctx({ sub: RAYFIN_SUB }, OID)).includes(OID));
  assert.equal(isAdmin(ctx({ sub: RAYFIN_SUB }, OID)), true);
  assert.equal(isAdmin(ctx({ sub: RAYFIN_SUB }, '00000000-0000-4000-8000-000000000001')), false);
});

test('the actor shown to people is the object id, not the long path', () => {
  assert.equal(actorOf(ctx({ sub: RAYFIN_SUB })), OID);
  assert.equal(actorOf(ctx({ sub: RAYFIN_SUB, preferred_username: 'ann@contoso.com' })), 'ann@contoso.com');
  assert.equal(actorOf(ctx({ sub: 'plain-subject' })), 'plain-subject');
});

test('the run status written by the notebooks is parsed defensively', () => {
  const ok = parseRunStatus({ runId: 'r1', status: 'Failed', stage: 'usage', startedAt: '2026-10-20T02:00:00Z', finishedAt: '2026-10-20T02:03:00Z', error: 'x'.repeat(900), models: 12 });
  assert.equal(ok.status, 'Failed');
  assert.equal(ok.stage, 'usage');
  assert.equal(ok.error.length, 500);
  assert.equal(ok.models, 12);

  const running = parseRunStatus({ status: 'Running', stage: 'scan', startedAt: '2026-10-20T02:00:00Z', finishedAt: null, error: null, models: null });
  assert.deepEqual([running.status, running.finishedAt, running.error, running.models], ['Running', null, null, null]);

  for (const bad of [null, undefined, 'x', 5, [], {}, { status: 'Done' }, { status: 'failed' }]) assert.equal(parseRunStatus(bad), null);
});
