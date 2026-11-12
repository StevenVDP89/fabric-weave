#!/usr/bin/env node
// Fails when `npm audit --omit=dev --json` reports a high or critical advisory that is not on the reviewed allowlist.
//
//   cd app
//   npm audit --omit=dev --json > audit.json
//   node ../tools/audit-check.mjs audit.json [--allowlist ../tools/audit-allowlist.json]
//
// Why not plain `npm audit --audit-level=high`: some advisories sit in a dependency that only the Rayfin packages can
// bump (they pin it), so the repository cannot fix them. Those are listed in tools/audit-allowlist.json with a reason and
// an expiry date. An expired entry fails the check again, so nobody forgets about it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const BLOCKING = new Set(['high', 'critical']);

export function advisoryId(url) {
  return String(url ?? '').match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0].toLowerCase() ?? String(url ?? '');
}

// Collects every high or critical advisory of the report once, whichever package in the dependency chain carries it.
export function collectAdvisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      if (!BLOCKING.has(String(via.severity).toLowerCase())) continue;
      const id = advisoryId(via.url ?? via.source);
      if (!found.has(id)) found.set(id, { id, package: via.name ?? vuln.name, severity: via.severity, title: via.title ?? '', range: via.range ?? '' });
    }
  }
  return [...found.values()];
}

export function evaluateAudit(report, allowlist = [], now = new Date()) {
  if (!report || typeof report !== 'object') return { ok: false, error: 'the audit output is not JSON', blocking: [], allowed: [], expired: [] };
  if (report.error) {
    const e = report.error;
    return { ok: false, error: `npm audit failed: ${e.summary ?? e.code ?? JSON.stringify(e)}`, blocking: [], allowed: [], expired: [] };
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    return { ok: false, error: 'the audit output has no "vulnerabilities" section (is it from "npm audit --json"?)', blocking: [], allowed: [], expired: [] };
  }
  const byId = new Map(allowlist.map((e) => [String(e.id).toLowerCase(), e]));
  const blocking = [];
  const allowed = [];
  const expired = [];
  for (const adv of collectAdvisories(report)) {
    const entry = byId.get(adv.id);
    if (!entry) {
      blocking.push(adv);
    } else if (entry.expires && new Date(entry.expires).getTime() < now.getTime()) {
      expired.push({ ...adv, expires: entry.expires });
    } else {
      allowed.push({ ...adv, reason: entry.reason ?? '', expires: entry.expires ?? '' });
    }
  }
  return { ok: blocking.length === 0 && expired.length === 0, blocking, allowed, expired };
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { allowlist: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || positionals.length !== 1) {
    console.log('Usage: node tools/audit-check.mjs <audit.json> [--allowlist <file>]');
    process.exit(values.help ? 0 : 2);
  }
  const allowlistPath = values.allowlist ?? join(dirname(fileURLToPath(import.meta.url)), 'audit-allowlist.json');
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')).allow ?? [];
  let report;
  try {
    report = JSON.parse(readFileSync(positionals[0], 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    report = undefined;
  }
  const result = evaluateAudit(report, allowlist);
  if (result.error) {
    console.error(`FAIL ${result.error}`);
    process.exit(1);
  }
  for (const a of result.allowed) console.log(`allowed  ${a.id} ${a.package} (${a.severity}) until ${a.expires || 'further notice'}: ${a.reason}`);
  for (const a of result.expired) console.error(`EXPIRED  ${a.id} ${a.package} (${a.severity}): the allowlist entry ended on ${a.expires}. Review it again or fix the dependency.`);
  for (const a of result.blocking) console.error(`BLOCKING ${a.id} ${a.package} (${a.severity}) ${a.title} (affected ${a.range})`);
  if (!result.ok) process.exit(1);
  console.log(`npm audit: no high or critical advisories outside the allowlist (${result.allowed.length} allowed).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
