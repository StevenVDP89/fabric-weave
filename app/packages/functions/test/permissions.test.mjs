import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import {
  accessCounts,
  canRead,
  canSeeWorkspace,
  canWrite,
  editableWorkspaces,
  forgetAccess,
  grantsOf,
  requireModelRead,
  requireModelWrite,
  requireWorkspaceAdmin,
} from '../dist/lib/permissions.js';
import { applyFixes, rollbackChangeSet } from '../dist/lib/apply.js';
import { getPortfolio, listModels, saveWorkspaceSetting } from '../dist/lib/ops.js';
import { portfolioConfigured } from '../dist/lib/portfolio.js';

const ANN = '5640125b-aa74-4163-b232-703c9729f1c3';
const WS1 = 'aaaaaaaa-1111-4222-8333-444444444441';
const WS2 = 'aaaaaaaa-1111-4222-8333-444444444442';
const WS3 = 'aaaaaaaa-1111-4222-8333-444444444443';
const M1 = 'bbbbbbbb-1111-4222-8333-444444444441';
const M2 = 'bbbbbbbb-1111-4222-8333-444444444442';
const M3 = 'bbbbbbbb-1111-4222-8333-444444444443';
const DIGEST = 'a'.repeat(64);

const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const audits = [];
const person = (claims, admins) => ({
  accessToken: token(claims),
  Secrets: admins ? { APP_ADMINS: admins } : {},
  Tokens: { Fabric: 'fabric-token' },
  getDataClient: () => ({ AuditLog: { create: async (row) => audits.push(row) } }),
});
const ann = () => person({ oid: ANN, preferred_username: 'ann@contoso.com' });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
let calls;
/** `routes` maps a URL suffix to a response or a function returning one. The longest matching suffix wins. */
const serve = (routes) => {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const key = Object.keys(routes)
      .filter((k) => u.endsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return json({ error: `no route for ${u}` }, 500);
    const r = routes[key];
    return typeof r === 'function' ? r(u) : r instanceof Response ? r.clone() : r;
  };
};
const hits = (needle) => calls.filter((u) => u.includes(needle)).length;

const access = (...rows) => json({ accessEntities: rows.map(([id, permissions]) => ({ id, displayName: id, itemAccessDetails: { type: 'SemanticModel', permissions } })) });
const tenant = (...rows) => json({ itemEntities: rows.map(([id, workspaceId]) => ({ id, name: id, workspaceId })) });
const roles = (...rows) => json({ value: rows.map(([id, type, role, upn]) => ({ id: `ra-${id}`, principal: { id, type, ...(upn ? { userDetails: { userPrincipalName: upn } } : {}) }, role })) });
const denied = () => json({ errorCode: 'Unauthorized' }, 403);

beforeEach(() => {
  forgetAccess();
  audits.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('with the Fabric admin API, a person sees what Fabric says they can reach and writes only where Fabric allows', async () => {
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M1, ['Read', 'Write', 'ReShare']], [M2, ['Read', 'Explore']], [M3, []]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1], [M2, WS2], [M3, WS2]),
  });
  const g = await grantsOf(ann());
  assert.equal(g.source, 'fabric-admin-api');
  assert.equal(canRead(g, WS1, M1), true);
  assert.equal(canWrite(g, WS1, M1), true);
  assert.equal(canRead(g, WS2, M2), true);
  assert.equal(canWrite(g, WS2, M2), false);
  assert.equal(canRead(g, WS2, M3), false, 'a model with no permissions is not reachable');
  assert.equal(canRead(g, WS3, M1), false, 'the model must belong to the workspace asked about');
  assert.equal(canSeeWorkspace(g, WS1), true);
  assert.equal(canSeeWorkspace(g, WS3), false);
  assert.deepEqual(accessCounts(g), { workspaces: 2, models: 2 });
});

test('what was learned about a person is remembered, so the admin API is not called on every request', async () => {
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M1, ['Read', 'Write']]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1]),
  });
  await grantsOf(ann());
  await grantsOf(ann());
  await grantsOf(ann());
  assert.equal(hits('/access?'), 1);
  assert.equal(hits('/admin/items'), 1);
});

test('when the app owner is not a Fabric administrator, the person\'s direct workspace roles are used', async () => {
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: denied(),
    '/admin/items?type=SemanticModel': denied(),
    '/v1/workspaces': json({ value: [{ id: WS1, displayName: 'One', type: 'Workspace' }, { id: WS2, displayName: 'Two', type: 'Workspace' }, { id: WS3, displayName: 'Three', type: 'Workspace' }] }),
    [`/workspaces/${WS1}/roleAssignments`]: roles([ANN, 'User', 'Contributor', 'ann@contoso.com'], ['9999', 'User', 'Admin']),
    [`/workspaces/${WS2}/roleAssignments`]: roles(['g-1', 'Group', 'Admin']),
    [`/workspaces/${WS3}/roleAssignments`]: denied(),
  });
  const g = await grantsOf(ann());
  assert.equal(g.source, 'workspace-roles');
  assert.equal(canRead(g, WS1, M1), true);
  assert.equal(canWrite(g, WS1, M1), true);
  assert.equal(canSeeWorkspace(g, WS2), false, 'a role given only through a group cannot be confirmed');
  assert.equal(canSeeWorkspace(g, WS3), false, 'an unreadable workspace is not shown');
  assert.match(g.note, /1 workspace grant access through groups/);
  assert.match(g.note, /1 workspace could not be checked/);
});

test('a Viewer in a workspace can read its models but not write to them', async () => {
  serve({
    '/admin/users/ann%40contoso.com/access?type=SemanticModel': denied(),
    '/admin/items?type=SemanticModel': denied(),
    '/v1/workspaces': json({ value: [{ id: WS1, displayName: 'One', type: 'Workspace' }] }),
    [`/workspaces/${WS1}/roleAssignments`]: roles(['ann@contoso.com', 'User', 'Viewer', 'ann@contoso.com']),
  });
  const g = await grantsOf(person({ preferred_username: 'Ann@Contoso.com' }));
  assert.equal(canRead(g, WS1, M1), true);
  assert.equal(canWrite(g, WS1, M1), false);
});

test('an app administrator sees and changes everything without any call to Fabric', async () => {
  serve({});
  const admin = person({ oid: ANN }, ANN);
  const g = await grantsOf(admin);
  assert.equal(g.source, 'everything');
  assert.equal(canWrite(g, WS3, M3), true);
  await requireModelWrite(admin, WS1, M1, 'apply fixes');
  await requireWorkspaceAdmin(admin, WS1, 'change a write mode');
  assert.equal(calls.length, 0);
});

test('someone the app cannot identify sees nothing and can change nothing', async () => {
  serve({});
  const nobody = person({ name: 'Ann Display' });
  const g = await grantsOf(nobody);
  assert.equal(g.source, 'unresolved');
  assert.equal(canRead(g, WS1, M1), false);
  assert.equal(canSeeWorkspace(g, WS1), false);
  await assert.rejects(requireModelWrite(nobody, WS1, M1, 'apply fixes'), /could not tell who you are/);
  await assert.rejects(requireWorkspaceAdmin(nobody, WS1, 'change a write mode'), /could not tell who you are/);
  assert.equal(calls.length, 0);
});

test('when Fabric cannot be asked, access fails closed and says why', async () => {
  serve({ [`/admin/users/${ANN}/access?type=SemanticModel`]: json({ error: 'boom' }, 500), '/admin/items?type=SemanticModel': tenant() });
  const g = await grantsOf(ann());
  assert.equal(g.source, 'unresolved');
  assert.match(g.note, /could not be checked right now/);
  assert.equal(canRead(g, WS1, M1), false);
});

test('reading a model needs read access in Fabric, and a refusal is audited', async () => {
  let granted = false;
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: () => (granted ? access([M1, ['Read']]) : access()),
    '/admin/items?type=SemanticModel': tenant([M1, WS1]),
  });
  await assert.rejects(requireModelRead(ann(), WS1, M1), /do not have access to this model in Fabric/);
  assert.equal(audits.at(-1).action, 'access.denied');
  assert.equal(audits.at(-1).outcome, 'error');

  granted = true;
  forgetAccess();
  const g = await requireModelRead(ann(), WS1, M1);
  assert.equal(canRead(g, WS1, M1), true);
});

test('writing is always checked against Fabric right now, never from memory', async () => {
  let write = true;
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: () => access([M1, write ? ['Read', 'Write'] : ['Read']]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1]),
  });
  const g = await grantsOf(ann());
  assert.equal(canWrite(g, WS1, M1), true);
  await requireModelWrite(ann(), WS1, M1, 'apply fixes to this model');

  write = false;
  await assert.rejects(requireModelWrite(ann(), WS1, M1, 'apply fixes to this model'), /do not have write access to this model/);
  assert.equal(audits.at(-1).action, 'access.denied');
  assert.equal(audits.at(-1).model_id, M1);
});

test('a model the person has no write permission on is refused even when the model id is not listed at all', async () => {
  serve({ [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M2, ['Read', 'Write']]), '/admin/items?type=SemanticModel': tenant() });
  await assert.rejects(requireModelWrite(ann(), WS1, M1, 'apply fixes to this model'), /do not have write access/);
});

test('a failure while checking write access refuses the change and says nothing was changed', async () => {
  serve({ [`/admin/users/${ANN}/access?type=SemanticModel`]: json({ error: 'boom' }, 500) });
  await assert.rejects(requireModelWrite(ann(), WS1, M1, 'apply fixes to this model'), /could not be checked, so nothing was changed/);
});

test('without the Fabric admin API, writing needs a direct Contributor, Member or Admin role', async () => {
  const roleOf = (role) =>
    serve({
      [`/admin/users/${ANN}/access?type=SemanticModel`]: denied(),
      [`/workspaces/${WS1}/roleAssignments`]: roles([ANN, 'User', role]),
    });
  for (const role of ['Contributor', 'Member', 'Admin']) {
    roleOf(role);
    await requireModelWrite(ann(), WS1, M1, 'apply fixes to this model');
  }
  roleOf('Viewer');
  await assert.rejects(requireModelWrite(ann(), WS1, M1, 'apply fixes to this model'), /do not hold the Contributor, Member or Admin role/);

  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: denied(),
    [`/workspaces/${WS1}/roleAssignments`]: roles(['g-1', 'Group', 'Admin']),
  });
  await assert.rejects(requireModelWrite(ann(), WS1, M1, 'apply fixes to this model'), /do not hold the Contributor, Member or Admin role/);
});

test('changing a workspace write mode needs the Admin role in that workspace, directly', async () => {
  const roleOf = (role) => serve({ [`/workspaces/${WS1}/roleAssignments`]: roles([ANN, 'User', role]) });
  roleOf('Admin');
  await requireWorkspaceAdmin(ann(), WS1, 'change a workspace write mode');
  for (const role of ['Member', 'Contributor', 'Viewer']) {
    roleOf(role);
    await assert.rejects(requireWorkspaceAdmin(ann(), WS1, 'change a workspace write mode'), /Only a workspace Admin can change a workspace write mode/);
  }
  serve({ [`/workspaces/${WS1}/roleAssignments`]: roles(['g-1', 'Group', 'Admin']) });
  await assert.rejects(requireWorkspaceAdmin(ann(), WS1, 'change a workspace write mode'), /Only a workspace Admin/);
  serve({ [`/workspaces/${WS1}/roleAssignments`]: denied() });
  await assert.rejects(requireWorkspaceAdmin(ann(), WS1, 'change a workspace write mode'), /could not be checked, so nothing was changed/);
  assert.ok(audits.every((a) => a.action === 'access.denied'));
});

test('only the workspaces where the person is an Admin are editable', async () => {
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M1, ['Read', 'Write']], [M2, ['Read', 'Write']]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1], [M2, WS2]),
    [`/workspaces/${WS1}/roleAssignments`]: roles([ANN, 'User', 'Admin']),
    [`/workspaces/${WS2}/roleAssignments`]: roles([ANN, 'User', 'Contributor']),
  });
  const c = ann();
  const g = await grantsOf(c);
  const editable = await editableWorkspaces(c, g, [WS1, WS2, WS3]);
  assert.deepEqual([...editable], [WS1]);

  const admin = person({ oid: ANN }, ANN);
  assert.deepEqual([...(await editableWorkspaces(admin, await grantsOf(admin), [WS1, WS2]))].sort(), [WS1, WS2]);
});

test('changing a write mode is refused for someone who is not a workspace Admin, before anything is read or saved', async () => {
  serve({ [`/workspaces/${WS1}/roleAssignments`]: roles([ANN, 'User', 'Member']) });
  await assert.rejects(saveWorkspaceSetting(ann(), WS1, 'in-place', true), /Only a workspace Admin can change a workspace write mode/);
  await assert.rejects(saveWorkspaceSetting(ann(), 'not-a-guid', 'in-place', true), /workspaceId must be a GUID/);
  assert.equal(hits('/semanticModels'), 0);
});

test('applying fixes and rolling back need write access to that model', async () => {
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M1, ['Read']]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1]),
  });
  await assert.rejects(applyFixes(ann(), WS1, M1, [], DIGEST), /do not have write access to this model/);

  const csId = 'cccccccc-1111-4222-8333-444444444444';
  const rows = [{ id: csId, workspace_id: WS1, model_id: M1, mode: 'in-place', status: 'applied', snapshot_id: 's', snapshot_sig: 'x', result_digest: 'y', created_at: new Date() }];
  const c = ann();
  c.getDataClient = () => ({
    AuditLog: { create: async (row) => audits.push(row) },
    ChangeSet: { select: () => ({ where: () => ({ first: () => ({ execute: async () => rows }) }) }) },
  });
  await assert.rejects(rollbackChangeSet(c, csId, false), /do not have write access to this model/);
});

test('the model list shows only the models the person can reach, with what they can change', async () => {
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M1, ['Read', 'Write']], [M2, ['Read']]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1], [M2, WS1], [M3, WS1]),
    [`/workspaces/${WS1}`]: json({ id: WS1, displayName: 'One' }),
    [`/workspaces/${WS1}/semanticModels`]: json({ value: [{ id: M1, displayName: 'Sales' }, { id: M2, displayName: 'Finance' }, { id: M3, displayName: 'Secret' }] }),
  });
  const c = ann();
  c.getDataClient = () => ({ AuditLog: { create: async () => undefined }, ModelAssessment: { select: () => ({ where: () => ({ first: () => ({ execute: async () => [] }) }) }) } });
  const models = await listModels(c, WS1);
  assert.deepEqual(
    models.map((m) => [m.name, m.canWrite]),
    [
      ['Finance', false],
      ['Sales', true],
    ],
  );

  await assert.rejects(listModels(c, WS3), /do not have access to this workspace in Fabric/);
});

test('without the estate scan (PORTFOLIO_PATH unset or "disabled") the portfolio is simply off and OneLake is never called', async () => {
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M1, ['Read']]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1]),
  });
  const secrets = (extra) => {
    const c = ann();
    c.Secrets = { ...extra };
    c.getDataClient = () => ({ ModelAssessment: { select: () => ({ first: () => ({ execute: async () => [] }) }) } });
    return c;
  };
  assert.equal(portfolioConfigured(secrets({})), false);
  assert.equal(portfolioConfigured(secrets({ PORTFOLIO_PATH: 'disabled' })), false);
  assert.equal(portfolioConfigured(secrets({ PORTFOLIO_PATH: `${WS1}/${WS2}` })), true);

  for (const extra of [{}, { PORTFOLIO_PATH: 'disabled' }]) {
    const view = await getPortfolio(secrets(extra), {});
    assert.equal(view.available, false);
    assert.equal(view.models.length, 0);
    assert.equal(view.lastRun, null);
    assert.match(view.reason, /not installed/);
  }
  assert.equal(hits('onelake'), 0);
});

test('the portfolio is cut down to the models the person can reach, and is empty when access is unknown', async () => {
  const onelake = (models) => json({ generatedAt: '2026-10-20T02:00:00Z', workspaces: [{ id: WS1, name: 'One' }, { id: WS2, name: 'Two' }], models });
  const rows = [
    { modelId: M1, workspaceId: WS1, name: 'Sales', quickScore: { score: 5, tier: 'Partly ready' } },
    { modelId: M2, workspaceId: WS2, name: 'Finance', quickScore: { score: 3, tier: 'Not ready' } },
  ];
  serve({
    [`/admin/users/${ANN}/access?type=SemanticModel`]: access([M1, ['Read']]),
    '/admin/items?type=SemanticModel': tenant([M1, WS1], [M2, WS2]),
    '/portfolio.json': onelake(rows),
    '/run_status.json': json({}, 404),
  });
  const withPortfolio = (c) => {
    c.Secrets = { PORTFOLIO_PATH: `${WS1}/${WS2}` };
    c.getDataClient = () => ({ ModelAssessment: { select: () => ({ first: () => ({ execute: async () => [] }) }) } });
    return c;
  };
  const view = await getPortfolio(withPortfolio(ann()), {});
  assert.equal(view.available, true);
  assert.deepEqual(view.models.map((m) => m.name), ['Sales']);
  assert.equal(view.totals.models, 1);
  assert.equal(view.totals.workspaces, 1);

  forgetAccess();
  const stranger = withPortfolio(person({ name: 'Nobody' }));
  const none = await getPortfolio(stranger, {});
  assert.equal(none.available, false);
  assert.equal(none.models.length, 0);
  assert.match(none.reason, /could not tell who you are/);
});
