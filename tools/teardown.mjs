#!/usr/bin/env node
// Removes Fabric Weave from a workspace: the app (with its database and functions) and, if the estate scan was installed,
// the refresh pipeline, the three notebooks and the AIReadiness_LH lakehouse. Items that are not there are skipped.
// Nothing else is touched. The workspace itself and your
// own semantic models, reports and "(AI-ready)" clones stay.
//
// Only items that Fabric Weave created are removed: items with the "Fabric Weave v<version> (managed)" marker in
// their description, or recorded in the local manifest. An item that merely has a Fabric Weave name is reported as
// "not managed by Fabric Weave" and kept.
//
//   node tools/teardown.mjs --workspace <workspace-guid> [--dry-run] [--yes] [--keep-lakehouse] [--include-unmarked]
//
//   --dry-run          show what would be removed and stop
//   --yes              skip the typed confirmation (for scripts). It does NOT make unmarked items removable
//   --keep-lakehouse   keep the lakehouse (inventory, usage and score history) and only remove the app and the pipeline
//   --include-unmarked also remove items that have a Fabric Weave name but were not created by it
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { GUID, classifyItems, findDeploymentByWorkspace, parseFlags, removeDeploymentByWorkspace } from './lib/common.mjs';
import { FabricClient, azAccount } from './lib/fabric.mjs';
import { PATHS, forgetItems, manifestIds, readManifest, readRegistry, writeManifest } from './lib/local.mjs';

const REGISTRY_PATH = PATHS.registry;

const GROUP_LABEL = {
  app: 'App',
  pipeline: 'Pipeline',
  notebook: 'Notebook',
  'lakehouse-endpoint': 'SQL endpoint',
  lakehouse: 'Lakehouse',
};

export function planTeardown(items, { appItemId, keepLakehouse = false, manifestIds: known = [], includeUnmarked = false } = {}) {
  const plan = classifyItems(items, { appItemId, manifestIds: known, includeUnmarked });
  if (!keepLakehouse) return plan;
  const kept = plan.remove.filter((i) => i.group === 'lakehouse' || i.group === 'lakehouse-endpoint');
  const keptIds = new Set(kept.map((i) => i.id));
  return { remove: plan.remove.filter((i) => !keptIds.has(i.id)), keep: [...plan.keep, ...kept], unmanaged: plan.unmanaged.filter((i) => !keptIds.has(i.id)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USAGE = 'Usage: node tools/teardown.mjs --workspace <workspace-guid> [--dry-run] [--yes] [--keep-lakehouse] [--include-unmarked]';

async function main() {
  const { flags, unknown } = parseFlags(process.argv.slice(2), {
    workspace: 'string',
    'dry-run': 'boolean',
    yes: 'boolean',
    'keep-lakehouse': 'boolean',
    'include-unmarked': 'boolean',
  });
  if (unknown.length) {
    console.error(`Unknown or incomplete arguments: ${unknown.join(', ')}\n${USAGE}`);
    process.exit(2);
  }
  const workspaceId = flags.workspace ?? '';
  if (!GUID.test(workspaceId)) {
    console.error(`Missing or invalid --workspace.\n${USAGE}`);
    process.exit(2);
  }
  const account = azAccount();
  if (!account.ok) {
    console.error(account.detail);
    process.exit(1);
  }

  const client = new FabricClient();
  const ws = await client.getWorkspace(workspaceId);
  if (ws.status !== 200) {
    console.error(`Workspace not found, or your account has no access to it (HTTP ${ws.status}).`);
    process.exit(1);
  }
  const workspaceName = ws.json?.displayName ?? workspaceId;
  const registry = readRegistry();
  const recorded = findDeploymentByWorkspace(registry, workspaceId);
  const manifest = readManifest();
  const items = await client.listItems(workspaceId);
  const plan = planTeardown(items, {
    appItemId: recorded?.fabricItemId,
    keepLakehouse: Boolean(flags['keep-lakehouse']),
    manifestIds: manifestIds(manifest, workspaceId),
    includeUnmarked: Boolean(flags['include-unmarked']),
  });

  console.log(`Fabric Weave teardown for workspace "${workspaceName}" (${workspaceId})\n`);
  if (plan.unmanaged.length) {
    console.log('Not managed by Fabric Weave (named like its items, but not created by the installer). These are kept:');
    for (const i of plan.unmanaged) console.log(`  - ${(GROUP_LABEL[i.group] ?? i.type).padEnd(12)} ${i.displayName}  [${i.type}]`);
    console.log('  If they are from an install made before items were stamped, re-run the installer once to stamp them, or pass --include-unmarked to remove them as well.\n');
  }
  if (plan.remove.length === 0) {
    console.log('No Fabric Weave items found in this workspace. Nothing to do.');
    return;
  }
  const ours = plan.remove.filter((i) => !i.unmarked);
  const unmarked = plan.remove.filter((i) => i.unmarked);
  const line = (i) => `  - ${(GROUP_LABEL[i.group] ?? i.type).padEnd(12)} ${i.displayName}  [${i.type}]${i.cascade ? ' (goes with its parent)' : ''}`;
  if (ours.length) {
    console.log('Will remove:');
    for (const i of ours) console.log(line(i));
  }
  if (unmarked.length) {
    console.log(`${ours.length ? '\n' : ''}Will ALSO remove these, which were NOT created by Fabric Weave (because of --include-unmarked). Check that they are yours:`);
    for (const i of unmarked) console.log(line(i));
  }
  console.log(`\nWill keep: ${plan.keep.length} other item${plan.keep.length === 1 ? '' : 's'} (your semantic models, reports and clones are never touched).`);
  console.log(`
What this means:
  - The app's database goes with it: the audit trail, change sets and rollback snapshots are lost.
    Models you changed in place stay changed and can no longer be rolled back by the app.
  - The app's secrets (signing key, app administrators, Azure OpenAI settings) go with the app item.
  - The workspace and the capacity stay. Pause or delete the capacity separately if you no longer need it.
`);

  if (flags['dry-run']) {
    console.log('Dry run: nothing was removed.');
    return;
  }

  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      console.error('Not an interactive terminal. Re-run with --yes to confirm.');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`Type the workspace name ("${workspaceName}") to confirm: `)).trim();
    rl.close();
    if (typed !== workspaceName) {
      console.error('The name does not match. Nothing was removed.');
      process.exit(1);
    }
  }

  let failed = 0;
  for (const item of plan.remove) {
    if (item.cascade) continue;
    const res = await client.deleteItem(workspaceId, item.id);
    if (res.ok) console.log(`  removed  ${item.displayName} [${item.type}]${res.status === 404 ? ' (already gone)' : ''}`);
    else {
      failed += 1;
      console.error(`  FAILED   ${item.displayName} [${item.type}] HTTP ${res.status}: ${res.detail}`);
    }
  }

  // Deletes are asynchronous on the service side, so give them a moment before checking what is left.
  await sleep(4000);
  const wanted = new Set(plan.remove.map((i) => i.id));
  const left = (await client.listItems(workspaceId)).filter((i) => wanted.has(i.id));
  for (const i of left) console.error(`  STILL THERE  ${i.displayName} [${i.type}]`);

  const appIds = new Set(plan.remove.filter((i) => i.group === 'app' && !i.cascade).map((i) => i.id));
  const appGone = !left.some((i) => appIds.has(i.id));
  if (recorded && appGone && registry && existsSync(REGISTRY_PATH)) {
    const next = removeDeploymentByWorkspace(registry, workspaceId);
    writeFileSync(REGISTRY_PATH, `${JSON.stringify(next.registry, null, 2)}\n`, 'utf8');
    console.log(`\nForgot the local deployment record (${next.removed.join(', ')}) so a fresh install starts clean.`);
  }
  const removedIds = plan.remove.map((i) => i.id).filter((id) => !left.some((i) => i.id === id));
  if (removedIds.length && manifestIds(manifest, workspaceId).length) {
    writeManifest(forgetItems(manifest, workspaceId, removedIds));
  }

  if (failed || left.length) {
    console.error(`\nTeardown incomplete: ${failed} delete${failed === 1 ? '' : 's'} failed, ${left.length} item${left.length === 1 ? '' : 's'} still present. Re-run it, or remove them in the workspace.`);
    process.exit(1);
  }
  console.log('\nDone. Fabric Weave is removed from this workspace.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
