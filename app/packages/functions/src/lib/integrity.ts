import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Snapshots are restored with the app identity, so they must be provably the ones this app wrote. */
export const MIN_SIGNING_KEY_LENGTH = 32;

export interface SnapshotBinding {
  workspaceId: string;
  modelId: string;
  snapshotId: string;
  /** sha256 of the concatenated snapshot chunks. */
  digest: string;
}

export function digestChunks(chunks: readonly string[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk, 'utf8');
  return hash.digest('hex');
}

export function usableSigningKey(key: string | undefined): key is string {
  return typeof key === 'string' && key.trim().length >= MIN_SIGNING_KEY_LENGTH;
}

function mac(key: string, b: SnapshotBinding): Buffer {
  const message = ['snapshot-v1', b.workspaceId.toLowerCase(), b.modelId.toLowerCase(), b.snapshotId.toLowerCase(), b.digest].join('|');
  return createHmac('sha256', key.trim()).update(message, 'utf8').digest();
}

export function signSnapshot(key: string, binding: SnapshotBinding): string {
  return mac(key, binding).toString('hex');
}

/** What an admin chose for a workspace. Signed, so a direct database write cannot widen it. */
export interface SettingBinding {
  workspaceId: string;
  writeMode: string;
  inScope: boolean;
}

function settingMac(key: string, b: SettingBinding): Buffer {
  const message = ['setting-v1', b.workspaceId.toLowerCase(), b.writeMode, b.inScope ? '1' : '0'].join('|');
  return createHmac('sha256', key.trim()).update(message, 'utf8').digest();
}

export function signSetting(key: string, binding: SettingBinding): string {
  return settingMac(key, binding).toString('hex');
}

export function verifySetting(key: string, binding: SettingBinding, signature: string | undefined | null): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = settingMac(key, binding);
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Fingerprint of a whole definition. Two reads of an unchanged model give the same value. */
export function definitionDigest(parts: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(parts).sort()) {
    hash.update(path, 'utf8').update('\u0000').update(parts[path] ?? '', 'utf8').update('\u0000');
  }
  return hash.digest('hex');
}

export function verifySnapshot(key: string, binding: SnapshotBinding, signature: string | undefined | null): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = mac(key, binding);
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const SEGMENT = '[^\\\\/\\u0000-\\u001f]+';
const TMDL_PART = new RegExp(`^definition/(?:${SEGMENT}/)*${SEGMENT}\\.(?:tmdl|json)$`);
const COPILOT_PART = new RegExp(`^Copilot/(?:${SEGMENT}/)*${SEGMENT}\\.(?:md|json)$`);

/** Part paths that may be written back to a semantic model. Anything else is refused. */
export function disallowedPartPaths(paths: readonly string[]): string[] {
  const bad: string[] = [];
  for (const p of paths) {
    if (p === 'definition.pbism') continue;
    if (p.split('/').includes('..') || p.split('/').includes('.')) {
      bad.push(p);
      continue;
    }
    if (!TMDL_PART.test(p) && !COPILOT_PART.test(p)) bad.push(p);
  }
  return bad;
}
