#!/usr/bin/env node
// One-command installer for Fabric Weave.
//
//   node install.mjs --workspace <fabric-workspace-id> [--aoai-endpoint https://<name>.openai.azure.com]
//                    [--aoai-deployment gpt-4.1] [--aoai-api-version 2024-10-21] [--admins a@contoso.com,b@contoso.com]
//                    [--skip-backend --lakehouse <lakehouse-id> | --app-only] [--run-pipeline | --no-run-pipeline]
//                    [--adopt] [--reset-schedule] [--rotate-signing-key] [--non-interactive]
//                    [--opt-out-telemetry] [--skip-preflight] [--dry-run]
//   node install.mjs --prepare-only        write app/rayfin/rayfin.yml from rayfin.base.yml and stop
//   node install.mjs --config deployment/customer.config.json   same install, settings read from a file (flags still win);
//                                          deployment\Deploy.ps1 wraps this for Windows (docs/DEPLOYMENT-GUIDE.md)
//   node install.mjs --help
//
// Prerequisites: Node 20-24, `az login` as a Fabric admin or workspace admin, and a Fabric workspace on a
// capacity that supports Rayfin apps (F2+ / P1+).
//
// Re-running is safe, and it is an upgrade: what it keeps and what it overwrites is listed in docs/UPGRADING.md.
//   kept:        the SIGNING_KEY and APP_ADMINS secrets, the nightly schedule, the lakehouse and its data, the app database
//   overwritten: the three notebooks, the pipeline definition (local edits are lost), the app code, the other app secrets
//   skipped:     `npm ci` when node_modules already matches package-lock.json, the first pipeline run when a portfolio exists
// The estate scan (lakehouse, notebooks, pipeline) is optional: --app-only installs just the app (docs/RUNBOOK.md, "Estate scan").
// Check everything first, without changing anything:  node tools/preflight.mjs --workspace <id>
// Remove the install again:                           node tools/teardown.mjs --workspace <id>
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  GUID,
  backendPlan,
  checkAoaiEndpoint,
  classifyItems,
  defaultAdmins,
  describeVersionChange,
  findDeploymentByWorkspace,
  installDecision,
  itemNameArgs,
  managedDescription,
  parseAdmins,
  parseFlags,
  parseSecretNames,
  pickExistingAppName,
} from './tools/lib/common.mjs';
import { FabricClient, azAccount, azObjectId, azToken } from './tools/lib/fabric.mjs';
import { buildResult, checkTenant, loadConfigFile, mergeFlags, resolveWorkspace } from './tools/lib/config.mjs';
import {
  PATHS,
  lockfileHash,
  manifestEntry,
  manifestIds,
  prepareRayfinYml,
  readBaseVersion,
  readLockStamp,
  readManifest,
  readRegistry,
  recordInstall,
  writeLockStamp,
  writeManifest,
} from './tools/lib/local.mjs';
import { formatResults, hasFailures, runPreflight } from './tools/preflight.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const appDir = join(root, 'app');

const SPEC = {
  workspace: 'string',
  config: 'string',
  result: 'string',
  'aoai-endpoint': 'string',
  'aoai-deployment': 'string',
  'aoai-api-version': 'string',
  admins: 'string',
  lakehouse: 'string',
  'skip-backend': 'boolean',
  'app-only': 'boolean',
  'skip-pipeline-run': 'boolean',
  'run-pipeline': 'boolean',
  'no-run-pipeline': 'boolean',
  adopt: 'boolean',
  'reset-schedule': 'boolean',
  'rotate-signing-key': 'boolean',
  'non-interactive': 'boolean',
  'opt-out-telemetry': 'boolean',
  'prepare-only': 'boolean',
  'skip-preflight': 'boolean',
  'dry-run': 'boolean',
  help: 'boolean',
};

const USAGE = `Usage: node install.mjs --workspace <workspace-guid> [options]

  --workspace <guid>         the Fabric workspace to install into (required, except with --prepare-only or a config file that names one)
  --config <file>            read the settings from a JSON file (deployment/customer.config.example.json lists them). Flags on the
                             command line win over the file. The file may name the workspace instead of giving its id: it is then
                             found by name, or created when the file has a capacityId (see docs/DEPLOYMENT-GUIDE.md)
  --result <file>            write a summary of what was installed (ids and URLs, no secrets) to this JSON file
  --aoai-endpoint <url>      Azure OpenAI endpoint (https://<name>.openai.azure.com). Without it, AI drafts and AI review stay off
  --aoai-deployment <name>   Azure OpenAI deployment name (default gpt-4.1). Any chat deployment works, for example gpt-4o,
                             gpt-4.1-mini, o4-mini or a GPT-5 deployment (see docs/RUNBOOK.md, "Choosing the AI model")
  --aoai-api-version <v>     Azure OpenAI API version, for example 2025-04-01-preview (default 2024-10-21). Newer models may need it
  --admins <a@x.com,b@y.com> optional app administrators: sign-in names or Entra object ids (comma separated) of people who see and
                             change everything the app can reach. Everyone else sees and changes only what Fabric lets them
                             (see docs/SECURITY.md). Add each person's object id too: the app's sign-in token has no e-mail.
                             Default: the account signed in to the Azure CLI (name and object id).
                             A re-run keeps the existing APP_ADMINS value unless you pass --admins
  --skip-backend             do not deploy the lakehouse, notebooks and pipeline (needs --lakehouse <lakehouse-guid>)
  --app-only                 install only the app: no lakehouse, notebooks, pipeline or nightly scan. People still inspect, score and fix
                             the models they can reach; you lose the estate-wide Portfolio page and the usage numbers. Run the
                             installer again without --app-only to add the scan later (see docs/RUNBOOK.md, "Estate scan")
  --run-pipeline             run the pipeline once after deploying, even if a portfolio already exists
  --no-run-pipeline          do not run the pipeline (--skip-pipeline-run is the same). Default: run it only when
                             Files/app/portfolio.json does not exist yet
  --adopt                    overwrite items that already have a Fabric Weave name but were not created by Fabric Weave
  --reset-schedule           recreate the nightly schedule even if the pipeline has one (you become its owner)
  --rotate-signing-key       replace the SIGNING_KEY secret (rollback snapshots saved before now can no longer be restored)
  --non-interactive          never prompt; stop with an actionable message instead (also the default when there is no terminal)
  --opt-out-telemetry        set RAYFIN_TELEMETRY_OPTOUT=1 for the Rayfin CLI (see docs/PRIVACY.md)
  --prepare-only             only write app/rayfin/rayfin.yml from app/rayfin/rayfin.base.yml, then stop
  --skip-preflight           skip the preflight checks (not recommended)
  --dry-run                  print the steps without changing anything
  --help                     this text`;

const parsed = parseFlags(process.argv.slice(2), SPEC);
let args = parsed.flags;
const dryRun = Boolean(args['dry-run']);
const step = (msg) => console.log(`\n== ${msg}`);
const info = (msg) => console.log(`   ${msg}`);

function fail(msg) {
  console.error(`\nInstall stopped: ${msg}`);
  process.exit(1);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.unknown.length) fail(`unknown or incomplete arguments: ${parsed.unknown.join(', ')}.\n\n${USAGE}`);
let config;
if (args.config) {
  config = loadConfigFile(args.config);
  if (!config.ok) fail(`the config file ${args.config} has problems:\n  - ${config.errors.join('\n  - ')}`);
  args = mergeFlags(config.flags, args);
}
if (args['run-pipeline'] && (args['no-run-pipeline'] || args['skip-pipeline-run'])) fail('--run-pipeline cannot be combined with --no-run-pipeline / --skip-pipeline-run.');
const plan = backendPlan(args);
if (!plan.ok) fail(plan.error);
const appOnly = plan.mode === 'app-only';

if (args['opt-out-telemetry']) process.env.RAYFIN_TELEMETRY_OPTOUT = '1';

const interactive = !args['non-interactive'] && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function run(cmd, cmdArgs, opts = {}) {
  if (dryRun) {
    info(`[dry-run] ${cmd} ${cmdArgs.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  if (opts.echo !== false) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr && res.status !== 0) process.stderr.write(res.stderr);
  }
  return res;
}

function fabricToken() {
  try {
    return azToken('https://api.fabric.microsoft.com');
  } catch (e) {
    return fail(`${e.message}`);
  }
}

function rayfin(rayfinArgs, opts = {}) {
  const quoted = rayfinArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return run('npx', ['rayfin', ...quoted], { cwd: appDir, env: { ...process.env, RAYFIN_TOKEN: dryRun ? '' : fabricToken() }, ...opts });
}

function setSecret(name, value) {
  if (dryRun) return info(`[dry-run] set secret ${name}`);
  const res = rayfin(['secret', 'set', name, '--stdin'], { input: value, echo: false });
  if (res.status !== 0) fail(`could not set secret ${name}: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  info(`secret ${name} set`);
}

// Writes app/rayfin/rayfin.yml (not tracked) from app/rayfin/rayfin.base.yml (tracked) plus the sign-in URL(s) of the app.
// Sign-in works only for redirect URIs listed in it, and the URL of a brand-new install is not known until the first deployment.
function writeRayfinYml(urls) {
  try {
    const result = prepareRayfinYml({ urls, write: !dryRun });
    const added = result.added.length ? `, added ${result.added.join(', ')} to allowedRedirectUris` : '';
    if (dryRun) info(`[dry-run] would write app/rayfin/rayfin.yml from rayfin.base.yml${added}`);
    else info(result.changed ? `wrote app/rayfin/rayfin.yml from rayfin.base.yml${added}` : 'app/rayfin/rayfin.yml is up to date');
  } catch (e) {
    fail(e.message);
  }
}

// ---------------------------------------------------------------------------

if (args['prepare-only']) {
  step('Prepare app/rayfin/rayfin.yml');
  const known = GUID.test(args.workspace ?? '') ? findDeploymentByWorkspace(readRegistry(), args.workspace) : undefined;
  writeRayfinYml([known?.hostingUrl]);
  info('Commands in app/ (rayfin up, rayfin dev, ...) read this file. rayfin.base.yml stays the file you edit and commit.');
  process.exit(0);
}

if (config?.tenantId) {
  const tenant = checkTenant(config.tenantId, azAccount());
  if (!tenant.ok) fail(tenant.error);
}

let workspaceId = args.workspace ?? '';
let workspaceCreated = false;
if (config && !workspaceId) {
  step('Workspace');
  const found = await resolveWorkspace(new FabricClient(), config.workspace, { dryRun });
  if (!found.ok) fail(found.error);
  if (found.wouldCreate) {
    info(`[dry-run] would create the workspace "${config.workspace.name}" on capacity ${config.workspace.capacityId} and install into it`);
    info('The remaining steps are not shown until the workspace exists. Dry run finished, nothing was changed.');
    process.exit(0);
  }
  workspaceId = found.id;
  workspaceCreated = found.created;
  info(found.created
    ? `created the workspace "${config.workspace.name}" (${workspaceId}) on capacity ${config.workspace.capacityId}`
    : `found the workspace "${config.workspace.name}" (${workspaceId})`);
}
if (!GUID.test(workspaceId)) {
  fail('missing or invalid --workspace <workspace-guid>. Create an empty Fabric workspace on an F2+ capacity first.');
}
const aoaiEndpoint = (args['aoai-endpoint'] ?? '').replace(/\/+$/, '');
const aoaiCheck = checkAoaiEndpoint(aoaiEndpoint);
if (!aoaiCheck.skipped && !aoaiCheck.ok) fail('--aoai-endpoint must look like https://<resource>.openai.azure.com');
const aoaiDeployment = args['aoai-deployment'] ?? 'gpt-4.1';
if (!/^[\w.-]{1,64}$/.test(aoaiDeployment)) fail('--aoai-deployment may only contain letters, digits, dot, dash and underscore.');
const aoaiApiVersion = args['aoai-api-version'];
if (aoaiApiVersion !== undefined && !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(aoaiApiVersion)) {
  fail('--aoai-api-version must look like 2024-10-21 or 2025-04-01-preview.');
}

// App administrators: stop on a malformed list before anything is created.
let explicitAdmins;
if (args.admins !== undefined) {
  const p = parseAdmins(args.admins);
  if (p.invalid.length) fail(`--admins must be sign-in names such as name@contoso.com or Entra object ids, separated by commas. Not valid: ${p.invalid.join(', ')}`);
  if (!p.admins.length) fail('--admins is empty. Pass the sign-in names or object ids of the app administrators, for example --admins a@contoso.com,b@contoso.com, or leave it out to use the Azure CLI account');
  explicitAdmins = p.admins;
}

const recorded = findDeploymentByWorkspace(readRegistry(), workspaceId);

const version = readBaseVersion() ?? 'unknown';
const manifestBefore = readManifest();
const versionChange = describeVersionChange(manifestEntry(manifestBefore, workspaceId)?.version, version, { legacy: Boolean(recorded) });

step(`Fabric Weave v${version}`);
info(versionChange.text);
if (process.env.RAYFIN_TELEMETRY_OPTOUT === '1') {
  info('Rayfin telemetry is off (RAYFIN_TELEMETRY_OPTOUT=1).');
} else {
  info('The Rayfin CLI sends anonymous usage telemetry to Microsoft (command names, version, OS; no workspace data).');
  info('Pass --opt-out-telemetry to turn it off. Details: docs/PRIVACY.md');
}

step('Preflight');
if (args['skip-preflight']) {
  info('skipped (--skip-preflight). Not recommended: it catches a paused capacity, a missing role and more before anything is created');
} else {
  const results = await runPreflight({ workspaceId, aoaiEndpoint, admins: args.admins, appOnly });
  console.log(formatResults(results));
  if (hasFailures(results)) fail('the preflight found problems (see [FAIL] above). Fix them and run the installer again.');
}

// App administrators (the APP_ADMINS secret) see and change everything the app can reach. Everyone else is limited to what
// Fabric lets them (docs/SECURITY.md).
//   --admins given     those people
//   otherwise          the identity signed in to the Azure CLI, when it is a person (sign-in name and object id)
// A first install must know the answer now, so the person who installs it is never locked out. A re-run keeps the secret it
// already has, so it only needs an answer when it has to set the secret.
async function promptAdmins(reason) {
  const hint = 'Pass --admins a@contoso.com,b@contoso.com (the sign-in names or object ids of the app administrators).';
  if (!interactive) fail(`${reason}. ${hint}`);
  console.log(`   ${reason}.`);
  const answer = await ask('   Who are the app administrators? Sign-in names or object ids, comma separated: ');
  const p = parseAdmins(answer);
  if (p.invalid.length || !p.admins.length) fail(`not a list of sign-in names (${p.invalid.join(', ') || 'empty'}). ${hint}`);
  return p.admins;
}

let admins = explicitAdmins ?? [];
let adminsFrom = explicitAdmins ? '--admins' : 'the account signed in to the Azure CLI';
let adminsProblem = '';
if (!explicitAdmins && !dryRun) {
  const account = azAccount();
  const fallback = defaultAdmins(account, account.ok ? azObjectId() : undefined);
  if (fallback.ok) admins = fallback.admins;
  else adminsProblem = fallback.detail;
}
if (!admins.length && !dryRun && !recorded) {
  admins = await promptAdmins(adminsProblem);
  adminsFrom = 'your answer';
}

// Items that already carry a Fabric Weave name but were not created by it are never overwritten by accident.
let adopt = Boolean(args.adopt);
let itemArgs = itemNameArgs(recorded);
let existingItems = [];
if (!dryRun) {
  try {
    existingItems = await new FabricClient().listItems(workspaceId);
  } catch {
    // The preflight already reported anything that is wrong with the workspace, and deploy.mjs checks again.
  }
}
const classified = classifyItems(existingItems, {
  appItemId: recorded?.fabricItemId,
  manifestIds: manifestIds(manifestBefore, workspaceId),
});
const foreign = plan.mode === 'full' ? classified.unmanaged : classified.unmanaged.filter((i) => i.group === 'app');
if (foreign.length && !recorded && !adopt) {
  console.log('\n   These items already exist in the workspace but were not created by Fabric Weave:');
  for (const i of foreign) console.log(`     - ${i.type} "${i.displayName}"`);
  console.log(`   Installing ${appOnly ? 'reuses it' : 'overwrites them (notebooks, pipeline) or reuses them (app)'}.`);
  if (!interactive) fail('stopping so nothing of yours is overwritten. If they are yours to overwrite, re-run with --adopt. Otherwise rename them or use another workspace.');
  if ((await ask('   Overwrite them? [y/N] ')).toLowerCase() !== 'y') fail('nothing was changed. Rename those items or use another workspace, or re-run with --adopt.');
  adopt = true;
}
if (!recorded && (adopt || !foreign.length)) {
  // A workspace that already holds the app (installed from another machine, or under the old name) keeps that
  // item; only a workspace without one gets a new item named "Fabric Weave".
  const existing = pickExistingAppName(existingItems);
  if (existing) {
    itemArgs = ['--item-name', existing];
    info(`the workspace already has the app "${existing}": updating it instead of creating a new one`);
  }
}

let lakehouseId = '';
if (appOnly) {
  step('1/5 Backend: skipped (--app-only)');
  info('no lakehouse, notebooks, pipeline or schedule: the Portfolio page and usage numbers are not part of this install');
} else if (plan.mode === 'existing') {
  lakehouseId = plan.lakehouseId;
} else {
  step('1/5 Backend: lakehouse, notebooks, pipeline, daily schedule');
  const outDir = mkdtempSync(join(tmpdir(), 'fabric-weave-'));
  const outFile = join(outDir, 'backend.json');
  const deployArgs = [join(root, 'backend', 'deploy.mjs'), '--workspace', workspaceId, '--out', outFile, '--version', version];
  if (args['run-pipeline']) deployArgs.push('--run-pipeline');
  if (args['no-run-pipeline'] || args['skip-pipeline-run']) deployArgs.push('--no-run-pipeline');
  if (adopt) deployArgs.push('--adopt');
  if (args['reset-schedule']) deployArgs.push('--reset-schedule');
  const res = run('node', deployArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)));
  if (res.status !== 0) fail('the backend deployment failed. See the output above.');
  if (!dryRun) {
    lakehouseId = JSON.parse(readFileSync(outFile, 'utf8')).lakehouse.id;
    rmSync(outDir, { recursive: true, force: true });
  } else {
    lakehouseId = '00000000-0000-0000-0000-000000000000';
  }
  info(`lakehouse: ${lakehouseId}`);
}

step('2/5 App dependencies');
{
  const lockHash = lockfileHash();
  const decision = installDecision({ hasNodeModules: existsSync(PATHS.nodeModules), lockHash, stampHash: readLockStamp() });
  if (decision.install) {
    info(`npm ci (${decision.reason})`);
    const res = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: appDir });
    if (res.status !== 0) fail('npm ci failed. Close anything that uses app/node_modules (editors, dev servers) and retry. It needs app/package.json and app/package-lock.json to match.');
    if (!dryRun) writeLockStamp(lockHash);
  } else {
    info(`skipping npm ci (${decision.reason})`);
  }
}

// `rayfin up` prints no URL in a non-interactive shell, so the registry it writes is the dependable source.
const hostingUrlOf = (res) => (res.stdout ?? '').match(/Static Hosting URL:\s*(https:\/\/\S+)/)?.[1] ?? findDeploymentByWorkspace(readRegistry(), workspaceId)?.hostingUrl;

step('3/5 First deployment (creates the app item, database and hosting)');
writeRayfinYml([recorded?.hostingUrl]);
const first = rayfin(['up', '--workspace-id', workspaceId, '--yes', ...itemArgs]);
if (first.status !== 0) fail('rayfin up failed. See the output above.');
const hostingUrl = hostingUrlOf(first);

step('4/5 Secrets');
// The list comes first: app-only mode must know whether an earlier full install left a PORTFOLIO_PATH behind, and the
// signing key and admins must not be replaced by accident.
let hasKey = false;
let hasAdmins = false;
let hasPortfolio = false;
if (!dryRun) {
  const listed = rayfin(['--json', 'secret', 'list'], { echo: false });
  // Without the list the installer cannot tell what is already set, and guessing would rotate the key or replace the admins.
  if (listed.status !== 0) fail(`could not list the app secrets: ${(listed.stderr || listed.stdout || '').slice(0, 300)}`);
  const known = parseSecretNames(listed.stdout);
  if (!known.ok) fail(`could not read the list of app secrets from the Rayfin CLI: ${(listed.stderr || listed.stdout || '').slice(0, 300)}`);
  hasKey = known.names.includes('SIGNING_KEY');
  hasAdmins = known.names.includes('APP_ADMINS');
  hasPortfolio = known.names.includes('PORTFOLIO_PATH');
}
if (!appOnly) {
  setSecret('PORTFOLIO_PATH', `${workspaceId}/${lakehouseId}`);
} else if (hasPortfolio) {
  // Secrets cannot be deleted from the CLI; a value that is not a lakehouse path switches the Portfolio page off.
  setSecret('PORTFOLIO_PATH', 'disabled');
  info('an earlier full install left PORTFOLIO_PATH behind: switched off, so the Portfolio page is hidden (its lakehouse, notebooks and pipeline are untouched)');
} else if (dryRun) {
  info('[dry-run] an existing PORTFOLIO_PATH would be switched off');
} else {
  info('PORTFOLIO_PATH is not set (app-only): the Portfolio page stays hidden');
}
if (aoaiEndpoint) {
  setSecret('AOAI_ENDPOINT', aoaiEndpoint);
  setSecret('AOAI_DEPLOYMENT', aoaiDeployment);
} else {
  info('no --aoai-endpoint given: AI drafts and AI review stay off (scoring and rule-based fixes still work)');
}
if (aoaiApiVersion) setSecret('AOAI_API_VERSION', aoaiApiVersion);
if (hasKey && !args['rotate-signing-key']) {
  info('SIGNING_KEY already set, keeping it (existing rollback snapshots stay valid)');
} else {
  if (hasKey) info('rotating SIGNING_KEY: rollback snapshots saved before now can no longer be restored');
  setSecret('SIGNING_KEY', randomBytes(48).toString('hex'));
}
let adminsLine;
if (hasAdmins && !explicitAdmins) {
  info('APP_ADMINS already set, keeping it (pass --admins to change it)');
  adminsLine = 'unchanged (the existing APP_ADMINS value was kept)';
} else {
  if (!admins.length && !dryRun) {
    admins = await promptAdmins(adminsProblem);
    adminsFrom = 'your answer';
  }
  setSecret('APP_ADMINS', admins.join(','));
  adminsLine = admins.length ? admins.join(', ') : 'the account signed in to the Azure CLI (dry run)';
  info(`app administrators (${adminsFrom}): ${adminsLine}`);
  info('Everyone else who signs in sees and changes only what Fabric lets them (their own workspaces and models).');
}

step('5/5 Final deployment (applies secrets and the sign-in redirect for the hosting URL)');
writeRayfinYml([recorded?.hostingUrl, hostingUrl]);
const last = rayfin(['up', '--workspace-id', workspaceId, '--yes']);
if (last.status !== 0) fail('the final rayfin up failed. See the output above.');
const url = hostingUrlOf(last) ?? hostingUrl ?? '(see the Fabric portal)';

if (!dryRun) {
  // Record the app item (the backend items were recorded by deploy.mjs) and mark it, so teardown knows it is ours.
  const app = findDeploymentByWorkspace(readRegistry(), workspaceId);
  const items = app?.fabricItemId ? [{ id: app.fabricItemId, type: 'AppBackend', displayName: app.itemName }] : [];
  writeManifest(recordInstall(readManifest(), workspaceId, { items, version }));
  if (app?.fabricItemId) {
    const stamped = await new FabricClient().setDescription(workspaceId, app.fabricItemId, managedDescription(version, 'Scoring app (Rayfin).'));
    if (!stamped.ok) info(`could not mark the app item as managed (HTTP ${stamped.status}); the local record in app/rayfin/.fabric-weave.json covers it`);
  }
  if (args.result) {
    const summary = buildResult({
      version,
      mode: plan.mode,
      tenantId: config?.tenantId ?? azAccount().tenant,
      workspaceId,
      workspaceCreated,
      appUrl: url.startsWith('http') ? url : undefined,
      appItem: app,
      lakehouseId,
      admins: hasAdmins && !explicitAdmins ? undefined : admins,
      aoaiEndpoint,
      aoaiDeployment,
     });
    mkdirSync(dirname(args.result), { recursive: true });
    writeFileSync(args.result, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    info(`wrote ${args.result}`);
  }
}

console.log(`
============================================================
 ${dryRun ? 'Dry run finished, nothing was changed' : `Fabric Weave v${version} installed`}
   App:        ${url}
   Workspace:  https://app.fabric.microsoft.com/groups/${workspaceId}
   App admins: ${adminsLine}
============================================================

Manual steps that cannot be scripted (see docs/RUNBOOK.md):
  1. Open the app and sign in. The Status page shows "You are signed in as ..." and every check should be green.
     "What you can see and change" shows how your access was worked out. For every person to be checked against their own
     Fabric permissions, make the app owner a Fabric administrator (docs/RUNBOOK.md, "Who can see and change what").
  2. Add the app identity to each workspace you want ${appOnly ? 'it to inspect or change' : 'to scan or change'} (Member or Contributor),
     or use the clone / propose-only write modes for workspaces you do not want it to write to.
  3. If you set --aoai-endpoint: give the app identity the "Cognitive Services OpenAI User" role on that resource.
${appOnly
  ? `  4. App-only install: there is no Portfolio page, no usage numbers and no nightly scan. People see the workspaces and models
     their own Fabric permissions allow, and the app owner must be a Fabric administrator for that check to work.
     To add the estate scan later, run this installer again without --app-only (docs/RUNBOOK.md, "Estate scan").`
  : `  4. Identity model: the notebooks and the nightly pipeline run as the user who created or last saved the schedule
     (normally whoever ran this installer). That user must be a Fabric administrator, or be allowed to use the admin APIs.
     Hand the schedule over before that person leaves (docs/RUNBOOK.md). A service principal can run them instead,
     but that is an advanced option the installer does not set up.`}
  5. Share the app only with people you would trust with the overview it shows (every signed-in user can read the stored
     assessments). What a person can open and change is checked against their own Fabric permissions; the people in
     APP_ADMINS are the exception and can do everything (docs/SECURITY.md).
`);
