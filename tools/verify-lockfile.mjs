#!/usr/bin/env node
// Maintainer check: every `integrity` in app/package-lock.json must equal what the public npm registry publishes.
// A hash copied from a private feed (for example GitHub Packages) has the same files but different tarball bytes,
// so a fresh `npm ci` fails with EINTEGRITY for everyone without a warm cache.
//
//   node tools/verify-lockfile.mjs [path] [--fix]
//
// registry.npmjs.org is used first. NPM_VERIFY_REGISTRIES (comma separated) replaces the list when it is blocked,
// for example behind a corporate proxy: public mirrors serve the same dist.integrity.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://repo.huaweicloud.com/repository/npm',
  'https://mirrors.cloud.tencent.com/npm',
  'https://r.cnpmjs.org',
];

export function lockEntries(lock) {
  const entries = [];
  for (const [key, e] of Object.entries(lock.packages || {})) {
    if (!key || e.link || !e.resolved || !e.integrity) continue;
    const name = e.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    entries.push({ key, name, version: e.version, integrity: e.integrity });
  }
  return entries;
}

export function integrityMatches(lockIntegrity, published) {
  if (lockIntegrity.startsWith('sha1-')) {
    const sha1 = published.shasum ? `sha1-${Buffer.from(published.shasum, 'hex').toString('base64')}` : null;
    return sha1 === lockIntegrity || Boolean(published.integrity && published.integrity.includes(lockIntegrity));
  }
  return published.integrity === lockIntegrity;
}

async function published(registries, name, version) {
  const route = `/${name.replace('/', '%2f')}/${version}`;
  let why = 'no registry answered';
  for (const registry of registries) {
    try {
      const res = await fetch(registry + route, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { why = `${res.status} on ${registry}`; continue; }
      const dist = (await res.json()).dist;
      if (dist && (dist.integrity || dist.shasum)) return { integrity: dist.integrity, shasum: dist.shasum };
      why = `no integrity on ${registry}`;
    } catch (err) {
      why = (err.cause && err.cause.code) || err.name;
    }
  }
  return { error: why };
}

// Write next to the target and rename, so an interrupted run can never leave an empty lockfile.
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lockPath = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(here, '..', 'app', 'package-lock.json'));
  const registries = (process.env.NPM_VERIFY_REGISTRIES || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const list = registries.length ? registries : DEFAULT_REGISTRIES;

  const raw = fs.readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(raw);
  const entries = lockEntries(lock);
  const mismatches = [];
  const unknown = [];
  let matched = 0;
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const entry = entries[next++];
      const result = await published(list, entry.name, entry.version);
      if (result.error) unknown.push({ ...entry, why: result.error });
      else if (integrityMatches(entry.integrity, result)) matched++;
      else mismatches.push({ ...entry, wanted: result.integrity || `sha1-${Buffer.from(result.shasum, 'hex').toString('base64')}` });
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));

  console.log(`checked ${entries.length}: match ${matched}, mismatch ${mismatches.length}, unknown ${unknown.length}`);
  for (const m of mismatches) console.log(`MISMATCH ${m.name}@${m.version}  lock ${m.integrity.slice(0, 22)}...  public ${m.wanted.slice(0, 22)}...`);
  for (const u of unknown.slice(0, 20)) console.log(`UNKNOWN  ${u.name}@${u.version}  ${u.why}`);

  if (fix && mismatches.length && !unknown.length) {
    for (const m of mismatches) lock.packages[m.key].integrity = m.wanted;
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    writeAtomic(lockPath, JSON.stringify(lock, null, 2).replace(/\n/g, eol) + (raw.endsWith('\n') ? eol : ''));
    console.log(`lockfile updated: ${mismatches.length} integrity values`);
    return 0;
  }
  if (unknown.length) {
    console.log('Some packages could not be checked: nothing was changed. Set NPM_VERIFY_REGISTRIES to a reachable registry.');
    return 2;
  }
  return mismatches.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
}
