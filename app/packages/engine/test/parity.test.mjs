import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATALOG } from '../dist/index.js';
import { CATALOG_PATH, GOLDEN_PATH, SKIPPED_RULES, comparedRules, computeGolden, readFixtures } from '../scripts/golden-lib.mjs';

// Python/TypeScript parity: backend/tests/test_parity.py checks the Python quick scorer against the golden file;
// this test checks the TypeScript engine still reproduces it. Regenerate with
//   node app/packages/engine/scripts/golden-parity.mjs   (from the repo root, after building the engine)

test('the TypeScript engine reproduces the golden parity file', () => {
  const stored = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const fresh = JSON.parse(JSON.stringify(computeGolden(readFixtures())));
  assert.deepEqual(
    fresh,
    stored,
    'engine output changed: run `node app/packages/engine/scripts/golden-parity.mjs`, review the diff and re-run backend/tests/test_parity.py',
  );
});

test('the exported rule catalog is in step with the engine and has no BOM', () => {
  const bytes = readFileSync(CATALOG_PATH);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'rule-catalog.json must not start with a BOM');
  const stored = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(stored, JSON.parse(JSON.stringify(CATALOG)), 'run `node app/packages/engine/scripts/export-catalog.mjs` after changing catalog.ts');
});

test('every deep-only rule is listed as skipped and every other rule is compared', () => {
  const ids = CATALOG.rules.map((r) => r.id);
  for (const rule of CATALOG.rules.filter((r) => r.deepOnly)) assert.ok(rule.id in SKIPPED_RULES, `${rule.id} is deep-only and must be listed as skipped`);
  for (const id of Object.keys(SKIPPED_RULES)) assert.ok(ids.includes(id), `${id} is skipped but not in the catalog`);
  assert.deepEqual([...comparedRules(), ...Object.keys(SKIPPED_RULES)].sort(), [...ids].sort());
});

test('parity fixtures exercise the interesting cases', () => {
  const stored = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const ids = Object.keys(stored.models);
  assert.ok(ids.length >= 4);
  assert.ok(ids.some((id) => stored.models[id].gates['GATE-NO-MEASURES']), 'one model triggers the no-measures gate');
  assert.ok(ids.some((id) => stored.models[id].gates['GATE-NO-CAPACITY']), 'one model triggers the capacity gate');
  const placeholders = stored.models.placeholders.rules['DSC-004'];
  assert.ok(placeholders.score < 0.5 && placeholders.findings.length >= 10, 'placeholder and duplicate descriptions are caught');
});
