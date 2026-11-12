#!/usr/bin/env node
// Preflight check for a Fabric Weave install. Read-only: it never changes anything.
//
//   node tools/preflight.mjs --workspace <workspace-guid> [--aoai-endpoint https://<name>.openai.azure.com]
//                            [--admins a@contoso.com,b@contoso.com] [--json]
//
// Exit code 0 when nothing failed (warnings are fine), 1 when at least one check failed.
// install.mjs runs the same checks before it touches the workspace.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  APP_ITEM_NAME,
  GUID,
  checkAoaiEndpoint,
  checkCapacity,
  checkNodeVersion,
  checkWorkspaceRole,
  defaultAdmins,
  describeWorkspaceContents,
  findDeploymentByWorkspace,
  parseAdmins,
  parseFlags,
  readJwtClaims,
  resolveRoleFromAssignments,
} from './lib/common.mjs';
import { FabricClient, azAccount } from './lib/fabric.mjs';
import { PATHS, manifestIds, readManifest, readRegistry } from './lib/local.mjs';

export const REGISTRY_PATH = PATHS.registry;
export { readRegistry };

export function npmVersion() {
  const res = spawnSync('npm --version', { encoding: 'utf8', shell: true });
  return res.status === 0 && res.stdout.trim() ? { ok: true, version: res.stdout.trim() } : { ok: false };
}

// Every dependency can be replaced, which is how tests run the whole sequence without a tenant.
export async function runPreflight({ workspaceId, aoaiEndpoint = '', admins = '', appOnly = false }, deps = {}) {
  const d = { nodeVersion: process.versions.node, azAccount, npmVersion, client: new FabricClient(), readRegistry, readManifest, ...deps };
  const results = [];
  const add = (id, label, status, detail) => results.push({ id, label, status, detail });
  const fromCheck = (id, label, c) => add(id, label, c.ok ? (c.warn ? 'warn' : 'pass') : 'fail', c.detail);

  fromCheck('node', 'Node.js', checkNodeVersion(d.nodeVersion));

  const npm = d.npmVersion();
  add('npm', 'npm', npm.ok ? 'pass' : 'fail', npm.ok ? `npm ${npm.version}` : 'npm is not available. It ships with Node.js; reinstall Node 20 to 24 and open a new terminal');

  const account = d.azAccount();
  add('az', 'Azure CLI signed in', account.ok ? 'pass' : 'fail', account.detail);

  const validId = GUID.test(workspaceId ?? '');
  add('workspace-id', 'Workspace id', validId ? 'pass' : 'fail', validId ? workspaceId : 'Missing or not a GUID. Pass --workspace <workspace-guid>');

  const skipRemote = (reason) => {
    for (const [id, label] of [
      ['workspace', 'Workspace reachable'],
      ['capacity', 'Capacity'],
      ['role', 'Your workspace role'],
      ['fabric-admin', 'Fabric administrator'],
      ['contents', 'Workspace contents'],
    ]) add(id, label, 'skip', reason);
  };

  const reg = d.readRegistry();
  const deployment = validId ? findDeploymentByWorkspace(reg, workspaceId) : undefined;
  const manifest = d.readManifest();

  if (!account.ok || !validId) {
    skipRemote(!account.ok ? 'Needs a signed-in Azure CLI' : 'Needs a valid workspace id');
  } else {
    await remoteChecks({
      workspaceId,
      client: d.client,
      add,
      fromCheck,
      classify: { appItemId: deployment?.fabricItemId, manifestIds: manifestIds(manifest, workspaceId) },
      legacy: Boolean(deployment),
      appOnly,
    });
  }

  add(
    'deployment',
    'Existing app deployment',
    'pass',
    deployment
      ? `Found "${deployment.itemName}" (${deployment.hostingUrl ?? 'no hosting URL recorded'}). Re-running updates it and keeps that name`
      : `None recorded for this workspace. A new app item named "${APP_ITEM_NAME}" will be created`,
  );

  adminsCheck(add, admins, account);

  const aoai = checkAoaiEndpoint(aoaiEndpoint);
  add('aoai', 'Azure OpenAI endpoint', aoai.skipped ? 'skip' : aoai.ok ? 'pass' : 'fail', aoai.detail);

  return results;
}

// The optional app administrators (the APP_ADMINS secret): they see and change everything. Reported, never changed.
function adminsCheck(add, admins, account) {
  if (admins) {
    const parsed = parseAdmins(admins);
    if (parsed.invalid.length) add('admins', 'App administrators', 'fail', `Not a sign-in name (name@domain) or object id: ${parsed.invalid.join(', ')}`);
    else if (parsed.admins.length === 0) add('admins', 'App administrators', 'fail', '--admins is empty. Pass a comma-separated list such as a@contoso.com,b@contoso.com, or leave it out');
    else add('admins', 'App administrators', 'pass', `${parsed.admins.join(', ')} (from --admins)`);
    return;
  }
  const fallback = defaultAdmins(account);
  if (fallback.ok) add('admins', 'App administrators', 'pass', `${fallback.admins.join(', ')} (the signed-in Azure CLI user, because --admins was not given; the installer also adds your object id). On a re-run the existing APP_ADMINS value is kept`);
  else add('admins', 'App administrators', 'warn', account?.ok ? `${fallback.detail}. A first install needs --admins a@contoso.com,b@contoso.com; a re-run keeps the existing APP_ADMINS value` : 'Needs a signed-in Azure CLI, or pass --admins');
}

async function remoteChecks({ workspaceId, client, add, fromCheck, classify, legacy, appOnly }) {
  let token = '';
  try {
    token = client.token();
  } catch (e) {
    add('workspace', 'Workspace reachable', 'fail', e.message);
    return;
  }

  const ws = await client.getWorkspace(workspaceId);
  if (ws.status !== 200) {
    add('workspace', 'Workspace reachable', 'fail', ws.status === 404 || ws.status === 403 ? 'Not found, or your account has no access to it' : `Fabric answered HTTP ${ws.status}`);
    for (const [id, label] of [['capacity', 'Capacity'], ['role', 'Your workspace role'], ['fabric-admin', 'Fabric administrator'], ['contents', 'Workspace contents']]) add(id, label, 'skip', 'Needs a reachable workspace');
    return;
  }
  add('workspace', 'Workspace reachable', 'pass', ws.json?.displayName ?? workspaceId);

  if (!ws.json?.capacityId) add('capacity', 'Capacity', 'fail', 'The workspace has no capacity. Assign an F2+ (or P1+, or trial) capacity in the workspace settings');
  else {
    const cap = await client.getCapacity(ws.json.capacityId);
    if (cap.capacity) fromCheck('capacity', 'Capacity', checkCapacity(cap.capacity));
    else add('capacity', 'Capacity', 'warn', 'A capacity is assigned, but your account cannot read its size or state. Make sure it is F2+ and running');
  }

  const roles = await client.getRoleAssignments(workspaceId);
  if (roles.status === 200) {
    const { role, viaGroup } = resolveRoleFromAssignments(roles.json?.value, readJwtClaims(token).oid);
    if (role) fromCheck('role', 'Your workspace role', checkWorkspaceRole(role));
    else add('role', 'Your workspace role', 'warn', viaGroup ? 'Your access comes from a group, so the role cannot be read. Admin or Member is needed' : 'No direct role found. Admin or Member is needed');
  } else {
    add('role', 'Your workspace role', 'warn', `Could not read role assignments (HTTP ${roles.status}). Admin or Member is needed to deploy`);
  }

  const admin = await client.probeFabricAdmin();
  add(
    'fabric-admin',
    'Fabric administrator',
    admin.status === 200 ? 'pass' : 'warn',
    admin.status === 200
      ? (appOnly ? 'Can read the admin APIs. If the app owner is also a Fabric admin, every person is checked against their own permissions' : 'The scan can read tenant-wide metadata')
      : (appOnly
        ? 'Not a Fabric admin (or the admin API is blocked). Make the app owner a Fabric administrator, otherwise per-person access cannot be worked out and the Agents tab shows tenant switches as "unknown"'
        : 'Not a Fabric admin (or the admin API is blocked). The scan covers only what the pipeline owner can see and the Agents tab shows tenant switches as "unknown"'),
  );

  try {
    const items = await client.listItems(workspaceId);
    const c = describeWorkspaceContents(items, classify);
    const names = c.unmanaged.map((i) => `${i.type} "${i.displayName}"`).join(', ');
    if (c.unmanaged.length && legacy) {
      add('contents', 'Workspace contents', 'pass', `Fabric Weave is already installed here (${items.length} items). ${c.unmanaged.length} item(s) predate item stamping (${names}); the installer updates and stamps them because this machine has the earlier install on record`);
    } else if (c.unmanaged.length) {
      add('contents', 'Workspace contents', 'warn', `Not managed by Fabric Weave, but named like its items: ${names}. The installer will refuse to overwrite them unless you pass --adopt, and teardown keeps them unless you pass --include-unmarked. Rename them, use another workspace, or pass --adopt if they are yours to overwrite`);
    } else {
      add(
        'contents',
        'Workspace contents',
        'pass',
        c.empty ? 'Empty' : c.installed ? `Fabric Weave is already installed here (${items.length} items). The installer will update it` : `${items.length} existing items. The installer only adds its own`,
      );
    }
  } catch (e) {
    add('contents', 'Workspace contents', 'warn', e.message);
  }
}

const MARK = { pass: '[ ok ]', warn: '[warn]', fail: '[FAIL]', skip: '[skip]' };

export function formatResults(results) {
  const width = Math.max(...results.map((r) => r.label.length));
  return results.map((r) => `  ${MARK[r.status]} ${r.label.padEnd(width)}  ${r.detail}`).join('\n');
}

export const hasFailures = (results) => results.some((r) => r.status === 'fail');

const USAGE = 'Usage: node tools/preflight.mjs --workspace <guid> [--aoai-endpoint <url>] [--admins <a@x.com,b@y.com>] [--app-only] [--json]';

async function main() {
  const { flags, unknown } = parseFlags(process.argv.slice(2), { workspace: 'string', 'aoai-endpoint': 'string', admins: 'string', 'app-only': 'boolean', json: 'boolean' });
  if (unknown.length) {
    console.error(`Unknown or incomplete arguments: ${unknown.join(', ')}\n${USAGE}`);
    process.exit(2);
  }
  const results = await runPreflight({ workspaceId: flags.workspace, aoaiEndpoint: flags['aoai-endpoint']?.replace(/\/+$/, ''), admins: flags.admins, appOnly: Boolean(flags['app-only']) });
  if (flags.json) console.log(JSON.stringify({ ok: !hasFailures(results), results }, null, 2));
  else {
    console.log(`Preflight for Fabric Weave${flags.workspace ? ` (workspace ${flags.workspace})` : ''}\n`);
    console.log(formatResults(results));
    console.log(hasFailures(results) ? '\nFix the failed checks above, then run the installer.' : '\nReady to install.');
  }
  process.exit(hasFailures(results) ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
