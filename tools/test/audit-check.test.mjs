import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisoryId, collectAdvisories, evaluateAudit } from '../audit-check.mjs';

const advisory = (over = {}) => ({
  source: 1,
  name: 'zod',
  title: 'Memory exhaustion',
  url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5',
  severity: 'high',
  range: '<4.6.6',
  ...over,
});

// Shaped like `npm audit --json` (auditReportVersion 2): the advisory sits on the package, the others only chain to it.
const report = (vulns) => ({ auditReportVersion: 2, vulnerabilities: vulns, metadata: {} });
const chain = report({
  zod: { name: 'zod', severity: 'high', via: [advisory()] },
  '@microsoft/rayfin-tools-common': { name: '@microsoft/rayfin-tools-common', severity: 'high', via: ['zod'] },
});
const allow = [{ id: 'GHSA-mrhx-c7xc-m3w5', reason: 'pinned by Rayfin', expires: '2027-01-31' }];
const now = new Date('2026-10-13T00:00:00Z');

test('advisoryId extracts the GHSA id and lowercases it', () => {
  assert.equal(advisoryId('https://github.com/advisories/GHSA-MRHX-c7xc-m3w5'), 'ghsa-mrhx-c7xc-m3w5');
  assert.equal(advisoryId(1243066), '1243066');
});

test('collectAdvisories reads object entries once and ignores chained package names and low severity', () => {
  const r = report({
    a: { name: 'a', via: [advisory(), 'b'] },
    b: { name: 'b', via: [advisory()] },
    c: { name: 'c', via: [advisory({ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'moderate' })] },
  });
  const found = collectAdvisories(r);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'ghsa-mrhx-c7xc-m3w5');
});

test('a high advisory that is not on the allowlist blocks', () => {
  const r = evaluateAudit(chain, [], now);
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
});

test('an allowlisted advisory passes and is reported', () => {
  const r = evaluateAudit(chain, allow, now);
  assert.equal(r.ok, true);
  assert.equal(r.allowed.length, 1);
  assert.equal(r.allowed[0].reason, 'pinned by Rayfin');
});

test('an expired allowlist entry fails again', () => {
  const r = evaluateAudit(chain, allow, new Date('2027-02-01T00:00:00Z'));
  assert.equal(r.ok, false);
  assert.equal(r.expired.length, 1);
  assert.equal(r.blocking.length, 0);
});

test('a new advisory next to an allowed one still blocks', () => {
  const r = evaluateAudit(report({
    zod: { name: 'zod', via: [advisory()] },
    other: { name: 'other', via: [advisory({ name: 'other', url: 'https://github.com/advisories/GHSA-1111-2222-3333', severity: 'critical' })] },
  }), allow, now);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocking.map((a) => a.id), ['ghsa-1111-2222-3333']);
});

test('a clean report passes', () => {
  assert.equal(evaluateAudit(report({}), [], now).ok, true);
});

test('an npm audit error or a foreign document fails instead of passing silently', () => {
  assert.match(evaluateAudit({ error: { summary: 'request to registry failed' } }, [], now).error, /request to registry failed/);
  assert.match(evaluateAudit({ foo: 1 }, [], now).error, /vulnerabilities/);
  assert.match(evaluateAudit(undefined, [], now).error, /not JSON/);
});
