// The deployment config file (deployment/customer.config.json) and the workspace lookup that goes with it.
// Pure functions where possible, so they are unit-tested in tools/test/config.test.mjs. install.mjs --config uses them.
import { existsSync, readFileSync } from 'node:fs';
import { GUID } from './common.mjs';

export const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

// key -> how it is read. Keys that start with "_" are comments and are ignored.
const KEYS = {
  tenantId: 'guid',
  workspaceId: 'guid',
  workspaceName: 'string',
  capacityId: 'guid',
  aoaiEndpoint: 'string',
  aoaiDeployment: 'string',
  aoaiApiVersion: 'string',
  admins: 'list',
  appOnly: 'boolean',
  runPipeline: 'boolean',
  adopt: 'boolean',
  optOutTelemetry: 'boolean',
};

export const CONFIG_KEYS = Object.keys(KEYS);

// A value left as `<YOUR-...>` from the example file.
const isPlaceholder = (v) => typeof v === 'string' && /[<>]/.test(v);

// Turns the parsed JSON into { ok, errors, values }. `values` holds only the keys that have a real value; empty strings,
// the all-zero GUID and null mean "not set".
export function parseConfig(doc) {
  const errors = [];
  const values = {};
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['the config file must contain one JSON object'], values };

  for (const key of Object.keys(doc)) {
    if (key.startsWith('_')) continue;
    if (!(key in KEYS)) errors.push(`unknown setting "${key}". Known settings: ${CONFIG_KEYS.join(', ')}`);
  }

  for (const [key, kind] of Object.entries(KEYS)) {
    let v = doc[key];
    if (v === undefined || v === null) continue;
    if (kind === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`"${key}" must be true or false`);
      else values[key] = v;
      continue;
    }
    if (kind === 'list') {
      const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : null;
      if (!items || items.some((i) => typeof i !== 'string')) {
        errors.push(`"${key}" must be a list of strings, for example ["a@contoso.com", "b@contoso.com"]`);
        continue;
      }
      const cleaned = items.map((i) => i.trim()).filter(Boolean);
      if (cleaned.some(isPlaceholder)) errors.push(`"${key}" still contains an example placeholder (${cleaned.find(isPlaceholder)}). Replace it or remove the setting`);
      else if (cleaned.length) values[key] = cleaned;
      continue;
    }
    if (typeof v !== 'string') {
      errors.push(`"${key}" must be a string`);
      continue;
    }
    v = v.trim();
    if (!v) continue;
    if (isPlaceholder(v)) {
      errors.push(`"${key}" still has the example placeholder ${v}. Replace it, or set it to "" to leave it out`);
      continue;
    }
    if (kind === 'guid') {
      if (!GUID.test(v)) errors.push(`"${key}" must be a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), not "${v}"`);
      else if (v !== ZERO_GUID) values[key] = v.toLowerCase();
      continue;
    }
    values[key] = v;
  }

  if (values.workspaceName && values.workspaceName.length > 256) errors.push('"workspaceName" is longer than 256 characters');
  if (values.appOnly && values.runPipeline === true) errors.push('"appOnly" installs no pipeline, so "runPipeline" cannot be true. Set "appOnly" to false or "runPipeline" to false');
  return { ok: errors.length === 0, errors, values };
}

// Maps the config values to the flags install.mjs understands. Booleans that are false are simply absent, except
// runPipeline, where false means --no-run-pipeline.
export function configToFlags(values) {
  const flags = {};
  if (values.workspaceId) flags.workspace = values.workspaceId;
  if (values.aoaiEndpoint) flags['aoai-endpoint'] = values.aoaiEndpoint;
  if (values.aoaiDeployment) flags['aoai-deployment'] = values.aoaiDeployment;
  if (values.aoaiApiVersion) flags['aoai-api-version'] = values.aoaiApiVersion;
  if (values.admins?.length) flags.admins = values.admins.join(',');
  if (values.appOnly) flags['app-only'] = true;
  if (values.runPipeline === true) flags['run-pipeline'] = true;
  if (values.runPipeline === false) flags['no-run-pipeline'] = true;
  if (values.adopt) flags.adopt = true;
  if (values.optOutTelemetry) flags['opt-out-telemetry'] = true;
  return flags;
}

// Command-line flags win over the config file. A pipeline flag on the command line also cancels the opposite one from the file.
export function mergeFlags(fromConfig, fromCli) {
  const merged = { ...fromConfig, ...fromCli };
  if (fromCli['run-pipeline']) delete merged['no-run-pipeline'];
  if (fromCli['no-run-pipeline'] || fromCli['skip-pipeline-run']) delete merged['run-pipeline'];
  return merged;
}

// Reads and checks a config file. Never throws.
export function loadConfigFile(path) {
  if (!existsSync(path)) {
    return { ok: false, errors: [`${path} does not exist. Copy deployment/customer.config.example.json to deployment/customer.config.json and fill it in`] };
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, errors: [`${path} is not valid JSON (${e.message})`] };
  }
  const parsed = parseConfig(doc);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const { values } = parsed;
  if (!values.workspaceId && !values.workspaceName) {
    return { ok: false, errors: ['set "workspaceId" (an existing workspace) or "workspaceName" (found by name, or created when "capacityId" is set)'] };
  }
  return {
    ok: true,
    values,
    flags: configToFlags(values),
    tenantId: values.tenantId,
    workspace: { id: values.workspaceId, name: values.workspaceName, capacityId: values.capacityId },
  };
}

// The signed-in tenant must be the one the config names; otherwise the install would silently go to another tenant.
export function checkTenant(configTenantId, account) {
  if (!configTenantId) return { ok: true };
  if (!account?.ok) return { ok: true };
  if (String(account.tenant ?? '').toLowerCase() === configTenantId.toLowerCase()) return { ok: true };
  return {
    ok: false,
    error: `the Azure CLI is signed in to tenant ${account.tenant}, but the config file says ${configTenantId}. Run \`az login --tenant ${configTenantId}\` (deployment\\Deploy.ps1 does this for you)`,
  };
}

// Finds the workspace to install into: by id, else by name, else creates it on the given capacity.
// With dryRun nothing is created; the result says wouldCreate instead.
export async function resolveWorkspace(client, { id, name, capacityId }, { dryRun = false } = {}) {
  if (id) return { ok: true, id, created: false, how: 'workspaceId' };
  if (!name) return { ok: false, error: 'neither "workspaceId" nor "workspaceName" is set' };

  let all;
  try {
    all = await client.listWorkspaces();
  } catch (e) {
    return { ok: false, error: `could not list your Fabric workspaces: ${e.message}` };
  }
  const matches = all.filter((w) => String(w.displayName ?? '').toLowerCase() === name.toLowerCase());
  if (matches.length === 1) return { ok: true, id: matches[0].id, created: false, how: 'workspaceName' };
  if (matches.length > 1) {
    return { ok: false, error: `${matches.length} workspaces are called "${name}" (${matches.map((w) => w.id).join(', ')}). Set "workspaceId" to pick one` };
  }
  if (!capacityId) {
    return { ok: false, error: `no workspace called "${name}" was found and "capacityId" is not set, so it cannot be created. Create it in Fabric on an F2+ capacity, or set "capacityId" (or "workspaceId")` };
  }
  if (dryRun) return { ok: true, wouldCreate: true, created: false, how: 'dry-run' };

  const made = await client.createWorkspace(name, capacityId);
  if (!made.ok || !GUID.test(made.id ?? '')) {
    return { ok: false, error: `could not create the workspace "${name}" on capacity ${capacityId} (HTTP ${made.status}): ${made.detail}. A tenant setting may restrict who can create workspaces, or the capacity id is wrong` };
  }
  return { ok: true, id: made.id, created: true, how: 'created' };
}

// The summary file Deploy.ps1 asks for (deployment/last-deployment-result.json). It holds ids and URLs, never secrets.
export function buildResult({ version, mode, tenantId, workspaceId, workspaceCreated, appUrl, appItem, lakehouseId, admins, aoaiEndpoint, aoaiDeployment, now = new Date() }) {
  return {
    product: 'Fabric Weave',
    version,
    installedAt: now.toISOString(),
    mode,
    tenantId: tenantId ?? null,
    workspace: { id: workspaceId, url: `https://app.fabric.microsoft.com/groups/${workspaceId}`, created: Boolean(workspaceCreated) },
    app: { url: appUrl ?? null, itemId: appItem?.fabricItemId ?? null, itemName: appItem?.itemName ?? null },
    estateScan: mode === 'app-only' ? null : { lakehouseId: lakehouseId ?? null },
    appAdmins: admins ?? null,
    aiModel: aoaiEndpoint ? { endpoint: aoaiEndpoint, deployment: aoaiDeployment } : null,
  };
}
