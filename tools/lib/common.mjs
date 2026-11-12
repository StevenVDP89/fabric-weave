// Pure helpers shared by install.mjs, tools/preflight.mjs and tools/teardown.mjs.
// Nothing here touches the network or the file system, so it is unit-tested in tools/test/.

export const APP_ITEM_NAME = 'Fabric Weave';
export const LEGACY_APP_ITEM_NAME = 'ai-readiness-cockpit';
export const LAKEHOUSE_NAME = 'AIReadiness_LH';
export const PIPELINE_NAME = 'PL_AI_Readiness_Refresh';
export const NOTEBOOK_NAMES = ['NB_01_Scan_Inventory', 'NB_02_Usage', 'NB_03_Quick_Score'];

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rayfin supports Node 20 to 24. Node 20 reached end of life in April 2026.
export const NODE_MIN = 20;
export const NODE_MAX = 24;
export const NODE_EOL_MAX = 20;

export function checkNodeVersion(version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major)) return { ok: false, major: NaN, detail: `Cannot read the Node version "${version}"` };
  const ok = major >= NODE_MIN && major <= NODE_MAX;
  if (ok && major <= NODE_EOL_MAX) return { ok, warn: true, major, detail: `Node ${version} still works but Node ${NODE_EOL_MAX} is end of life. Use Node 22 or 24` };
  return {
    ok,
    major,
    detail: ok ? `Node ${version}` : `Node ${version} is not supported, use Node ${NODE_MIN} to ${NODE_MAX}`,
  };
}

// Rayfin keys .deployments.json by workspace name, so find the record by workspace id instead.
export function findDeploymentByWorkspace(registry, workspaceId) {
  if (!registry || typeof registry !== 'object') return undefined;
  const wanted = String(workspaceId).toLowerCase();
  for (const entry of Object.values(registry.deployments ?? registry)) {
    const ws = entry?.fabricWorkspaceId ?? entry?.workspaceId;
    if (typeof ws === 'string' && ws.toLowerCase() === wanted) return entry;
  }
  return undefined;
}

// `rayfin up --item-name` fails when it conflicts with a recorded deployment, so pass it only for fresh workspaces.
export function itemNameArgs(deployment, name = APP_ITEM_NAME) {
  return deployment ? [] : ['--item-name', name];
}

// Returns a copy of the registry without the deployment recorded for a workspace (used after teardown, so a
// later install does not try to redeploy into an app item that no longer exists).
export function removeDeploymentByWorkspace(registry, workspaceId) {
  const wanted = String(workspaceId).toLowerCase();
  const deployments = {};
  const removed = [];
  for (const [key, entry] of Object.entries(registry?.deployments ?? {})) {
    if (String(entry?.fabricWorkspaceId ?? '').toLowerCase() === wanted) removed.push(key);
    else deployments[key] = entry;
  }
  const next = { ...registry, deployments };
  if (removed.includes(registry?.active)) {
    const first = Object.keys(deployments)[0];
    if (first) next.active = first;
    else delete next.active;
  }
  return { registry: next, removed };
}

// Adds a sign-in redirect URL to the allowedRedirectUris list of a rayfin.yml text. Idempotent.
export function ensureRedirectUri(ymlText, url) {
  const eol = ymlText.includes('\r\n') ? '\r\n' : '\n';
  const lines = ymlText.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*allowedRedirectUris:/.test(l));
  if (at < 0 || lines.some((l) => l.trim() === `- ${url}`)) return { text: ymlText, changed: false };
  let end = at + 1;
  while (end < lines.length && /^\s+-\s/.test(lines[end])) end += 1;
  const indent = /^(\s*)-\s/.exec(lines[end - 1] ?? '')?.[1] ?? '      ';
  lines.splice(end, 0, `${indent}- ${url}`);
  return { text: lines.join(eol), changed: true };
}

// An app item that already lives in the workspace (installed from another machine, or under the legacy name)
// is reused instead of creating a duplicate. Returns its display name, or undefined.
export function pickExistingAppName(items, appNames = [APP_ITEM_NAME, LEGACY_APP_ITEM_NAME]) {
  for (const wanted of appNames) {
    const hit = items.find((i) => i.type === 'AppBackend' && String(i.displayName).toLowerCase() === wanted.toLowerCase());
    if (hit) return hit.displayName;
  }
  return undefined;
}

const APP_ITEM_TYPES = ['AppBackend', 'SQLDatabase', 'UserDataFunction', 'SQLEndpoint'];

// Items the installer creates carry "Fabric Weave v<version> (managed)" at the start of their description.
// That marker (or an id recorded in the local manifest) is what says "this item is ours".
const MANAGED_MARKER = /^Fabric Weave v([0-9A-Za-z.+-]+) \(managed\)/;

export function managedDescription(version, text = '') {
  return `Fabric Weave v${version} (managed)${text ? `. ${text}` : ''}`;
}

export const isManagedItem = (item) => MANAGED_MARKER.test(String(item?.description ?? ''));

export const managedVersion = (item) => MANAGED_MARKER.exec(String(item?.description ?? ''))?.[1];

const sameId = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

// Classifies the items of a workspace into what teardown may remove and what it must keep.
// The app's database, functions and SQL endpoint are named after the app, so they are matched by the
// app's name, never by type alone. Anything else (the user's own models and reports) is kept.
//
// An item that only matches by name is removed only when it is also ours: it carries the managed marker,
// its id is in the local manifest (`manifestIds`) or it is the app item Rayfin recorded (`appItemId`).
// Anything else that merely has a Fabric Weave name is reported in `unmanaged` and kept, unless the caller
// passes `includeUnmarked`. A person's own item that happens to share a name must never be deleted by default.
export function classifyItems(items, { appNames = [APP_ITEM_NAME, LEGACY_APP_ITEM_NAME], appItemId, manifestIds = [], includeUnmarked = false } = {}) {
  const names = new Set(appNames.map((n) => n.toLowerCase()));
  const known = [...manifestIds, appItemId].filter(Boolean);
  const isOurs = (item) => isManagedItem(item) || known.some((id) => sameId(id, item.id));

  const candidates = [];
  const keep = [];
  for (const item of items) {
    const type = item.type;
    const name = String(item.displayName ?? '');
    const lname = name.toLowerCase();
    let group;
    if (appItemId && sameId(item.id, appItemId)) group = 'app';
    else if (APP_ITEM_TYPES.includes(type) && names.has(lname)) group = 'app';
    else if (type === 'DataPipeline' && name === PIPELINE_NAME) group = 'pipeline';
    else if (type === 'Notebook' && NOTEBOOK_NAMES.includes(name)) group = 'notebook';
    else if (type === 'Lakehouse' && name === LAKEHOUSE_NAME) group = 'lakehouse';
    else if (type === 'SQLEndpoint' && name === LAKEHOUSE_NAME) group = 'lakehouse-endpoint';
    if (group) candidates.push({ item, group, lname });
    else keep.push(item);
  }

  // The app's database, functions and endpoint are ours when the app item of the same name is; the lakehouse's
  // SQL endpoint is ours when the lakehouse is.
  const ourAppNames = new Set(candidates.filter((c) => c.item.type === 'AppBackend' && isOurs(c.item)).map((c) => c.lname));
  const ourLakehouse = candidates.some((c) => c.group === 'lakehouse' && isOurs(c.item));
  const ours = (c) => isOurs(c.item) || (c.group === 'app' && ourAppNames.has(c.lname)) || (c.group === 'lakehouse-endpoint' && ourLakehouse);

  const remove = [];
  const unmanaged = [];
  for (const c of candidates) {
    // A SQL endpoint cannot be deleted on its own: Fabric removes it together with its database or lakehouse.
    const entry = { ...c.item, group: c.group, cascade: c.item.type === 'SQLEndpoint' };
    if (ours(c)) remove.push(entry);
    else if (includeUnmarked) remove.push({ ...entry, unmarked: true });
    else {
      unmanaged.push(entry);
      keep.push(c.item);
    }
  }
  // The app depends on the lakehouse data, and the pipeline and notebooks reference the lakehouse.
  const order = ['app', 'pipeline', 'notebook', 'lakehouse-endpoint', 'lakehouse'];
  remove.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || Number(a.cascade) - Number(b.cascade));
  return { remove, keep, unmanaged };
}

export function describeWorkspaceContents(items, options = {}) {
  const { remove, unmanaged } = classifyItems(items, options);
  const hasApp = remove.some((i) => i.group === 'app');
  const hasBackend = remove.some((i) => i.group !== 'app');
  return { empty: items.length === 0, hasApp, hasBackend, installed: hasApp || hasBackend, unmanaged };
}

// What the installer may do with an item that already has the expected name.
//   create  nothing there yet
//   update  it is ours (marker or manifest): overwrite its definition
//   adopt   it is not marked, but an earlier install of this machine recorded the workspace (`legacy`), or the person
//           passed --adopt: overwrite it and stamp it
//   refuse  it is not marked and nobody said it is theirs to overwrite
export function decideAdoption(existing, { knownIds = [], adopt = false, legacy = false } = {}) {
  if (!existing) return { action: 'create' };
  if (isManagedItem(existing)) return { action: 'update', reason: 'marked as managed by Fabric Weave' };
  if (knownIds.some((id) => sameId(id, existing.id))) return { action: 'update', reason: 'recorded in the local manifest' };
  if (legacy) return { action: 'adopt', reason: 'it predates item stamping and this machine has an earlier install of the workspace on record' };
  if (adopt) return { action: 'adopt', reason: '--adopt was passed' };
  return {
    action: 'refuse',
    reason:
      `${existing.type} "${existing.displayName}" already exists in the workspace but was not created by Fabric Weave ` +
      '(no managed marker in its description, not in the local manifest). Nothing was changed. ' +
      'If it is yours to overwrite, re-run with --adopt. Otherwise rename it or use another workspace.',
  };
}

const FABRIC_SKU = /^F(\d+)$/i;
const PREMIUM_SKU = /^P(\d+)$/i;

// Rayfin apps and Copilot need F2+ (or P1+, or a trial capacity).
export function checkCapacity(capacity) {
  if (!capacity) return { ok: false, detail: 'The workspace has no capacity assigned' };
  const sku = String(capacity.sku ?? '');
  const state = String(capacity.state ?? '');
  const label = `${capacity.displayName ?? 'capacity'} (${sku}, ${state || 'state unknown'})`;
  if (state && state !== 'Active') return { ok: false, detail: `${label} is not running. Resume it first` };
  const trial = /^FT\d+$/i.test(sku) || /trial/i.test(sku);
  if (trial) return { ok: true, detail: label };
  const fabric = FABRIC_SKU.exec(sku);
  if (fabric) return Number(fabric[1]) >= 2 ? { ok: true, detail: label } : { ok: false, detail: `${label} is too small, use F2 or larger` };
  if (PREMIUM_SKU.test(sku)) return { ok: true, detail: label };
  return { ok: false, detail: `${label} is not an F2+, P1+ or trial capacity` };
}

export function checkAoaiEndpoint(endpoint) {
  if (!endpoint) return { ok: true, skipped: true, detail: 'Not configured (AI drafts, AI review and the Context interview stay off)' };
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, detail: `"${endpoint}" is not a URL` };
  }
  const host = url.hostname.toLowerCase();
  const valid = url.protocol === 'https:' && /\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(host);
  return valid
    ? { ok: true, detail: host }
    : { ok: false, detail: `"${host}" is not an Azure OpenAI or AI Foundry endpoint (https://<name>.openai.azure.com)` };
}

export function checkWorkspaceRole(role) {
  if (['Admin', 'Member'].includes(role)) return { ok: true, detail: role };
  if (role === 'Contributor') return { ok: true, warn: true, detail: 'Contributor. Admin or Member is recommended: deploying the app and granting its identity access need it' };
  return { ok: false, detail: role ? `Your role is ${role}. Admin or Member is needed to create items` : 'Could not read your role on the workspace' };
}

// Picks the strongest direct role of a user from a Fabric roleAssignments payload.
// Roles reached through a group cannot be resolved without Graph, so they are reported as `viaGroup`.
export function resolveRoleFromAssignments(assignments, userObjectId) {
  const rank = { Viewer: 1, Contributor: 2, Member: 3, Admin: 4 };
  const me = String(userObjectId ?? '').toLowerCase();
  let best;
  let groups = 0;
  for (const a of assignments ?? []) {
    const type = a?.principal?.type;
    if (type === 'Group') groups += 1;
    if (type === 'User' && String(a.principal.id ?? '').toLowerCase() === me && (!best || rank[a.role] > rank[best])) best = a.role;
  }
  return { role: best, viaGroup: !best && groups > 0 };
}

export function readJwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// Minimal "--flag value" / "--bool" parser. Unknown flags are reported, not ignored.
export function parseFlags(argv, spec) {
  const flags = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const kind = a.startsWith('--') ? spec[a.slice(2)] : undefined;
    if (kind === 'boolean') flags[a.slice(2)] = true;
    else if (kind === 'string') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) unknown.push(`${a} (needs a value)`);
      else {
        flags[a.slice(2)] = v;
        i++;
      }
    } else unknown.push(a);
  }
  return { flags, unknown };
}

// The lockfile must resolve from the public registry so `npm ci` works outside Microsoft's network.
export function findPrivateLockfileHosts(lockText) {
  const hosts = new Set();
  for (const m of lockText.matchAll(/"resolved":\s*"https?:\/\/([^/"]+)/g)) {
    if (m[1] !== 'registry.npmjs.org') hosts.add(m[1]);
  }
  return [...hosts];
}

// ---------------------------------------------------------------------------
// rayfin.yml is generated: app/rayfin/rayfin.base.yml (tracked) + the sign-in URL of the tenant (not tracked).

export const RAYFIN_YML_HEADER = '# GENERATED by install.mjs from rayfin.base.yml. Do not edit or commit this file: edit rayfin.base.yml instead.';

// The `version:` of a rayfin yml text (the release version).
export function readYmlVersion(ymlText) {
  return /^version:\s*["']?([0-9A-Za-z.+-]+)["']?\s*$/m.exec(String(ymlText))?.[1];
}

// The entries of the allowedRedirectUris list.
export function redirectUrisOf(ymlText) {
  const lines = String(ymlText).split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*allowedRedirectUris:/.test(l));
  if (at < 0) return [];
  const uris = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const m = /^\s+-\s+(\S+)\s*$/.exec(lines[i]);
    if (m) uris.push(m[1]);
    else if (!/^\s*(#.*)?$/.test(lines[i])) break;
  }
  return uris;
}

// Builds the text of rayfin.yml from the base file and the redirect URLs of the deployed app.
// Pure: the caller reads the base file and writes the result.
export function generateRayfinYml(baseText, urls = []) {
  let text = String(baseText);
  const added = [];
  for (const url of [...new Set(urls.filter(Boolean))]) {
    if (!/^https?:\/\/[^\s#'"]+$/.test(url)) throw new Error(`"${url}" is not a valid redirect URL`);
    if (!/^\s*allowedRedirectUris:/m.test(text)) throw new Error('rayfin.base.yml has no allowedRedirectUris list to add the app URL to');
    const edit = ensureRedirectUri(text, url);
    if (edit.changed) {
      text = edit.text;
      added.push(url);
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { text: `${RAYFIN_YML_HEADER}${eol}${text}`, added };
}

// ---------------------------------------------------------------------------
// App administrators (the APP_ADMINS secret)

// Sign-in names are e-mail style (user@contoso.com). The app also matches a user's object id, so a GUID is accepted.
const SIGN_IN_NAME = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// "a@x.com, b@y.com" -> { admins: ['a@x.com', 'b@y.com'], invalid: [] }. Lower-cased, de-duplicated.
export function parseAdmins(text) {
  const seen = new Set();
  const admins = [];
  const invalid = [];
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    const v = raw.trim();
    if (!v) continue;
    if (!SIGN_IN_NAME.test(v) && !GUID.test(v)) invalid.push(v);
    else if (!seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      admins.push(v.toLowerCase());
    }
  }
  return { admins, invalid };
}

// The default app administrator is the identity signed in to the Azure CLI, when it is a person. The sign-in name and the
// Entra object id are both listed: the token the app receives carries the object id but no e-mail, so the name alone never matches.
export function defaultAdmins(account, objectId) {
  if (!account?.ok) return { ok: false, detail: account?.detail ?? 'The Azure CLI is not signed in' };
  const { admins } = parseAdmins(account.user);
  if (account.type === 'servicePrincipal' || admins.length !== 1 || GUID.test(account.user ?? '')) {
    return { ok: false, detail: `The signed-in Azure CLI identity ("${account.user ?? 'unknown'}") is not a person's sign-in name` };
  }
  const id = String(objectId ?? '').trim().toLowerCase();
  return { ok: true, admins: GUID.test(id) ? [...admins, id] : admins };
}

// `rayfin --json secret list` prints one JSON line (after a "[rayfin] ..." notice). Without --json a non-interactive
// run prints no names at all, which made the installer think no secret existed and rotate the signing key.
export function parseSecretNames(stdout) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const doc = JSON.parse(text);
      if (doc?.status === 'success' && Array.isArray(doc.secrets)) {
        return { ok: true, names: doc.secrets.map((s) => String(s?.name ?? '')).filter(Boolean) };
      }
    } catch {
      // not the JSON line
    }
  }
  return { ok: false, names: [] };
}

// ---------------------------------------------------------------------------
// App dependencies: `npm ci` unless node_modules already matches the lockfile.

export function installDecision({ hasNodeModules, lockHash, stampHash }) {
  if (!hasNodeModules) return { install: true, reason: 'node_modules is missing' };
  if (!lockHash) return { install: true, reason: 'package-lock.json could not be read' };
  if (stampHash !== lockHash) return { install: true, reason: stampHash ? 'package-lock.json changed since the last install' : 'node_modules was not installed by this installer' };
  return { install: false, reason: 'node_modules matches package-lock.json' };
}

// ---------------------------------------------------------------------------
// Versions

const versionParts = (v) => {
  const parts = String(v ?? '').split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
};

// -1, 0 or 1 by major.minor.patch. Pre-release suffixes are ignored.
export function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

// What the installer says about the version change. `previous` is the version recorded in the local manifest;
// `legacy` means an install exists that predates version tracking.
export function describeVersionChange(previous, current, { legacy = false } = {}) {
  if (!previous) {
    return legacy
      ? { kind: 'upgrade', text: `upgrading an earlier install (made before versions were recorded) to v${current}` }
      : { kind: 'install', text: `installing v${current}` };
  }
  if (previous === current) return { kind: 'same', text: `reinstalling v${current} (same version as the last install)` };
  const order = compareVersions(previous, current);
  if (order < 0) return { kind: 'upgrade', text: `upgrading from v${previous} to v${current}` };
  if (order > 0) return { kind: 'downgrade', text: `moving from v${previous} back to v${current}, which is older: the app database may hold data the older version does not understand` };
  return { kind: 'change', text: `changing from v${previous} to v${current}` };
}

// Whether the installer deploys the estate scan (lakehouse, notebooks, pipeline) that feeds the Portfolio page.
//   full       deploy it (the default)
//   existing   --skip-backend --lakehouse <id>: leave the items alone and point the app at that lakehouse
//   app-only   --app-only: no scan at all; the app inspects and fixes the models people can reach, without the estate
//              inventory and usage data
export function backendPlan(flags) {
  const f = flags ?? {};
  const lakehouse = typeof f.lakehouse === 'string' ? f.lakehouse : '';
  if (f['app-only']) {
    const clash = [
      f['skip-backend'] && '--skip-backend',
      lakehouse && '--lakehouse',
      f['run-pipeline'] && '--run-pipeline',
      f['reset-schedule'] && '--reset-schedule',
    ].filter(Boolean);
    if (clash.length) return { mode: 'app-only', ok: false, error: `--app-only installs no lakehouse, notebooks or pipeline, so it cannot be combined with ${clash.join(', ')}.` };
    return { mode: 'app-only', ok: true };
  }
  if (f['skip-backend']) {
    if (!GUID.test(lakehouse)) return { mode: 'existing', ok: false, error: '--skip-backend needs --lakehouse <lakehouse-guid> so PORTFOLIO_PATH can be set. To install without the estate scan at all, use --app-only.' };
    return { mode: 'existing', ok: true, lakehouseId: lakehouse };
  }
  return { mode: 'full', ok: true };
}

// The first pipeline run fills the portfolio. Skip it when a portfolio already exists, unless asked.
export function shouldRunPipeline({ run = false, noRun = false, portfolioExists = false }) {
  if (noRun) return { run: false, reason: 'skipped (--no-run-pipeline)' };
  if (run) return { run: true, reason: '--run-pipeline' };
  if (portfolioExists) return { run: false, reason: 'skipped: Files/app/portfolio.json already exists (use --run-pipeline to run it anyway)' };
  return { run: true, reason: 'no portfolio yet, filling it' };
}

// ---------------------------------------------------------------------------
// Azure CLI and HTTP plumbing shared by the installer, the deployer and the tools.

export const TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 60 * 1000;

// Where the cached token stops being usable: its own expiry (minus a minute), but never later than ten minutes from now.
export function tokenDeadline(token, nowMs, { maxAgeMs = TOKEN_MAX_AGE_MS, skewMs = 60 * 1000 } = {}) {
  const exp = Number(readJwtClaims(token).exp);
  const byExpiry = Number.isFinite(exp) && exp > 0 ? exp * 1000 - skewMs : Infinity;
  return Math.min(nowMs + maxAgeMs, byExpiry);
}

// A synchronous token cache that re-acquires a token once it is old or about to expire.
export class TokenCache {
  constructor(fetchToken, { now = Date.now, maxAgeMs = TOKEN_MAX_AGE_MS } = {}) {
    this.fetchToken = fetchToken;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.entries = new Map();
  }

  get(resource) {
    const at = this.now();
    const hit = this.entries.get(resource);
    if (hit && at < hit.deadline) return hit.token;
    const token = this.fetchToken(resource);
    this.entries.set(resource, { token, deadline: tokenDeadline(token, at, { maxAgeMs: this.maxAgeMs }) });
    return token;
  }
}

// Wraps fetch so every request has a timeout and a timeout produces a readable error.
export function withTimeout(fetchFn, timeoutMs = REQUEST_TIMEOUT_MS) {
  return async (url, init = {}) => {
    try {
      return await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), ...init });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new Error(`${init.method ?? 'GET'} ${String(url).split('?')[0]} did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
      }
      throw e;
    }
  };
}

// Where the Azure CLI lives: AZURE_CLI_PATH, the usual Windows install folders, or plain `az` from PATH.
export function resolveAzPath({ env = process.env, platform = process.platform, exists = () => false } = {}) {
  const candidates = [env.AZURE_CLI_PATH];
  if (platform === 'win32') {
    candidates.push('C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd', 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd');
  }
  return candidates.filter(Boolean).find((c) => exists(c)) ?? 'az';
}

// Quotes one argument for the shell Node uses: cmd.exe on Windows, /bin/sh elsewhere.
export function quoteShellArg(value, platform = process.platform) {
  const v = String(value ?? '');
  if (/^[\w./:=@-]+$/.test(v)) return v;
  if (platform === 'win32') return `"${v.replace(/"/g, '""')}"`;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

// One command string, so `shell: true` behaves the same on Windows, macOS and Linux.
export function azCommandLine(args, { env = process.env, platform = process.platform, exists = () => false } = {}) {
  return [quoteShellArg(resolveAzPath({ env, platform, exists }), platform), ...args.map((a) => quoteShellArg(a, platform))].join(' ');
}
