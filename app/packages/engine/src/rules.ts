import { CATALOG } from './catalog.js';
import {
  abbreviationsIn,
  isFriendlyName,
  isKeyLikeName,
  isTechnicalTableName,
  tokenize,
} from './names.js';
import type {
  ColumnInfo,
  Finding,
  FixKind,
  MeasureInfo,
  ModelSnapshot,
  RuleResult,
  TableInfo,
} from './types.js';

export interface ExternalRuleResult {
  score: number | null;
  evidence: string;
  findings?: Finding[];
}

export interface EvaluateOptions {
  /** Results produced outside the deterministic engine (for example the LLM judge). */
  external?: Record<string, ExternalRuleResult>;
}

interface ScopedColumn {
  table: TableInfo;
  column: ColumnInfo;
}
interface ScopedMeasure {
  table: TableInfo;
  measure: MeasureInfo;
}

interface Ctx {
  snap: ModelSnapshot;
  tables: TableInfo[];
  columns: ScopedColumn[];
  measures: ScopedMeasure[];
  relCols: Set<string>;
  deep: boolean;
}

type Impl = (ctx: Ctx) => { score: number | null; evidence: string; findings: Finding[] };

const MAX_FINDINGS = 150;
export const INSTRUCTIONS_MAX = 10000;
export const INSTRUCTIONS_MIN = 300;
/** Instructions of at least INSTRUCTIONS_MIN characters still need this many distinct words ... */
export const INSTRUCTIONS_MIN_DISTINCT_WORDS = 40;
/** ... and this share of distinct words among all words, otherwise they are repetitive filler. */
export const INSTRUCTIONS_MIN_DISTINCT_RATIO = 0.35;
/** A section of the instructions needs this many words (or two bullets) under its heading to count. */
export const INSTRUCTIONS_SECTION_MIN_WORDS = 8;
/** The same description on this many objects of one kind within a model is boilerplate. */
export const DUPLICATE_DESCRIPTION_LIMIT = 5;

export function isTableInScope(t: TableInfo): boolean {
  return !t.isHidden && t.aiVisibility !== 'Hidden';
}

function buildCtx(snap: ModelSnapshot): Ctx {
  const tables = snap.tables.filter(isTableInScope);
  const columns: ScopedColumn[] = [];
  const measures: ScopedMeasure[] = [];
  for (const t of tables) {
    for (const c of t.columns) if (!c.isHidden && c.aiVisibility !== 'Hidden') columns.push({ table: t, column: c });
    for (const m of t.measures) if (!m.isHidden && m.aiVisibility !== 'Hidden') measures.push({ table: t, measure: m });
  }
  const relCols = new Set<string>();
  for (const r of snap.relationships) {
    relCols.add(`${r.fromTable}\u0000${r.fromColumn}`);
    relCols.add(`${r.toTable}\u0000${r.toColumn}`);
  }
  return { snap, tables, columns, measures, relCols, deep: !snap.metadataOnly };
}

export const colPath = (t: string, c: string) => `${t}.${c}`;
export const measurePath = (t: string, m: string) => `${t}[${m}]`;

function finding(
  ruleId: string,
  objectType: Finding['objectType'],
  objectPath: string,
  message: string,
  fixKind: FixKind,
  data?: Record<string, unknown>,
): Finding {
  return { ruleId, objectType, objectPath, message, fixKind, data };
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));
const isNumeric = (c: ColumnInfo) => c.dataType === 'int64' || c.dataType === 'double' || c.dataType === 'decimal';

function isMeasuresOnlyTable(t: TableInfo): boolean {
  return t.measures.length > 0 && t.columns.every((c) => c.isHidden);
}

// ---------------------------------------------------------------------------
// Foundation
// ---------------------------------------------------------------------------

const FND001: Impl = (ctx) => {
  const n = ctx.snap.tables.reduce((s, t) => s + t.measures.length, 0);
  const findings: Finding[] = [];
  if (n === 0) {
    findings.push(
      finding('FND-001', 'model', ctx.snap.name, 'The model has no explicit measures.', 'add-measure'),
    );
    return { score: 0, evidence: 'No explicit measures in the model.', findings };
  }
  const score = Math.min(1, 0.5 + 0.1 * n);
  if (score < 1) {
    findings.push(
      finding('FND-001', 'model', ctx.snap.name, `Only ${n} explicit measure(s); add measures for the key numbers.`, 'add-measure'),
    );
  }
  return { score, evidence: `${n} explicit measure(s).`, findings };
};

const FND002: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Relationships not available.', findings: [] };
  const candidates = ctx.tables.filter((t) => !isMeasuresOnlyTable(t));
  if (ctx.snap.tables.length <= 1 || candidates.length === 0) return { score: 1, evidence: 'Single-table model.', findings: [] };
  const related = new Set<string>();
  for (const r of ctx.snap.relationships) {
    related.add(r.fromTable);
    related.add(r.toTable);
  }
  const orphans = candidates.filter((t) => !related.has(t.name));
  const findings = orphans.map((t) =>
    finding('FND-002', 'table', t.name, `Table "${t.name}" has no relationships.`, 'manual', { table: t.name }),
  );
  return {
    score: 1 - orphans.length / candidates.length,
    evidence: `${orphans.length} of ${candidates.length} visible table(s) have no relationships.`,
    findings,
  };
};

const FND003: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Column properties not available.', findings: [] };
  if (ctx.snap.discourageImplicitMeasures) return { score: 1, evidence: 'discourageImplicitMeasures is on.', findings: [] };
  const numeric = ctx.columns.filter((x) => isNumeric(x.column) && !x.column.isKey);
  if (numeric.length === 0) return { score: null, evidence: 'No visible numeric columns.', findings: [] };
  const bad = numeric.filter((x) => (x.column.summarizeBy ?? 'default') !== 'none');
  const findings = bad.map((x) =>
    finding(
      'FND-003',
      'column',
      colPath(x.table.name, x.column.name),
      `Numeric column auto-aggregates (summarizeBy: ${x.column.summarizeBy ?? 'default'}).`,
      'set-summarize-none',
      { table: x.table.name, name: x.column.name },
    ),
  );
  return {
    score: 1 - bad.length / numeric.length,
    evidence: `${bad.length} of ${numeric.length} visible numeric column(s) still aggregate implicitly.`,
    findings,
  };
};

const FND004: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Definition not available.', findings: [] };
  const hasDates = ctx.snap.tables.some((t) => t.columns.some((c) => c.dataType === 'dateTime'));
  if (!hasDates) return { score: null, evidence: 'No date columns in the model.', findings: [] };
  const marked = ctx.snap.tables.find((t) => (t.dataCategory ?? '').toLowerCase() === 'time');
  if (marked) return { score: 1, evidence: `Date table: ${marked.name}.`, findings: [] };
  const candidate = ctx.snap.tables.find((t) => /^(date|calendar|dim.?date|dim.?calendar|dates)$/i.test(t.name.replace(/\s+/g, '')));
  const dateCol = candidate?.columns.find((c) => c.dataType === 'dateTime');
  // A table can have only one key column and a date table needs the date column as its key.
  // An existing key is never changed, so such a table is left for a person to decide.
  const otherKey = dateCol ? candidate?.columns.find((c) => c.isKey && c.name !== dateCol.name) : undefined;
  const auto = !!candidate && !!dateCol && !otherKey;
  return {
    score: candidate ? 0.3 : 0,
    evidence: candidate ? `Calendar table "${candidate.name}" is not marked as date table.` : 'No date table found.',
    findings: [
      finding(
        'FND-004',
        'model',
        candidate ? candidate.name : ctx.snap.name,
        otherKey
          ? `Mark "${candidate!.name}" as the date table. It already has key column "${otherKey.name}", which is left unchanged; a date table needs the date column "${dateCol!.name}" as its key, so do this in the model yourself if you want it.`
          : candidate
            ? `Mark "${candidate.name}" as the date table.`
            : 'Add a marked date table.',
        auto ? 'mark-date-table' : 'manual',
        auto ? { table: candidate!.name, name: dateCol!.name } : undefined,
      ),
    ],
  };
};

const FND005: Impl = (ctx) => {
  const keyLike = ctx.columns.filter(
    (x) =>
      x.column.dataType !== 'dateTime' &&
      (x.column.isKey || isKeyLikeName(x.column.name) || (ctx.relCols.has(`${x.table.name}\u0000${x.column.name}`) && isKeyLikeName(x.column.name))),
  );
  const allKeyLike = ctx.snap.tables
    .filter((t) => !t.isHidden)
    .flatMap((t) => t.columns.filter((c) => c.dataType !== 'dateTime' && (c.isKey || isKeyLikeName(c.name))));
  if (allKeyLike.length === 0) return { score: null, evidence: 'No key-like columns.', findings: [] };
  const findings = keyLike.map((x) =>
    finding(
      'FND-005',
      'column',
      colPath(x.table.name, x.column.name),
      'Technical key column is visible.',
      'hide-object',
      { table: x.table.name, name: x.column.name, type: 'column' },
    ),
  );
  return {
    score: 1 - keyLike.length / allKeyLike.length,
    evidence: `${keyLike.length} of ${allKeyLike.length} key-like column(s) are visible.`,
    findings,
  };
};

const FND006: Impl = (ctx) => {
  if (ctx.measures.length === 0) return { score: null, evidence: 'No visible measures.', findings: [] };
  const missing = ctx.measures.filter((x) => !x.measure.formatString);
  const findings = missing.map((x) =>
    finding('FND-006', 'measure', measurePath(x.table.name, x.measure.name), 'Measure has no format string.', 'set-format-string', {
      table: x.table.name,
      name: x.measure.name,
    }),
  );
  return {
    score: 1 - missing.length / ctx.measures.length,
    evidence: `${missing.length} of ${ctx.measures.length} visible measure(s) have no format string.`,
    findings,
  };
};

const FND007: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Relationships not available.', findings: [] };
  const rels = ctx.snap.relationships;
  if (rels.length === 0) return { score: null, evidence: 'No relationships.', findings: [] };
  const bad = rels.filter(
    (r) => r.crossFilter === 'both' || !r.isActive || (r.fromCardinality === 'many' && r.toCardinality === 'many'),
  );
  const findings = bad.map((r) =>
    finding(
      'FND-007',
      'relationship',
      `${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}`,
      r.crossFilter === 'both' ? 'Bi-directional relationship.' : !r.isActive ? 'Inactive relationship.' : 'Many-to-many relationship.',
      'manual',
    ),
  );
  return {
    score: 1 - bad.length / rels.length,
    evidence: `${bad.length} of ${rels.length} relationship(s) are bi-directional, inactive or many-to-many.`,
    findings,
  };
};

const FND008: Impl = (ctx) => {
  const fields = ctx.columns.length + ctx.measures.length;
  let score = 1;
  if (fields > 150) score = Math.max(0.2, 1 - (fields - 150) / 350);
  const findings: Finding[] = [];
  if (score < 1) {
    findings.push(
      finding(
        'FND-008',
        'model',
        ctx.snap.name,
        `${fields} visible fields are in AI scope; hide unused fields or scope the AI data schema.`,
        'set-ai-visibility',
      ),
    );
  }
  return { score, evidence: `${fields} visible field(s) in AI scope.`, findings };
};

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const NAM001: Impl = (ctx) => {
  if (ctx.tables.length === 0) return { score: null, evidence: 'No visible tables.', findings: [] };
  const bad = ctx.tables.filter((t) => isTechnicalTableName(t.name));
  const findings = bad.map((t) =>
    finding('NAM-001', 'table', t.name, `Table name "${t.name}" is technical.`, 'manual', { table: t.name }),
  );
  return {
    score: 1 - bad.length / ctx.tables.length,
    evidence: `${bad.length} of ${ctx.tables.length} visible table name(s) are technical.`,
    findings,
  };
};

const NAM002: Impl = (ctx) => {
  const total = ctx.columns.length + ctx.measures.length;
  if (total === 0) return { score: null, evidence: 'No visible fields.', findings: [] };
  const findings: Finding[] = [];
  let bad = 0;
  for (const x of ctx.columns) {
    if (!isFriendlyName(x.column.name)) {
      bad += 1;
      findings.push(
        finding('NAM-002', 'column', colPath(x.table.name, x.column.name), `Column name "${x.column.name}" is not business-friendly.`, 'manual', {
          table: x.table.name,
          name: x.column.name,
        }),
      );
    }
  }
  for (const x of ctx.measures) {
    if (!isFriendlyName(x.measure.name)) {
      bad += 1;
      findings.push(
        finding('NAM-002', 'measure', measurePath(x.table.name, x.measure.name), `Measure name "${x.measure.name}" is not business-friendly.`, 'manual', {
          table: x.table.name,
          name: x.measure.name,
        }),
      );
    }
  }
  return { score: 1 - bad / total, evidence: `${bad} of ${total} visible field name(s) are not business-friendly.`, findings };
};

const NAM003: Impl = (ctx) => {
  const total = ctx.tables.length + ctx.columns.length + ctx.measures.length;
  if (total === 0) return { score: null, evidence: 'No visible objects.', findings: [] };
  const findings: Finding[] = [];
  let bad = 0;
  for (const t of ctx.tables) {
    const a = abbreviationsIn(t.name).filter((x) => x !== 'dim' && x !== 'fct' && x !== 'tbl');
    if (a.length) {
      bad += 1;
      findings.push(finding('NAM-003', 'table', t.name, `Abbreviation(s) in table name: ${a.join(', ')}.`, 'manual', { table: t.name }));
    }
  }
  for (const x of ctx.columns) {
    const a = abbreviationsIn(x.column.name);
    if (a.length) {
      bad += 1;
      findings.push(
        finding('NAM-003', 'column', colPath(x.table.name, x.column.name), `Abbreviation(s): ${a.join(', ')}.`, 'manual', {
          table: x.table.name,
          name: x.column.name,
        }),
      );
    }
  }
  for (const x of ctx.measures) {
    const a = abbreviationsIn(x.measure.name);
    if (a.length) {
      bad += 1;
      findings.push(
        finding('NAM-003', 'measure', measurePath(x.table.name, x.measure.name), `Abbreviation(s): ${a.join(', ')}.`, 'manual', {
          table: x.table.name,
          name: x.measure.name,
        }),
      );
    }
  }
  return { score: 1 - bad / total, evidence: `${bad} of ${total} visible name(s) contain abbreviations.`, findings };
};

const NAM004: Impl = (ctx) => {
  if (ctx.columns.length === 0) return { score: null, evidence: 'No visible columns.', findings: [] };
  const byName = new Map<string, ScopedColumn[]>();
  for (const x of ctx.columns) {
    if (x.column.isKey || isKeyLikeName(x.column.name)) continue;
    const k = x.column.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), x]);
  }
  const dups = [...byName.values()].filter((v) => new Set(v.map((x) => x.table.name)).size > 1).flat();
  const findings = dups.map((x) =>
    finding('NAM-004', 'column', colPath(x.table.name, x.column.name), `Column name "${x.column.name}" also exists in another table.`, 'manual', {
      table: x.table.name,
      name: x.column.name,
    }),
  );
  return {
    score: 1 - Math.min(1, (dups.length / ctx.columns.length) * 2),
    evidence: `${dups.length} column(s) share a visible name with a column in another table.`,
    findings,
  };
};

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

const hasText = (s: string | undefined) => !!s && s.trim().length > 0;

const DSC001: Impl = (ctx) => {
  if (ctx.tables.length === 0) return { score: null, evidence: 'No visible tables.', findings: [] };
  const missing = ctx.tables.filter((t) => !hasText(t.description));
  const findings = missing.map((t) =>
    finding('DSC-001', 'table', t.name, 'Table has no description.', 'add-description', { table: t.name }),
  );
  return {
    score: 1 - missing.length / ctx.tables.length,
    evidence: `${ctx.tables.length - missing.length} of ${ctx.tables.length} visible table(s) have a description (${pct(ctx.tables.length - missing.length, ctx.tables.length)}%).`,
    findings,
  };
};

const DSC002: Impl = (ctx) => {
  if (ctx.measures.length === 0) return { score: null, evidence: 'No visible measures.', findings: [] };
  const missing = ctx.measures.filter((x) => !hasText(x.measure.description));
  const findings = missing.map((x) =>
    finding('DSC-002', 'measure', measurePath(x.table.name, x.measure.name), 'Measure has no description.', 'add-description', {
      table: x.table.name,
      name: x.measure.name,
    }),
  );
  return {
    score: 1 - missing.length / ctx.measures.length,
    evidence: `${ctx.measures.length - missing.length} of ${ctx.measures.length} visible measure(s) have a description (${pct(ctx.measures.length - missing.length, ctx.measures.length)}%).`,
    findings,
  };
};

const DSC003: Impl = (ctx) => {
  if (ctx.columns.length === 0) return { score: null, evidence: 'No visible columns.', findings: [] };
  const missing = ctx.columns.filter((x) => !hasText(x.column.description));
  const findings = missing.map((x) =>
    finding('DSC-003', 'column', colPath(x.table.name, x.column.name), 'Column has no description.', 'add-description', {
      table: x.table.name,
      name: x.column.name,
    }),
  );
  return {
    score: 1 - missing.length / ctx.columns.length,
    evidence: `${ctx.columns.length - missing.length} of ${ctx.columns.length} visible column(s) have a description (${pct(ctx.columns.length - missing.length, ctx.columns.length)}%).`,
    findings,
  };
};

// Text quality helpers. The Python quick scorer (backend/notebooks/_shared.py) mirrors these exactly;
// backend/tests/test_parity.py keeps the two in step.

/** Whole-text placeholders: the description is nothing but one of these (punctuation ignored). */
const PLACEHOLDER_TEXTS = new Set([
  'tbd', 'tba', 'tbc', 'todo', 'to do', 'n/a', 'na', 'none', 'nil', 'null', 'lorem ipsum', 'description', 'desc',
  'description here', 'enter description', 'enter description here', 'add description', 'add description here',
  'your description here', 'to be defined', 'to be determined', 'to be completed', 'to be added', 'coming soon',
  'placeholder', 'test', 'testing', 'xxx', 'x',
]);
/** Placeholder phrases that make a description uninformative wherever they appear as whole words. */
const PLACEHOLDER_ANYWHERE =
  /\b(?:tbd|tba|tbc|lorem ipsum|placeholder|coming soon|x{3,}|to be (?:defined|determined|completed|added|filled in|updated|confirmed|decided|written|provided|documented))\b/i;
const PLACEHOLDER_LEADING = /^(?:todo|to do)\b/i;
/** Words that carry no information on their own; ignored when checking whether text restates a name. */
const STOP_WORDS = new Set([
  'the', 'of', 'a', 'an', 'for', 'is', 'are', 'this', 'that', 'these', 'those', 'each', 'every', 'and', 'or',
  'in', 'on', 'to', 'by', 'with', 'per', 'all', 'its', 'it', 'as', 'from', 'column', 'field', 'table', 'measure',
]);

/** Lower-cased words of a name or sentence: camelCase, snake_case and spaces all split the same way. */
export function wordsOf(text: string): string[] {
  return tokenize(text.replace(/['’]/g, '')).flatMap((t) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Folds simple plurals so "customers" and "customer" compare equal. */
export function foldWord(w: string): string {
  if (w.length > 3 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const contentWords = (text: string): string[] => wordsOf(text).filter((w) => !STOP_WORDS.has(w)).map(foldWord);

/** Normalised form used to spot the same boilerplate repeated across objects. */
export function normalizeDescription(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
}

export type DescriptionProblem = 'short' | 'placeholder' | 'restates-name' | 'duplicate';

export const DESCRIPTION_PROBLEM_MESSAGE: Record<DescriptionProblem, string> = {
  short: 'Description is too short to be useful.',
  placeholder: 'Description is a placeholder, not real documentation.',
  'restates-name': 'Description only restates the name.',
  duplicate: `The same description is repeated on ${DUPLICATE_DESCRIPTION_LIMIT} or more objects of this kind.`,
};

/**
 * Why a (non-empty) description is not informative, or null when it is. `duplicateCount` is how many objects of
 * the same kind in the model carry the same normalised text (1 = unique).
 */
export function descriptionProblem(name: string, description: string, duplicateCount = 1): DescriptionProblem | null {
  const d = description.trim();
  if (!/[\p{L}\p{N}]/u.test(d)) return 'placeholder';
  const plain = normalizeDescription(d.replace(/n\/a/gi, 'na'));
  if (PLACEHOLDER_TEXTS.has(plain) || PLACEHOLDER_ANYWHERE.test(d) || PLACEHOLDER_LEADING.test(d)) return 'placeholder';
  if (d.length < 15) return 'short';
  if (d.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, '')) return 'restates-name';
  if (d.split(/\s+/).length < 3) return 'short';
  const content = contentWords(d);
  if (content.length === 0) return 'placeholder';
  const nameWords = new Set(contentWords(name));
  if (content.every((w) => nameWords.has(w))) return 'restates-name';
  if (duplicateCount >= DUPLICATE_DESCRIPTION_LIMIT) return 'duplicate';
  return null;
}

export function isInformative(name: string, description: string, duplicateCount = 1): boolean {
  return descriptionProblem(name, description, duplicateCount) === null;
}

const DSC004: Impl = (ctx) => {
  type Item = { type: Finding['objectType']; path: string; name: string; desc: string; data: Record<string, unknown> };
  const items: Item[] = [];
  for (const t of ctx.tables)
    if (hasText(t.description)) items.push({ type: 'table', path: t.name, name: t.name, desc: t.description!, data: { table: t.name } });
  for (const x of ctx.columns)
    if (hasText(x.column.description))
      items.push({ type: 'column', path: colPath(x.table.name, x.column.name), name: x.column.name, desc: x.column.description!, data: { table: x.table.name, name: x.column.name } });
  for (const x of ctx.measures)
    if (hasText(x.measure.description))
      items.push({ type: 'measure', path: measurePath(x.table.name, x.measure.name), name: x.measure.name, desc: x.measure.description!, data: { table: x.table.name, name: x.measure.name } });
  if (items.length === 0) return { score: null, evidence: 'No descriptions to assess.', findings: [] };
  // One pass per model: how often each normalised text occurs per kind of object.
  const seen = new Map<string, number>();
  const keys = items.map((i) => `${i.type}\u0000${normalizeDescription(i.desc)}`);
  for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  const problems = items.map((i, idx) => descriptionProblem(i.name, i.desc, seen.get(keys[idx]!) ?? 1));
  const findings: Finding[] = [];
  items.forEach((i, idx) => {
    const p = problems[idx]!;
    if (p) findings.push(finding('DSC-004', i.type, i.path, DESCRIPTION_PROBLEM_MESSAGE[p], 'add-description', i.data));
  });
  const bad = findings.length;
  const long = items.filter((i) => i.desc.length > 200).length;
  return {
    score: 1 - bad / items.length,
    evidence: `${bad} of ${items.length} description(s) are not informative${long ? `; ${long} exceed 200 characters` : ''}.`,
    findings,
  };
};

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const INS001: Impl = (ctx) => {
  const text = ctx.snap.copilot.instructions;
  const ok = hasText(text);
  return {
    score: ok ? 1 : 0,
    evidence: ok ? `Instructions present (${text!.trim().length} characters).` : 'No AI instructions.',
    findings: ok ? [] : [finding('INS-001', 'copilot', 'Instructions', 'The model has no AI instructions.', 'set-instructions')],
  };
};

const INS002: Impl = (ctx) => {
  const text = (ctx.snap.copilot.instructions ?? '').trim();
  const len = text.length;
  if (len === 0)
    return { score: 0, evidence: 'No AI instructions.', findings: [] };
  if (len > INSTRUCTIONS_MAX)
    return {
      score: 0.5,
      evidence: `${len} characters; the limit is ${INSTRUCTIONS_MAX}.`,
      findings: [finding('INS-002', 'copilot', 'Instructions', `Instructions exceed ${INSTRUCTIONS_MAX} characters.`, 'set-instructions')],
    };
  if (len < INSTRUCTIONS_MIN)
    return {
      score: len / INSTRUCTIONS_MIN,
      evidence: `${len} characters; at least ${INSTRUCTIONS_MIN} recommended.`,
      findings: [finding('INS-002', 'copilot', 'Instructions', 'Instructions are very short.', 'set-instructions')],
    };
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const distinct = new Set(words).size;
  const ratio = words.length === 0 ? 0 : distinct / words.length;
  if (distinct < INSTRUCTIONS_MIN_DISTINCT_WORDS || ratio < INSTRUCTIONS_MIN_DISTINCT_RATIO)
    return {
      // Length alone is not enough: padded or repetitive text scores below the over-long case.
      score: 0.5 * Math.min(1, distinct / INSTRUCTIONS_MIN_DISTINCT_WORDS, ratio / INSTRUCTIONS_MIN_DISTINCT_RATIO),
      evidence: `${len} characters but only ${distinct} distinct word(s) (${Math.round(ratio * 100)}% of ${words.length}); at least ${INSTRUCTIONS_MIN_DISTINCT_WORDS} distinct words and ${Math.round(INSTRUCTIONS_MIN_DISTINCT_RATIO * 100)}% are expected.`,
      findings: [
        finding('INS-002', 'copilot', 'Instructions', 'Instructions are repetitive or padded; describe the business context, terminology and defaults in your own words.', 'set-instructions'),
      ],
    };
  return { score: 1, evidence: `${len} characters, ${distinct} distinct words.`, findings: [] };
};

const INS003_SECTIONS: { key: string; label: string; re: RegExp }[] = [
  { key: 'context', label: 'business context', re: /\b(context|domain|purpose|this model|you are|about)\b/i },
  { key: 'terminology', label: 'terminology / glossary', re: /\b(terminology|glossary|term|means|refers to|defined as|synonym)\b/i },
  { key: 'defaults', label: 'defaults (time frame, filters)', re: /\b(default|by default|time frame|timeframe|fiscal|unless|current year|latest)\b/i },
  { key: 'measures', label: 'preferred measures', re: /\b(measure|prefer|always use|use the)\b/i },
];

interface InstructionSection {
  heading: string;
  body: string[];
}

const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
const BULLET_LINE = /^\s*(?:[-*\u2022+]|\d+[.)])\s+(.*\S)\s*$/;

/** A heading is a markdown heading, a bold-only line, or a short line without sentence punctuation. */
function headingOf(line: string): string | null {
  const md = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (md) return md[1]!;
  if (BULLET_LINE.test(line)) return null;
  const plain = line.trim().replace(/^(\*\*|__)(.*)\1:?$/, '$2').replace(/:$/, '').trim();
  if (plain.length === 0 || /[.!?;,]$/.test(plain)) return null;
  const n = wordCount(plain);
  return n >= 1 && n <= 5 ? plain : null;
}

function splitInstructionSections(text: string): InstructionSection[] {
  const sections: InstructionSection[] = [{ heading: '', body: [] }];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const h = headingOf(line);
    if (h !== null) sections.push({ heading: h, body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  return sections;
}

/** A topic counts only when its keyword sits in a heading with real content below it, or is followed by enough words. */
function coversTopic(sections: InstructionSection[], re: RegExp): boolean {
  for (const s of sections) {
    const body = s.body.join('\n');
    const bullets = s.body.filter((l) => BULLET_LINE.test(l)).length;
    const hasContent = wordCount(body) >= INSTRUCTIONS_SECTION_MIN_WORDS || bullets >= 2;
    if (s.heading && re.test(s.heading) && hasContent) return true;
    const m = re.exec(body);
    if (m && wordCount(body.slice(m.index + m[0].length)) >= INSTRUCTIONS_SECTION_MIN_WORDS) return true;
  }
  return false;
}

const INS003: Impl = (ctx) => {
  const text = ctx.snap.copilot.instructions;
  if (!hasText(text)) return { score: 0, evidence: 'No AI instructions.', findings: [] };
  const sections = splitInstructionSections(text!);
  const hit = INS003_SECTIONS.filter((s) => coversTopic(sections, s.re));
  const miss = INS003_SECTIONS.filter((s) => !hit.includes(s));
  return {
    score: hit.length / INS003_SECTIONS.length,
    evidence: `Covers ${hit.length} of ${INS003_SECTIONS.length} recommended topics${miss.length ? ` (missing or too thin: ${miss.map((m) => m.label).join(', ')})` : ''}.`,
    findings: miss.map((m) =>
      finding('INS-003', 'copilot', 'Instructions', `Instructions do not cover ${m.label} with real content (a heading alone does not count).`, 'set-instructions', { missing: m.key }),
    ),
  };
};

const INS004: Impl = (ctx) => {
  const text = ctx.snap.copilot.instructions;
  if (!hasText(text) || !ctx.deep) return { score: null, evidence: 'Nothing to validate.', findings: [] };
  const names = new Set<string>();
  for (const t of ctx.snap.tables) {
    names.add(t.name.toLowerCase());
    t.columns.forEach((c) => names.add(c.name.toLowerCase()));
    t.measures.forEach((m) => names.add(m.name.toLowerCase()));
  }
  const refs = new Set<string>();
  for (const m of text!.matchAll(/\[([^\]\n]{2,80})\]/g)) refs.add(m[1]!.trim());
  for (const m of text!.matchAll(/`([^`\n]{2,80})`/g)) refs.add(m[1]!.trim());
  const checked = [...refs].filter((r) => !/^(x|y|\d+)$/i.test(r) && !r.includes('http'));
  if (checked.length === 0) return { score: null, evidence: 'Instructions do not reference model objects explicitly.', findings: [] };
  const stale = checked.filter((r) => !names.has(r.toLowerCase().replace(/^.*\./, '')) && !names.has(r.toLowerCase()));
  return {
    score: 1 - stale.length / checked.length,
    evidence: `${stale.length} of ${checked.length} referenced object(s) do not exist.`,
    findings: stale.map((r) => finding('INS-004', 'copilot', 'Instructions', `Instructions reference "${r}" which is not in the model.`, 'set-instructions', { reference: r })),
  };
};

// ---------------------------------------------------------------------------
// AI data schema
// ---------------------------------------------------------------------------

const SCH001: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Copilot parts not available.', findings: [] };
  if (!ctx.snap.copilot.hasSchema)
    return {
      score: 0,
      evidence: 'No AI data schema defined.',
      findings: [finding('SCH-001', 'copilot', 'Schema', 'No AI data schema; all visible fields are exposed.', 'set-ai-visibility')],
    };
  const keyLike = ctx.snap.tables
    .filter((t) => !t.isHidden)
    .flatMap((t) => t.columns.filter((c) => !c.isHidden && c.dataType !== 'dateTime' && (c.isKey || isKeyLikeName(c.name))).map((c) => ({ t, c })));
  const exposed = keyLike.filter(({ c }) => c.aiVisibility !== 'Hidden');
  const scope = keyLike.length === 0 ? 1 : 1 - exposed.length / keyLike.length;
  return {
    score: 0.6 + 0.4 * scope,
    evidence: `AI data schema defined; ${exposed.length} technical key column(s) still exposed.`,
    findings: exposed.map(({ t, c }) =>
      finding('SCH-001', 'column', colPath(t.name, c.name), 'Technical key column is exposed to AI.', 'set-ai-visibility', { table: t.name, name: c.name, type: 'column' }),
    ),
  };
};

const SCH004: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Copilot parts not available.', findings: [] };
  const v = ctx.snap.copilot.indexingEnabled;
  if (v === true) return { score: 1, evidence: 'Value indexing is enabled.', findings: [] };
  return {
    score: v === false ? 0 : 0.5,
    evidence: v === false ? 'Value indexing is disabled.' : 'Value indexing is not configured.',
    findings: [finding('SCH-004', 'copilot', 'Settings', 'Enable value indexing.', 'set-indexing')],
  };
};

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

const EXM001: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Copilot parts not available.', findings: [] };
  const n = ctx.snap.copilot.examplePrompts.length;
  return {
    score: Math.min(1, n / 3),
    evidence: `${n} example prompt(s).`,
    findings: n >= 3 ? [] : [finding('EXM-001', 'copilot', 'ExamplePrompts', `Only ${n} example prompt(s); add at least 3.`, 'set-example-prompts')],
  };
};

const EXM002: Impl = (ctx) => {
  if (!ctx.deep) return { score: null, evidence: 'Copilot parts not available.', findings: [] };
  const n = ctx.snap.copilot.verifiedAnswerCount;
  return {
    score: n > 0 ? 1 : 0,
    evidence: `${n} verified answer(s).`,
    findings: n > 0 ? [] : [finding('EXM-002', 'copilot', 'VerifiedAnswers', 'No verified answers configured.', 'manual')],
  };
};

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

const GOV001: Impl = (ctx) => {
  const q = ctx.snap.governance.qnaEnabled;
  if (q === undefined || q === null) return { score: null, evidence: 'Q&A state unknown.', findings: [] };
  return {
    score: q ? 1 : 0,
    evidence: q ? 'Q&A is enabled.' : 'Q&A is disabled.',
    findings: q ? [] : [finding('GOV-001', 'model', ctx.snap.name, 'Q&A is disabled on the model.', 'set-qna')],
  };
};

const GOV002: Impl = (ctx) => {
  const a = ctx.snap.governance.approvedForCopilot;
  if (a === undefined || a === null) return { score: null, evidence: 'Approved-for-Copilot state unknown.', findings: [] };
  return {
    score: a ? 1 : 0,
    evidence: a ? 'Approved for Copilot.' : 'Not approved for Copilot.',
    findings: a ? [] : [finding('GOV-002', 'model', ctx.snap.name, 'Model is not approved for Copilot.', 'manual')],
  };
};

const GOV003: Impl = (ctx) => {
  const e = ctx.snap.governance.endorsement;
  if (e === undefined || e === null) return { score: null, evidence: 'Endorsement unknown.', findings: [] };
  const score = e === 'Certified' || e === 'MasterData' ? 1 : e === 'Promoted' ? 0.8 : 0;
  return {
    score,
    evidence: `Endorsement: ${e}.`,
    findings: score >= 0.8 ? [] : [finding('GOV-003', 'model', ctx.snap.name, 'Model is not endorsed.', 'manual')],
  };
};

const IMPLS: Record<string, Impl> = {
  'FND-001': FND001,
  'FND-002': FND002,
  'FND-003': FND003,
  'FND-004': FND004,
  'FND-005': FND005,
  'FND-006': FND006,
  'FND-007': FND007,
  'FND-008': FND008,
  'NAM-001': NAM001,
  'NAM-002': NAM002,
  'NAM-003': NAM003,
  'NAM-004': NAM004,
  'DSC-001': DSC001,
  'DSC-002': DSC002,
  'DSC-003': DSC003,
  'DSC-004': DSC004,
  'INS-001': INS001,
  'INS-002': INS002,
  'INS-003': INS003,
  'INS-004': INS004,
  'SCH-001': SCH001,
  'SCH-004': SCH004,
  'EXM-001': EXM001,
  'EXM-002': EXM002,
  'GOV-001': GOV001,
  'GOV-002': GOV002,
  'GOV-003': GOV003,
};

export function evaluateRules(snap: ModelSnapshot, opts: EvaluateOptions = {}): RuleResult[] {
  const ctx = buildCtx(snap);
  return CATALOG.rules.map((rule): RuleResult => {
    const ext = opts.external?.[rule.id];
    if (ext) {
      return { ruleId: rule.id, score: ext.score, evidence: ext.evidence, findings: (ext.findings ?? []).slice(0, MAX_FINDINGS) };
    }
    if (rule.deepOnly && !ctx.deep) {
      return { ruleId: rule.id, score: null, evidence: 'Requires the full model definition (deep scan).', findings: [] };
    }
    const impl = IMPLS[rule.id];
    if (!impl) {
      // Rules without a deterministic implementation (LLM judge) are only scored when supplied externally.
      return { ruleId: rule.id, score: null, evidence: 'Not evaluated.', findings: [] };
    }
    const r = impl(ctx);
    return {
      ruleId: rule.id,
      score: r.score === null ? null : Math.max(0, Math.min(1, r.score)),
      evidence: r.evidence,
      findings: r.findings.slice(0, MAX_FINDINGS),
    };
  });
}

