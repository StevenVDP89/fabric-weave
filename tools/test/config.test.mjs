import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_KEYS,
  ZERO_GUID,
  buildResult,
  checkTenant,
  configToFlags,
  loadConfigFile,
  mergeFlags,
  parseConfig,
  resolveWorkspace,
} from '../lib/config.mjs';
import { FabricClient } from '../lib/fabric.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CAPACITY = '22222222-2222-4222-8222-222222222222';
const WS_A = '33333333-3333-4333-8333-333333333333';
const WS_B = '44444444-4444-4444-8444-444444444444';
const jwt = `h.${Buffer.from(JSON.stringify({ n: 1 })).toString('base64url')}.s`;

function scratch() {
  return mkdtempSync(join(tmpdir(), 'fw-config-'));
}
function exampleWithoutPlaceholders() {
  const doc = JSON.parse(readFileSync(join(root, 'deployment', 'customer.config.example.json'), 'utf8'));
  doc.tenantId = TENANT;
  doc.capacityId = CAPACITY;
  return doc;
}

// --- parsing ---------------------------------------------------------------------------------------------------------

test('the shipped example keeps its placeholders out of an install until they are replaced', () => {
  const bare = parseConfig(JSON.parse(readFileSync(join(root, 'deployment', 'customer.config.example.json'), 'utf8')));
  assert.equal(bare.ok, false);
  assert.ok(bare.errors.some((e) => e.includes('"tenantId"') && e.includes('placeholder')));
  assert.ok(bare.errors.some((e) => e.includes('"capacityId"') && e.includes('placeholder')));

  const filled = parseConfig(exampleWithoutPlaceholders());
  assert.deepEqual(filled.errors, []);
  assert.equal(filled.values.tenantId, TENANT);
  assert.equal(filled.values.workspaceName, 'Fabric Weave');
  assert.equal(filled.values.workspaceId, undefined, 'the all-zero workspace id means not set');
  assert.equal(filled.values.aoaiEndpoint, undefined, 'an empty string means not set');
  assert.equal(filled.values.appOnly, true);
});

test('the example, the parser and the deployment guide list the same settings', () => {
  const example = JSON.parse(readFileSync(join(root, 'deployment', 'customer.config.example.json'), 'utf8'));
  const inExample = Object.keys(example).filter((k) => !k.startsWith('_'));
  assert.deepEqual([...inExample].sort(), [...CONFIG_KEYS].sort());
  const guide = readFileSync(join(root, 'docs', 'DEPLOYMENT-GUIDE.md'), 'utf8');
  for (const key of CONFIG_KEYS) assert.ok(guide.includes(`\`${key}\``), `docs/DEPLOYMENT-GUIDE.md does not describe ${key}`);
});

test('parseConfig rejects unknown settings, wrong types and malformed GUIDs, and ignores comment keys', () => {
  const r = parseConfig({ _note: 'x', tenantId: 'not-a-guid', workspaceName: 5, appOnly: 'yes', adminz: [], admins: [1] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown setting "adminz"')));
  assert.ok(r.errors.some((e) => e.includes('"tenantId" must be a GUID')));
  assert.ok(r.errors.some((e) => e.includes('"workspaceName" must be a string')));
  assert.ok(r.errors.some((e) => e.includes('"appOnly" must be true or false')));
  assert.ok(r.errors.some((e) => e.includes('"admins" must be a list of strings')));
  assert.ok(!r.errors.some((e) => e.includes('_note')));
  assert.equal(parseConfig([]).ok, false);
  assert.equal(parseConfig(null).ok, false);
});

test('parseConfig catches placeholders in lists too, and normalises GUIDs and admins', () => {
  const bad = parseConfig({ workspaceName: 'x', admins: ['<someone@contoso.com>'] });
  assert.ok(bad.errors.some((e) => e.includes('"admins" still contains an example placeholder')));
  const ok = parseConfig({ workspaceId: WS_A.toUpperCase(), admins: ' a@contoso.com, b@contoso.com ;' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.workspaceId, WS_A);
  assert.deepEqual(ok.values.admins, ['a@contoso.com', 'b@contoso.com']);
  assert.equal(parseConfig({ workspaceId: ZERO_GUID }).values.workspaceId, undefined);
});

test('an app-only install cannot also ask for a pipeline run', () => {
  const r = parseConfig({ workspaceName: 'x', appOnly: true, runPipeline: true });
  assert.ok(r.errors.some((e) => e.includes('"appOnly"') && e.includes('"runPipeline"')));
  assert.equal(parseConfig({ workspaceName: 'x', appOnly: true, runPipeline: false }).ok, true);
  assert.equal(parseConfig({ workspaceName: 'x', appOnly: false, runPipeline: true }).ok, true);
});

// --- file loading ----------------------------------------------------------------------------------------------------

test('loadConfigFile explains a missing file, bad JSON and a missing workspace, and reads a UTF-8 BOM', () => {
  const dir = scratch();
  try {
    const missing = loadConfigFile(join(dir, 'nope.json'));
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /does not exist.*customer\.config\.example\.json/);

    writeFileSync(join(dir, 'bad.json'), '{ not json');
    assert.match(loadConfigFile(join(dir, 'bad.json')).errors[0], /not valid JSON/);

    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ tenantId: TENANT, workspaceId: ZERO_GUID, workspaceName: '' }));
    assert.match(loadConfigFile(join(dir, 'empty.json')).errors[0], /"workspaceId".*"workspaceName"/);

    writeFileSync(join(dir, 'ok.json'), `\uFEFF${JSON.stringify({ tenantId: TENANT, workspaceName: 'Weave', capacityId: CAPACITY, appOnly: true, runPipeline: false })}`);
    const ok = loadConfigFile(join(dir, 'ok.json'));
    assert.equal(ok.ok, true);
    assert.equal(ok.tenantId, TENANT);
    assert.deepEqual(ok.workspace, { id: undefined, name: 'Weave', capacityId: CAPACITY });
    assert.deepEqual(ok.flags, { 'app-only': true, 'no-run-pipeline': true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configToFlags maps every setting to an installer flag', () => {
  const flags = configToFlags({
    workspaceId: WS_A,
    aoaiEndpoint: 'https://x.openai.azure.com',
    aoaiDeployment: 'gpt-4o',
    aoaiApiVersion: '2025-04-01-preview',
    admins: ['a@x.com', 'b@x.com'],
    appOnly: false,
    runPipeline: true,
    adopt: true,
    optOutTelemetry: true,
  });
  assert.deepEqual(flags, {
    workspace: WS_A,
    'aoai-endpoint': 'https://x.openai.azure.com',
    'aoai-deployment': 'gpt-4o',
    'aoai-api-version': '2025-04-01-preview',
    admins: 'a@x.com,b@x.com',
    'run-pipeline': true,
    adopt: true,
    'opt-out-telemetry': true,
  });
  assert.deepEqual(configToFlags({}), {});
});

test('command-line flags win over the file, including the pipeline flags', () => {
  assert.deepEqual(mergeFlags({ workspace: WS_A, 'aoai-deployment': 'gpt-4.1' }, { workspace: WS_B }), { workspace: WS_B, 'aoai-deployment': 'gpt-4.1' });
  assert.deepEqual(mergeFlags({ 'no-run-pipeline': true }, { 'run-pipeline': true }), { 'run-pipeline': true });
  assert.deepEqual(mergeFlags({ 'run-pipeline': true }, { 'skip-pipeline-run': true }), { 'skip-pipeline-run': true });
  assert.deepEqual(mergeFlags({ 'app-only': true }, {}), { 'app-only': true });
});

// --- tenant ----------------------------------------------------------------------------------------------------------

test('checkTenant stops an install that would go to another tenant, and never blocks when it cannot tell', () => {
  assert.equal(checkTenant(TENANT, { ok: true, tenant: TENANT.toUpperCase() }).ok, true);
  const wrong = checkTenant(TENANT, { ok: true, tenant: '99999999-9999-4999-8999-999999999999' });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.error.includes(`az login --tenant ${TENANT}`));
  assert.equal(checkTenant(undefined, { ok: true, tenant: 'x' }).ok, true);
  assert.equal(checkTenant(TENANT, { ok: false }).ok, true, 'a missing sign-in is reported by the preflight');
});

// --- workspace -------------------------------------------------------------------------------------------------------

function fakeClient({ workspaces = [], create = { ok: true, status: 201, id: WS_A }, listError } = {}) {
  const calls = { list: 0, create: [] };
  return {
    calls,
    async listWorkspaces() {
      calls.list += 1;
      if (listError) throw new Error(listError);
      return workspaces;
    },
    async createWorkspace(name, capacityId) {
      calls.create.push({ name, capacityId });
      return create;
    },
  };
}

test('resolveWorkspace: an id is used as is, without asking Fabric', async () => {
  const client = fakeClient();
  assert.deepEqual(await resolveWorkspace(client, { id: WS_A, name: 'x' }), { ok: true, id: WS_A, created: false, how: 'workspaceId' });
  assert.equal(client.calls.list, 0);
});

test('resolveWorkspace: finds a workspace by name, ignoring case', async () => {
  const client = fakeClient({ workspaces: [{ id: WS_B, displayName: 'Other' }, { id: WS_A, displayName: 'Fabric WEAVE' }] });
  const r = await resolveWorkspace(client, { name: 'fabric weave', capacityId: CAPACITY });
  assert.deepEqual(r, { ok: true, id: WS_A, created: false, how: 'workspaceName' });
  assert.equal(client.calls.create.length, 0);
});

test('resolveWorkspace: two workspaces with the name stop the install and list the ids', async () => {
  const client = fakeClient({ workspaces: [{ id: WS_A, displayName: 'W' }, { id: WS_B, displayName: 'w' }] });
  const r = await resolveWorkspace(client, { name: 'W' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(WS_A) && r.error.includes(WS_B));
  assert.match(r.error, /workspaceId/);
});

test('resolveWorkspace: creates the workspace on the capacity when none has the name', async () => {
  const client = fakeClient({ workspaces: [{ id: WS_B, displayName: 'Other' }] });
  const r = await resolveWorkspace(client, { name: 'Fabric Weave', capacityId: CAPACITY });
  assert.deepEqual(r, { ok: true, id: WS_A, created: true, how: 'created' });
  assert.deepEqual(client.calls.create, [{ name: 'Fabric Weave', capacityId: CAPACITY }]);
});

test('resolveWorkspace: a dry run never creates anything', async () => {
  const client = fakeClient();
  const r = await resolveWorkspace(client, { name: 'Fabric Weave', capacityId: CAPACITY }, { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.wouldCreate, true);
  assert.equal(client.calls.create.length, 0);
});

test('resolveWorkspace: no capacity means no create, and failures say why', async () => {
  const noCapacity = await resolveWorkspace(fakeClient(), { name: 'Fabric Weave' });
  assert.equal(noCapacity.ok, false);
  assert.match(noCapacity.error, /capacityId/);

  const denied = await resolveWorkspace(fakeClient({ create: { ok: false, status: 403, detail: 'no permission' } }), { name: 'Fabric Weave', capacityId: CAPACITY });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /HTTP 403.*no permission/);

  const noId = await resolveWorkspace(fakeClient({ create: { ok: true, status: 201 } }), { name: 'Fabric Weave', capacityId: CAPACITY });
  assert.equal(noId.ok, false, 'a create that returns no id is not trusted');

  const listFails = await resolveWorkspace(fakeClient({ listError: 'HTTP 401' }), { name: 'Fabric Weave', capacityId: CAPACITY });
  assert.equal(listFails.ok, false);
  assert.match(listFails.error, /could not list.*HTTP 401/);

  assert.equal((await resolveWorkspace(fakeClient(), {})).ok, false);
});

test('FabricClient lists workspaces across pages and creates one without retrying', async () => {
  const seen = [];
  const pages = [
    { status: 200, body: { value: [{ id: WS_A, displayName: 'A' }], continuationUri: 'https://api.fabric.microsoft.com/v1/workspaces?continuationToken=t' } },
    { status: 200, body: { value: [{ id: WS_B, displayName: 'B' }] } },
  ];
  const lister = new FabricClient({
    tokenFn: () => jwt,
    fetchFn: async (url) => {
      seen.push(url);
      const page = pages.shift();
      return new Response(JSON.stringify(page.body), { status: page.status });
    },
  });
  assert.deepEqual((await lister.listWorkspaces()).map((w) => w.id), [WS_A, WS_B]);
  assert.equal(seen.length, 2);

  const failing = new FabricClient({ tokenFn: () => jwt, fetchFn: async () => new Response('{"message":"no"}', { status: 401 }) });
  await assert.rejects(() => failing.listWorkspaces(), /HTTP 401/);

  const sent = [];
  const throttled = new FabricClient({
    tokenFn: () => jwt,
    sleepFn: async () => {},
    fetchFn: async (url, init) => {
      sent.push({ url, method: init.method, body: JSON.parse(init.body) });
      return new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '0' } });
    },
  });
  const made = await throttled.createWorkspace('Fabric Weave', CAPACITY);
  assert.equal(made.ok, false);
  assert.equal(made.status, 429);
  assert.equal(sent.length, 1, 'a POST is never retried, it could create the workspace twice');
  assert.deepEqual(sent[0].body, { displayName: 'Fabric Weave', capacityId: CAPACITY });
  assert.equal(sent[0].method, 'POST');

  const ok = new FabricClient({ tokenFn: () => jwt, fetchFn: async () => new Response(JSON.stringify({ id: WS_A }), { status: 201 }) });
  assert.deepEqual(await ok.createWorkspace('Fabric Weave', CAPACITY), { ok: true, status: 201, id: WS_A, detail: JSON.stringify({ id: WS_A }) });
});

// --- result file -----------------------------------------------------------------------------------------------------

test('buildResult holds ids and URLs and no secrets, and has no estate scan for an app-only install', () => {
  const now = new Date('2030-01-02T03:04:05Z');
  const full = buildResult({
    version: '1.0.0',
    mode: 'full',
    tenantId: TENANT,
    workspaceId: WS_A,
    workspaceCreated: true,
    appUrl: 'https://x.webapp.fabricapps.net',
    appItem: { fabricItemId: 'item-1', itemName: 'Fabric Weave' },
    lakehouseId: WS_B,
    admins: ['a@x.com'],
    aoaiEndpoint: 'https://x.openai.azure.com',
    aoaiDeployment: 'gpt-4.1',
    now,
  });
  assert.equal(full.installedAt, '2030-01-02T03:04:05.000Z');
  assert.deepEqual(full.workspace, { id: WS_A, url: `https://app.fabric.microsoft.com/groups/${WS_A}`, created: true });
  assert.deepEqual(full.app, { url: 'https://x.webapp.fabricapps.net', itemId: 'item-1', itemName: 'Fabric Weave' });
  assert.deepEqual(full.estateScan, { lakehouseId: WS_B });
  assert.deepEqual(full.aiModel, { endpoint: 'https://x.openai.azure.com', deployment: 'gpt-4.1' });
  assert.doesNotMatch(JSON.stringify(full), /secret|token|signing/i);

  const appOnly = buildResult({ version: '1.0.0', mode: 'app-only', workspaceId: WS_A, now });
  assert.equal(appOnly.estateScan, null);
  assert.equal(appOnly.aiModel, null);
  assert.equal(appOnly.appAdmins, null);
  assert.equal(appOnly.app.url, null);
  assert.equal(appOnly.tenantId, null);
});

// --- the installer and the scripts -----------------------------------------------------------------------------------

function install(args) {
  return spawnSync(process.execPath, [join(root, 'install.mjs'), ...args], { encoding: 'utf8', cwd: root, timeout: 30000 });
}

test('install.mjs --config stops before touching anything when the file is unusable', () => {
  const dir = scratch();
  try {
    const example = install(['--config', join(root, 'deployment', 'customer.config.example.json')]);
    assert.equal(example.status, 1);
    assert.match(example.stderr, /has problems/);
    assert.match(example.stderr, /tenantId/);

    const missing = install(['--config', join(dir, 'nope.json')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /does not exist/);

    writeFileSync(join(dir, 'clash.json'), JSON.stringify({ workspaceName: 'x', appOnly: true, runPipeline: true }));
    const clash = install(['--config', join(dir, 'clash.json')]);
    assert.equal(clash.status, 1);
    assert.match(clash.stderr, /runPipeline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install.mjs documents --config and --result', () => {
  const help = install(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--config <file>/);
  assert.match(help.stdout, /--result <file>/);
});

test('the PowerShell scripts stay readable by Windows PowerShell 5.1', () => {
  for (const name of ['Deploy.ps1', 'Build-Package.ps1']) {
    const text = readFileSync(join(root, 'deployment', name), 'utf8');
    // 5.1 reads a file without a byte order mark as ANSI, so anything outside ASCII would be garbled.
    assert.doesNotMatch(text, /[^\x00-\x7F]/, `${name} has non-ASCII characters`);
    const code = text.replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /&&|\|\||\?\?|\?\./, `${name} uses PowerShell 7 only operators`);
    assert.match(text, /\[CmdletBinding\(\)\]/);
  }
});
