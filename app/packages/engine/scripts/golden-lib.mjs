// Shared by golden-parity.mjs (regenerates the golden file) and test/parity.test.mjs (checks it).
// It turns scanner-shaped fixtures (the JSON NB_01 stores per model) into engine snapshots exactly the way
// backend/notebooks/_shared.py `build_model` does, scores them with the TypeScript engine and reduces the
// result to what the Python quick scorer can be compared against.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, scoreModel } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

export const FIXTURES_PATH = resolve(repoRoot, 'backend/tests/fixtures/scanner_models.json');
export const GOLDEN_PATH = resolve(repoRoot, 'backend/tests/fixtures/golden_ts_scores.json');
export const CATALOG_PATH = resolve(repoRoot, 'backend/catalog/rule-catalog.json');

const NOT_EXPOSED = 'AI instructions are not exposed by the scanner, so quick scoring skips this rule.';
const DEEP_ONLY = 'Needs the full model definition (deep scan only).';

/** Rules the quick (scanner-only) mode cannot evaluate. The parity test compares every other rule. */
export const SKIPPED_RULES = {
  'FND-002': DEEP_ONLY,
  'FND-003': DEEP_ONLY,
  'FND-004': DEEP_ONLY,
  'FND-007': DEEP_ONLY,
  'DSC-005': DEEP_ONLY,
  'INS-001': NOT_EXPOSED,
  'INS-002': NOT_EXPOSED,
  'INS-003': NOT_EXPOSED,
  'INS-004': DEEP_ONLY,
  'SCH-001': DEEP_ONLY,
  'SCH-004': DEEP_ONLY,
  'EXM-001': DEEP_ONLY,
  'EXM-002': DEEP_ONLY,
};

export const comparedRules = () => CATALOG.rules.map((r) => r.id).filter((id) => !(id in SKIPPED_RULES));

const DATA_TYPES = {
  string: 'string',
  int64: 'int64',
  double: 'double',
  decimal: 'decimal',
  boolean: 'boolean',
  datetime: 'dateTime',
};

const dataTypeOf = (value) => DATA_TYPES[String(value ?? '').toLowerCase()] ?? 'unknown';
const visibilityOf = (value) => (value === 'Visible' || value === 'Hidden' ? value : undefined);
const textOf = (value) => (typeof value === 'string' && value.trim() ? value : undefined);

/** Mirror of `build_model` in backend/notebooks/_shared.py. */
export function scannerToSnapshot(entry) {
  const { inventory, dataset } = entry;
  return {
    name: inventory.model_name || dataset.name,
    discourageImplicitMeasures: false,
    tables: (dataset.tables ?? []).map((t) => ({
      name: t.name,
      description: textOf(t.description),
      isHidden: Boolean(t.isHidden),
      isCalculatedTable: false,
      columns: (t.columns ?? []).map((c) => ({
        name: c.name,
        dataType: dataTypeOf(c.dataType),
        description: textOf(c.description),
        isHidden: Boolean(c.isHidden),
        isCalculated: false,
        isKey: Boolean(c.isKey),
        formatString: textOf(c.formatString),
        summarizeBy: c.summarizeBy ? String(c.summarizeBy).toLowerCase() : undefined,
        synonyms: c.synonyms ?? [],
        aiVisibility: visibilityOf(c.visibility),
      })),
      measures: (t.measures ?? []).map((m) => ({
        name: m.name,
        expression: m.expression ?? '',
        description: textOf(m.description),
        isHidden: Boolean(m.isHidden),
        formatString: textOf(m.formatString),
        synonyms: m.synonyms ?? [],
        aiVisibility: visibilityOf(m.visibility),
      })),
      hierarchies: [],
      synonyms: t.synonyms ?? [],
      aiVisibility: visibilityOf(t.visibility),
    })),
    relationships: (dataset.relationships ?? []).map((r) => ({
      name: r.name ?? '',
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
      isActive: true,
      crossFilter: 'single',
      fromCardinality: 'many',
      toCardinality: 'one',
    })),
    copilot: { hasSchema: false, examplePrompts: [], verifiedAnswerCount: 0 },
    governance: {
      qnaEnabled: null,
      approvedForCopilot: null,
      endorsement: inventory.endorsement ?? null,
      capacityEligible: inventory.on_dedicated_capacity ?? null,
    },
    metadataOnly: true,
  };
}

const round6 = (n) => (n === null ? null : Math.round(n * 1e6) / 1e6);

/** Score every fixture with the TypeScript engine in quick mode and reduce it to the comparable fields. */
export function computeGolden(fixtures) {
  const compared = comparedRules();
  // The scanner exposes no AI instructions; the Python scorer returns null for them, so null them here too.
  const external = Object.fromEntries(
    Object.keys(SKIPPED_RULES)
      .filter((id) => id.startsWith('INS-'))
      .map((id) => [id, { score: null, evidence: NOT_EXPOSED }]),
  );
  const models = {};
  for (const entry of fixtures) {
    const result = scoreModel(scannerToSnapshot(entry), { external, now: new Date(0) });
    const rules = {};
    for (const id of compared) {
      const rule = result.rules.find((r) => r.ruleId === id);
      rules[id] = {
        score: round6(rule.score),
        findings: rule.findings.map((f) => `${f.objectType}|${f.objectPath}|${f.fixKind}`).sort(),
      };
    }
    models[entry.id] = {
      score: result.score,
      rawScore: result.rawScore,
      tier: result.tier,
      gates: Object.fromEntries(result.gates.map((g) => [g.id, g.triggered])),
      categories: Object.fromEntries(result.categories.map((c) => [c.id, { score: c.score, points: c.points }])),
      rules,
    };
  }
  return {
    catalogVersion: CATALOG.version,
    note: 'Generated by app/packages/engine/scripts/golden-parity.mjs from the TypeScript engine. Do not edit by hand.',
    compared,
    skipped: SKIPPED_RULES,
    models,
  };
}

export const readFixtures = () => JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
