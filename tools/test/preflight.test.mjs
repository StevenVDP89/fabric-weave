import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedDescription } from '../lib/common.mjs';
import { FabricClient } from '../lib/fabric.mjs';
import { formatResults, hasFailures, runPreflight } from '../preflight.mjs';
import { planTeardown } from '../teardown.mjs';

const WS = '00000000-0000-0000-0000-000000000000';
const ME = 'aaaaaaaa-0000-0000-0000-000000000001';
const jwt = `h.${Buffer.from(JSON.stringify({ oid: ME })).toString('base64url')}.s`;
const ACCOUNT = { ok: true, user: 'me@contoso.com', type: 'user', tenant: 't', detail: 'me@contoso.com (tenant t)' };

function fakeClient(over = {}) {
  return {
    token: () => jwt,
    getWorkspace: async () => ({ status: 200, json: { displayName: 'Demo WS', capacityId: 'cap-1' } }),
    getCapacity: async () => ({ capacity: { displayName: 'cap', sku: 'F64', state: 'Active' } }),
    getRoleAssignments: async () => ({ status: 200, json: { value: [{ role: 'Admin', principal: { id: ME, type: 'User' } }] } }),
    probeFabricAdmin: async () => ({ status: 200 }),
    listItems: async () => [],
    ...over,
  };
}

const run = (over = {}, input = {}, deps = {}) =>
  runPreflight(
    { workspaceId: WS, ...input },
    {
      nodeVersion: '24.21.0',
      azAccount: () => ACCOUNT,
      npmVersion: () => ({ ok: true, version: '10.9.0' }),
      readRegistry: () => undefined,
      readManifest: () => ({ workspaces: {} }),
      client: fakeClient(over),
      ...deps,
    },
  );
const status = (results, id) => results.find((r) => r.id === id)?.status;

test('a healthy empty workspace passes every check', async () => {
  const results = await run();
  assert.ok(!hasFailures(results));
  for (const id of ['node', 'npm', 'az', 'workspace-id', 'workspace', 'capacity', 'role', 'fabric-admin', 'contents', 'admins']) assert.equal(status(results, id), 'pass', id);
  assert.equal(status(results, 'aoai'), 'skip');
});

test('a paused capacity fails', async () => {
  const results = await run({ getCapacity: async () => ({ capacity: { displayName: 'cap', sku: 'F64', state: 'Paused' } }) });
  assert.equal(status(results, 'capacity'), 'fail');
  assert.ok(hasFailures(results));
});

test('a workspace without capacity fails', async () => {
  const results = await run({ getWorkspace: async () => ({ status: 200, json: { displayName: 'Demo WS' } }) });
  assert.equal(status(results, 'capacity'), 'fail');
});

test('an unreadable capacity only warns', async () => {
  const results = await run({ getCapacity: async () => ({ capacity: undefined }) });
  assert.equal(status(results, 'capacity'), 'warn');
  assert.ok(!hasFailures(results));
});

test('a Viewer role fails, a Contributor role warns', async () => {
  const as = (role) => ({ getRoleAssignments: async () => ({ status: 200, json: { value: [{ role, principal: { id: ME, type: 'User' } }] } }) });
  assert.equal(status(await run(as('Viewer')), 'role'), 'fail');
  assert.equal(status(await run(as('Contributor')), 'role'), 'warn');
  assert.equal(status(await run(as('Member')), 'role'), 'pass');
});

test('role assignments that cannot be read only warn', async () => {
  const results = await run({ getRoleAssignments: async () => ({ status: 403, json: undefined }) });
  assert.equal(status(results, 'role'), 'warn');
});

test('a missing workspace fails and skips the dependent checks', async () => {
  const results = await run({ getWorkspace: async () => ({ status: 404, json: undefined }) });
  assert.equal(status(results, 'workspace'), 'fail');
  for (const id of ['capacity', 'role', 'fabric-admin', 'contents']) assert.equal(status(results, id), 'skip', id);
});

test('no Azure CLI sign-in fails and skips every remote check', async () => {
  const results = await run({}, {}, { azAccount: () => ({ ok: false, detail: 'Run: az login' }) });
  assert.equal(status(results, 'az'), 'fail');
  assert.equal(status(results, 'workspace'), 'skip');
  assert.ok(hasFailures(results));
});

test('a bad workspace id fails without calling Fabric', async () => {
  let called = false;
  const results = await run({ getWorkspace: async () => ((called = true), { status: 200, json: {} }) }, { workspaceId: 'nope' });
  assert.equal(status(results, 'workspace-id'), 'fail');
  assert.equal(called, false);
});

test('an unsupported Node version fails, Node 20 only warns', async () => {
  assert.equal(status(await run({}, {}, { nodeVersion: '18.19.0' }), 'node'), 'fail');
  const node20 = await run({}, {}, { nodeVersion: '20.18.0' });
  assert.equal(status(node20, 'node'), 'warn');
  assert.match(node20.find((r) => r.id === 'node').detail, /end of life/i);
  assert.ok(!hasFailures(node20));
});

test('a missing npm fails', async () => {
  const results = await run({}, {}, { npmVersion: () => ({ ok: false }) });
  assert.equal(status(results, 'npm'), 'fail');
  assert.ok(hasFailures(results));
});

const marked = (type, displayName, id) => ({ id, type, displayName, description: managedDescription('1.0.0') });

test('a non-admin only warns, and an installed workspace is recognised', async () => {
  const items = [marked('AppBackend', 'Fabric Weave', '1'), marked('Lakehouse', 'AIReadiness_LH', '2')];
  const results = await run({ probeFabricAdmin: async () => ({ status: 403 }), listItems: async () => items });
  assert.equal(status(results, 'fabric-admin'), 'warn');
  assert.match(results.find((r) => r.id === 'contents').detail, /already installed/);
  assert.ok(!hasFailures(results));
});

test('app-only changes the wording of the Fabric administrator check, not its result', async () => {
  const full = await run({ probeFabricAdmin: async () => ({ status: 403 }) });
  const appOnly = await run({ probeFabricAdmin: async () => ({ status: 403 }) }, { appOnly: true });
  assert.equal(status(appOnly, 'fabric-admin'), 'warn');
  assert.match(full.find((r) => r.id === 'fabric-admin').detail, /pipeline owner/);
  const text = appOnly.find((r) => r.id === 'fabric-admin').detail;
  assert.match(text, /app owner/);
  assert.doesNotMatch(text, /pipeline/);
  assert.equal(status(await run({}, { appOnly: true }), 'fabric-admin'), 'pass');
});

test('items with a Fabric Weave name that Fabric Weave did not create produce a warning, read-only', async () => {
  const items = [
    { id: '10', type: 'Notebook', displayName: 'NB_01_Scan_Inventory', description: 'my own notebook' },
    { id: '11', type: 'Lakehouse', displayName: 'AIReadiness_LH' },
  ];
  const results = await run({ listItems: async () => items });
  const contents = results.find((r) => r.id === 'contents');
  assert.equal(contents.status, 'warn');
  assert.match(contents.detail, /Not managed by Fabric Weave/);
  assert.match(contents.detail, /--adopt/);
  assert.ok(!hasFailures(results));
});

test('unmarked items that are recorded in the local manifest count as installed', async () => {
  const items = [{ id: 'ABC', type: 'Notebook', displayName: 'NB_01_Scan_Inventory' }];
  const manifest = { workspaces: { [WS]: { items: { abc: { type: 'Notebook' } } } } };
  const results = await run({ listItems: async () => items }, {}, { readManifest: () => manifest });
  assert.equal(status(results, 'contents'), 'pass');
});

test('an install from before item stamping, known to this machine, is reported as updatable, not as foreign', async () => {
  const items = [{ id: '10', type: 'Notebook', displayName: 'NB_01_Scan_Inventory' }];
  const registry = { deployments: { x: { fabricWorkspaceId: WS, itemName: 'Fabric Weave', fabricItemId: 'app-1' } } };
  const results = await run({ listItems: async () => items }, {}, { readRegistry: () => registry });
  const contents = results.find((r) => r.id === 'contents');
  assert.equal(contents.status, 'pass');
  assert.match(contents.detail, /predate item stamping/);
});

test('--admins is validated; the default is the signed-in person; a service principal needs --admins', async () => {
  assert.match((await run()).find((r) => r.id === 'admins').detail, /me@contoso\.com/);
  const given = await run({}, { admins: 'A@contoso.com, b@contoso.com' });
  assert.equal(status(given, 'admins'), 'pass');
  assert.match(given.find((r) => r.id === 'admins').detail, /a@contoso\.com, b@contoso\.com/);
  const bad = await run({}, { admins: 'nope' });
  assert.equal(status(bad, 'admins'), 'fail');
  assert.ok(hasFailures(bad));
  const sp = await run({}, {}, { azAccount: () => ({ ...ACCOUNT, user: '11111111-1111-1111-1111-111111111111', type: 'servicePrincipal' }) });
  assert.equal(status(sp, 'admins'), 'warn');
  assert.equal(status(await run({}, { admins: 'a@contoso.com' }, { azAccount: () => ({ ok: false, detail: 'az login' }) }), 'admins'), 'pass');
});

test('the recorded deployment is reported and reused', async () => {
  const registry = { deployments: { x: { fabricWorkspaceId: WS, itemName: 'ai-readiness-cockpit', hostingUrl: 'https://h.example' } } };
  const results = await run({}, {}, { readRegistry: () => registry });
  assert.match(results.find((r) => r.id === 'deployment').detail, /Found "ai-readiness-cockpit".*keeps that name/);
});

test('an invalid Azure OpenAI endpoint fails, a valid one passes', async () => {
  assert.equal(status(await run({}, { aoaiEndpoint: 'https://api.openai.com' }), 'aoai'), 'fail');
  assert.equal(status(await run({}, { aoaiEndpoint: 'https://r.openai.azure.com' }), 'aoai'), 'pass');
});

test('formatResults renders one aligned line per check', async () => {
  const results = await run();
  const lines = formatResults(results).split('\n');
  assert.equal(lines.length, results.length);
  assert.ok(lines.every((l) => /^ {2}\[(?: ok |warn|FAIL|skip)\] /.test(l)));
});

test('FabricClient retries throttling and treats 404 on delete as already gone', async () => {
  const calls = [];
  const replies = [{ status: 429, body: '{}' }, { status: 200, body: '{"displayName":"ok"}' }];
  const client = new FabricClient({
    tokenFn: () => jwt,
    sleepFn: async () => {},
    fetchFn: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const r = replies.shift() ?? { status: 404, body: '{}' };
      return new Response(r.body, { status: r.status, headers: { 'retry-after': '0' } });
    },
  });
  const ws = await client.getWorkspace(WS);
  assert.equal(ws.status, 200);
  assert.equal(calls.length, 2);
  const del = await client.deleteItem(WS, 'item-1');
  assert.ok(del.ok);
  assert.equal(del.status, 404);
  assert.match(calls.at(-1), /^DELETE .*\/v1\/workspaces\/00000000-0000-0000-0000-000000000000\/items\/item-1$/);
});

test('FabricClient re-acquires its token once it is old, and gives every request a timeout', async () => {
  let tokens = 0;
  const seen = [];
  let now = Date.parse('2030-01-01T00:00:00Z');
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const client = new FabricClient({
      tokenFn: () => `h.${Buffer.from(JSON.stringify({ n: ++tokens })).toString('base64url')}.s`,
      sleepFn: async () => {},
      fetchFn: async (url, init) => {
        seen.push(init?.signal instanceof AbortSignal);
        return new Response('{}', { status: 200 });
      },
    });
    await client.getWorkspace(WS);
    await client.getWorkspace(WS);
    assert.equal(tokens, 1, 'a fresh token is reused');
    now += 11 * 60 * 1000;
    await client.getWorkspace(WS);
    assert.equal(tokens, 2, 'a token older than ten minutes is replaced');
    assert.deepEqual(seen, [true, true, true]);
  } finally {
    Date.now = realNow;
  }
});

test('FabricClient.setDescription never throws', async () => {
  const bad = new FabricClient({ tokenFn: () => jwt, sleepFn: async () => {}, fetchFn: async () => { throw new Error('offline'); } });
  assert.deepEqual(await bad.setDescription(WS, 'i', 'x'), { ok: false, status: 0, detail: 'offline' });
  let sent;
  const good = new FabricClient({ tokenFn: () => jwt, fetchFn: async (url, init) => ((sent = { url, init }), new Response('{}', { status: 200 })) });
  assert.ok((await good.setDescription(WS, 'i', 'Fabric Weave v1.0.0 (managed)')).ok);
  assert.equal(sent.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(sent.init.body), { description: 'Fabric Weave v1.0.0 (managed)' });
});

const stamped = (type, displayName, id) => ({ id, type, displayName, description: managedDescription('1.0.0') });

test('teardown plan keeps the lakehouse on request and removes it otherwise', () => {
  const items = [
    stamped('AppBackend', 'Fabric Weave', 'a'),
    stamped('Lakehouse', 'AIReadiness_LH', 'l'),
    { id: 'le', type: 'SQLEndpoint', displayName: 'AIReadiness_LH' },
    stamped('DataPipeline', 'PL_AI_Readiness_Refresh', 'p'),
    { id: 'm', type: 'SemanticModel', displayName: 'Finance' },
  ];
  const full = planTeardown(items);
  assert.ok(full.remove.some((i) => i.type === 'Lakehouse'));
  const kept = planTeardown(items, { keepLakehouse: true });
  assert.ok(!kept.remove.some((i) => i.type === 'Lakehouse' || i.type === 'SQLEndpoint'));
  assert.ok(kept.keep.some((i) => i.type === 'Lakehouse'));
  assert.ok(kept.remove.some((i) => i.type === 'AppBackend'));
  assert.ok(kept.remove.some((i) => i.type === 'DataPipeline'));
});

test('teardown removes only items that are marked or in the manifest; --include-unmarked widens it; nothing else does', () => {
  const items = [
    stamped('Notebook', 'NB_01_Scan_Inventory', 'n1'),
    { id: 'n2', type: 'Notebook', displayName: 'NB_02_Usage', description: 'somebody else' },
    { id: 'n3', type: 'Notebook', displayName: 'NB_03_Quick_Score' },
  ];
  const plan = planTeardown(items, { manifestIds: ['N3'] });
  assert.deepEqual(plan.remove.map((i) => i.id).sort(), ['n1', 'n3']);
  assert.deepEqual(plan.unmanaged.map((i) => i.id), ['n2']);
  assert.ok(plan.keep.some((i) => i.id === 'n2'));

  const widened = planTeardown(items, { includeUnmarked: true });
  assert.deepEqual(widened.remove.map((i) => i.id).sort(), ['n1', 'n2', 'n3']);
  assert.deepEqual(widened.remove.filter((i) => i.unmarked).map((i) => i.id).sort(), ['n2', 'n3']);
  assert.deepEqual(widened.unmanaged, []);
});

test('teardown keeps an unstamped install and says so; it is not removable by default', () => {
  const items = [
    { id: 'a', type: 'AppBackend', displayName: 'Fabric Weave' },
    { id: 'd', type: 'SQLDatabase', displayName: 'Fabric Weave' },
    { id: 'l', type: 'Lakehouse', displayName: 'AIReadiness_LH' },
  ];
  const plan = planTeardown(items);
  assert.equal(plan.remove.length, 0);
  assert.equal(plan.unmanaged.length, 3);
  assert.equal(planTeardown(items, { appItemId: 'a' }).remove.length, 2, 'the app recorded by Rayfin is ours, with its database');
});
