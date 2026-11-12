// Small file-system helpers for the local files of a checkout, shared by install.mjs, backend/deploy.mjs,
// tools/preflight.mjs and tools/teardown.mjs. The functions that only transform data take and return plain
// values, so they are unit-tested in tools/test/.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRayfinYml, readYmlVersion, redirectUrisOf } from './common.mjs';

const at = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

export const PATHS = {
  baseYml: at('app/rayfin/rayfin.base.yml'),
  yml: at('app/rayfin/rayfin.yml'),
  manifest: at('app/rayfin/.fabric-weave.json'),
  registry: at('app/rayfin/.deployments.json'),
  lock: at('app/package-lock.json'),
  nodeModules: at('app/node_modules'),
  lockStamp: at('app/node_modules/.fabric-weave-lock.sha256'),
};

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

// Rayfin's own record of deployments, keyed by workspace name. Read only: the installer never writes to it.
export function readRegistry(path = PATHS.registry) {
  try {
    const text = readText(path);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The release version, from the tracked base config.
export function readBaseVersion(path = PATHS.baseYml) {
  const text = readText(path);
  return text === undefined ? undefined : readYmlVersion(text);
}

// Writes app/rayfin/rayfin.yml from rayfin.base.yml plus the sign-in URL(s) of the deployed app. Redirect URLs that an
// earlier run or Rayfin already put into the generated file are kept, so a redeploy never drops sign-in.
export function prepareRayfinYml({ urls = [], basePath = PATHS.baseYml, outPath = PATHS.yml, write = true } = {}) {
  const base = readText(basePath);
  if (base === undefined) throw new Error(`${basePath} is missing. Restore it from the repository.`);
  const current = readText(outPath);
  const inBase = new Set(redirectUrisOf(base));
  const kept = current === undefined ? [] : redirectUrisOf(current).filter((u) => !inBase.has(u) && /^https?:\/\/[^\s#'"]+$/.test(u));
  const { text, added } = generateRayfinYml(base, [...kept, ...urls]);
  const changed = text !== current;
  if (write && changed) writeFileSync(outPath, text, 'utf8');
  return { path: outPath, changed, added, text };
}

// ---------------------------------------------------------------------------
// The installer manifest: which items this machine's installer created in which workspace, and the version.
// Rayfin keeps its own .deployments.json (it is Rayfin's file, so the installer does not write to it).

export function readManifest(path = PATHS.manifest) {
  try {
    const parsed = JSON.parse(readText(path) ?? '');
    return parsed && typeof parsed === 'object' && parsed.workspaces ? parsed : { schema: 1, workspaces: {} };
  } catch {
    return { schema: 1, workspaces: {} };
  }
}

export function writeManifest(manifest, path = PATHS.manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export const manifestEntry = (manifest, workspaceId) => manifest?.workspaces?.[String(workspaceId).toLowerCase()];

export const manifestIds = (manifest, workspaceId) => Object.keys(manifestEntry(manifest, workspaceId)?.items ?? {});

// Adds items ({ id, type, displayName }) and optionally the installed version to a workspace's record.
export function recordInstall(manifest, workspaceId, { items = [], version, now = new Date() } = {}) {
  const key = String(workspaceId).toLowerCase();
  const previous = manifest?.workspaces?.[key] ?? { items: {} };
  const next = { ...previous, items: { ...previous.items }, updatedAt: now.toISOString() };
  if (version) next.version = version;
  if (!next.installedAt) next.installedAt = next.updatedAt;
  for (const item of items) {
    if (item?.id) next.items[String(item.id).toLowerCase()] = { type: item.type, displayName: item.displayName };
  }
  return { schema: 1, ...manifest, workspaces: { ...manifest?.workspaces, [key]: next } };
}

export function forgetWorkspace(manifest, workspaceId) {
  const workspaces = { ...manifest?.workspaces };
  delete workspaces[String(workspaceId).toLowerCase()];
  return { schema: 1, ...manifest, workspaces };
}

// Drops removed items from a workspace's record; the record goes away with its last item.
export function forgetItems(manifest, workspaceId, ids = []) {
  const key = String(workspaceId).toLowerCase();
  const entry = manifest?.workspaces?.[key];
  if (!entry) return manifest;
  const gone = new Set(ids.map((id) => String(id).toLowerCase()));
  const items = Object.fromEntries(Object.entries(entry.items ?? {}).filter(([id]) => !gone.has(id)));
  if (Object.keys(items).length === 0) return forgetWorkspace(manifest, workspaceId);
  return { schema: 1, ...manifest, workspaces: { ...manifest.workspaces, [key]: { ...entry, items } } };
}

// ---------------------------------------------------------------------------
// npm ci stamp

export function lockfileHash(path = PATHS.lock) {
  const text = readText(path);
  return text === undefined ? undefined : createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

export const readLockStamp = (path = PATHS.lockStamp) => readText(path)?.trim();

export function writeLockStamp(hash, path = PATHS.lockStamp) {
  if (hash && existsSync(dirname(path))) writeFileSync(path, `${hash}\n`, 'utf8');
}
