import {
  llmDescriptions,
  llmExamplePrompts,
  llmInstructions,
  type DescribeTarget,
  type LlmClient,
} from './llm.js';
import { humanize, isKeyLikeName } from './names.js';
import { applyChanges } from './patch.js';
import { scoreModel } from './score.js';
import { buildSnapshot } from './snapshot.js';
import type {
  BusinessContext,
  Change,
  DefinitionParts,
  Finding,
  FixProposal,
  GovernanceInfo,
  MeasureInfo,
  ModelSnapshot,
  ObjectRef,
  ScoreResult,
  TableInfo,
} from './types.js';
import { INSTRUCTIONS_MAX } from './rules.js';

export interface ProposeInput {
  parts: DefinitionParts;
  name?: string;
  governance?: GovernanceInfo;
  context?: BusinessContext;
  /** Optional LLM; when it fails or is absent, deterministic templates are used. */
  llm?: LlmClient;
  newId?: () => string;
}

export interface ProposeOutput {
  snapshot: ModelSnapshot;
  score: ScoreResult;
  proposals: FixProposal[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

function plural(word: string): string {
  if (/s$/i.test(word)) return word;
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

type Role = 'fact' | 'dimension' | 'date' | 'unknown';

function tableRole(snap: ModelSnapshot, t: TableInfo): Role {
  if ((t.dataCategory ?? '').toLowerCase() === 'time') return 'date';
  const asMany = snap.relationships.some((r) => r.fromTable === t.name && r.fromCardinality === 'many');
  const asOne = snap.relationships.some((r) => r.toTable === t.name && r.toCardinality === 'one');
  if (asMany && !asOne) return 'fact';
  if (asOne && !asMany) return /^(date|calendar)/i.test(humanize(t.name, 'table')) || t.columns.some((c) => c.dataType === 'dateTime') && t.columns.length <= 8 && !t.measures.length && /date|calendar/i.test(t.name) ? 'date' : 'dimension';
  return 'unknown';
}

const trim = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const list = (xs: string[], max = 4) => xs.slice(0, max).join(', ');

// A hidden table has only hidden columns to talk about, so they are all it can be described by.
function visibleCols(t: TableInfo) {
  return t.isHidden ? t.columns : t.columns.filter((c) => !c.isHidden);
}

function templateTableDescription(snap: ModelSnapshot, t: TableInfo): string {
  const h = humanize(t.name, 'table');
  const role = tableRole(snap, t);
  const attrs = visibleCols(t).filter((c) => !c.isKey && !isKeyLikeName(c.name)).map((c) => humanize(c.name));
  const attrList = attrs.length > 0 ? ` (${list(attrs)})` : '';
  if (role === 'date') return trim(`Calendar of dates for time analysis; use it to group or filter by ${list(attrs.filter((a) => a !== 'Date'), 4) || 'year, quarter and month'}.`);
  if (role === 'dimension') return trim(`${h} reference data${attrList}. Use it to filter or group measures by ${h.toLowerCase()}.`);
  if (role === 'fact') {
    const nums = visibleCols(t).filter((c) => (c.dataType === 'int64' || c.dataType === 'double' || c.dataType === 'decimal') && !isKeyLikeName(c.name)).map((c) => humanize(c.name));
    const dims = snap.relationships.filter((r) => r.fromTable === t.name).map((r) => humanize(r.toTable, 'table'));
    return trim(`${h} records, one row per transaction. Holds ${list(nums) || 'numeric values'}; related to ${list([...new Set(dims)]) || 'other tables'}.`);
  }
  return trim(`${h} data with ${t.columns.length} fields${attrList}.`);
}

function stripTablePrefix(colH: string, tableH: string): string {
  const lower = colH.toLowerCase();
  const tl = tableH.toLowerCase();
  if (lower.startsWith(tl + ' ') && colH.length > tl.length + 1) return colH.slice(tl.length + 1);
  return colH;
}

function templateColumnDescription(t: TableInfo, c: TableInfo['columns'][number]): string {
  const th = humanize(t.name, 'table');
  const ch = humanize(c.name);
  const short = stripTablePrefix(ch, th);
  if (isKeyLikeName(c.name) || c.isKey) return trim(`Technical key of the ${th.toLowerCase()} used to join related tables; not meant for analysis.`);
  if (c.dataType === 'dateTime') return trim(`${short === ch ? ch : short} of each ${th.toLowerCase()} record; use for time-based analysis.`);
  if (c.dataType === 'string') return trim(`${short} of each ${th.toLowerCase()}.`);
  const unit = /pct|percent|rate|disc/i.test(c.name) ? ' as a fraction between 0 and 1' : /amt|amount|cost|price|prc|rev|sales/i.test(c.name) ? ' in currency units' : /qty|quantity|cnt|count/i.test(c.name) ? ' in units' : '';
  return trim(`${ch} for each ${th.toLowerCase()} record${unit}.`);
}

function prettyExpression(expr: string): string {
  return expr
    .replace(/(?:'[^']+'|\w+)\[([^\]]+)\]/g, (_m, col: string) => humanize(col))
    .replace(/\s+/g, ' ')
    .trim();
}

function templateMeasureDescription(t: TableInfo, m: MeasureInfo): string {
  const th = humanize(t.name, 'table').toLowerCase();
  const e = m.expression.trim();
  const simple = /^(SUM|AVERAGE|MIN|MAX|COUNT|DISTINCTCOUNT)\s*\(\s*(?:'[^']+'|\w+)\[([^\]]+)\]\s*\)$/i.exec(e);
  if (simple) {
    const col = humanize(simple[2]!);
    switch (simple[1]!.toUpperCase()) {
      case 'SUM':
        return trim(`Total ${col} summed across ${th} records; responds to filters on related tables.`);
      case 'AVERAGE':
        return trim(`Average ${col} across ${th} records; responds to filters on related tables.`);
      case 'MIN':
        return trim(`Lowest ${col} across ${th} records.`);
      case 'MAX':
        return trim(`Highest ${col} across ${th} records.`);
      case 'DISTINCTCOUNT':
        return trim(`Number of distinct ${col} values across ${th} records.`);
      default:
        return trim(`Count of ${col} values across ${th} records.`);
    }
  }
  if (/^COUNTROWS\s*\(/i.test(e)) return trim(`Number of ${th} records in the current filter context.`);
  if (/^DIVIDE\s*\(/i.test(e)) return trim(`${humanize(m.name, 'measure')}: ratio calculated as ${prettyExpression(e)}.`);
  return trim(`${humanize(m.name, 'measure')}: calculated as ${prettyExpression(e)}.`);
}

function inferFormatString(m: MeasureInfo): string {
  const name = m.name;
  if (/(pct|percent|%|ratio|rate|share)/i.test(name)) return '0.0%';
  if (/(count|qty|quantity|units|^num|number of)/i.test(name) || /^(COUNTROWS|DISTINCTCOUNT|COUNT)\s*\(/i.test(m.expression.trim())) return '#,0';
  return '#,0.00';
}

// ---------------------------------------------------------------------------
// Targets from findings
// ---------------------------------------------------------------------------

function refOf(f: Finding): ObjectRef | undefined {
  const d = (f.data ?? {}) as { table?: string; name?: string };
  if (f.objectType === 'table') return { type: 'table', table: d.table ?? f.objectPath };
  if ((f.objectType === 'column' || f.objectType === 'measure') && d.table && d.name) {
    return { type: f.objectType, table: d.table, name: d.name };
  }
  return undefined;
}

const keyOf = (r: ObjectRef) => `${r.type}:${r.table}${r.name ? `|${r.name}` : ''}`;

// Power BI generates and owns these auto date/time tables.
const SYSTEM_TABLE = /^(LocalDateTable|DateTableTemplate)_/i;

/**
 * Every table, column and measure without a description, hidden ones included. Only the visible ones are scored, but
 * the hidden ones are described too so the whole model is documented for the people who maintain it.
 */
function undescribedRefs(snap: ModelSnapshot): ObjectRef[] {
  const blank = (s: string | undefined) => !s || s.trim().length === 0;
  const refs: ObjectRef[] = [];
  for (const t of snap.tables) {
    if (SYSTEM_TABLE.test(t.name)) continue;
    if (blank(t.description)) refs.push({ type: 'table', table: t.name });
    for (const c of t.columns) if (blank(c.description)) refs.push({ type: 'column', table: t.name, name: c.name });
    for (const m of t.measures) if (blank(m.description)) refs.push({ type: 'measure', table: t.name, name: m.name });
  }
  return refs;
}

function uniqueRefs(findings: Finding[]): ObjectRef[] {
  const seen = new Map<string, ObjectRef>();
  for (const f of findings) {
    const r = refOf(f);
    if (r) seen.set(keyOf(r), r);
  }
  return [...seen.values()];
}

function lookup(snap: ModelSnapshot, r: ObjectRef) {
  const t = snap.tables.find((x) => x.name === r.table);
  if (!t) return undefined;
  if (r.type === 'table') return { table: t };
  if (r.type === 'column') {
    const c = t.columns.find((x) => x.name === r.name);
    return c ? { table: t, column: c } : undefined;
  }
  const m = t.measures.find((x) => x.name === r.name);
  return m ? { table: t, measure: m } : undefined;
}

function isHiddenRef(snap: ModelSnapshot, r: ObjectRef): boolean {
  const l = lookup(snap, r);
  if (!l) return false;
  return l.table.isHidden || ('column' in l && !!l.column?.isHidden) || ('measure' in l && !!l.measure?.isHidden);
}

function toTarget(snap: ModelSnapshot, r: ObjectRef, existing?: string): DescribeTarget | undefined {
  const l = lookup(snap, r);
  if (!l) return undefined;
  return {
    id: keyOf(r),
    type: r.type,
    table: r.table,
    name: r.name,
    dataType: 'column' in l ? l.column?.dataType : undefined,
    expression: 'measure' in l ? l.measure?.expression : undefined,
    existing,
    hidden: isHiddenRef(snap, r) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Instructions + examples (template)
// ---------------------------------------------------------------------------

export function templateInstructions(snap: ModelSnapshot, ctx: BusinessContext = {}): string {
  const visibleTables = snap.tables.filter((t) => !t.isHidden);
  const measures = snap.tables.flatMap((t) => t.measures.filter((m) => !m.isHidden).map((m) => ({ t, m })));
  const lines: string[] = [];
  lines.push(`# AI instructions for ${snap.name}`, '');
  lines.push('## Business context');
  const description = ctx.description?.trim().slice(0, 4000);
  if (!description || ctx.domain || ctx.audience) {
    lines.push(
      `- This model supports ${ctx.domain ? `${ctx.domain} analysis` : 'business analysis'}${ctx.audience ? ` for ${ctx.audience}` : ''}.`,
    );
  }
  // The owner's own words go in verbatim: a template cannot interpret them, but it must not drop them.
  if (description) {
    for (const raw of description.split(/\r?\n/)) {
      const line = raw.replace(/^\s*[-*•]\s*/, '').trim();
      if (line) lines.push(`- ${line}`);
    }
  }
  for (const t of visibleTables.slice(0, 12)) {
    const role = tableRole(snap, t);
    const d = t.description ?? templateTableDescription(snap, t);
    lines.push(`- \`${t.name}\` (${role === 'unknown' ? 'table' : role}): ${d}`);
  }
  if (ctx.notes) lines.push(`- ${ctx.notes}`);
  lines.push('', '## Terminology');
  const glossary = ctx.glossary ?? [];
  for (const g of glossary.slice(0, 20)) lines.push(`- "${g.term}" means ${g.meaning}.`);
  if (glossary.length === 0) lines.push('- Use the business names of tables, columns and measures as written in the model.');
  lines.push('', '## Defaults');
  lines.push(
    `- Default time frame: ${ctx.defaultTimeFrame ?? (description ? 'the period given in the business context above, otherwise the most recent complete year in the data, unless the user names another period' : 'the most recent complete year in the data, unless the user names another period')}.`,
  );
  if (ctx.fiscalYearStart) lines.push(`- The fiscal year starts in ${ctx.fiscalYearStart}.`);
  const dateTable = snap.tables.find((t) => tableRole(snap, t) === 'date');
  if (dateTable) lines.push(`- Use the \`${dateTable.name}\` table for every time-based question (year, quarter, month, day).`);
  lines.push('- When the user does not name a filter, do not apply any extra filter.');
  lines.push('', '## Preferred measures');
  lines.push('- Always answer with an explicit measure instead of summing a raw numeric column.');
  const preferred = ctx.preferredMeasures?.length ? ctx.preferredMeasures : measures.map(({ m }) => m.name);
  for (const name of preferred.slice(0, 20)) {
    const found = measures.find(({ m }) => m.name === name);
    const desc = found ? (found.m.description ?? templateMeasureDescription(found.t, found.m)) : '';
    lines.push(`- Use [${name}] for ${humanize(name, 'measure').toLowerCase()}${desc ? ` - ${desc}` : ''}`);
  }
  lines.push('', '## Data notes');
  lines.push('- Technical key and ID columns are hidden and must not be used to answer questions.');
  lines.push('- If a question cannot be answered with the available measures and fields, say so instead of guessing.');
  let text = lines.join('\n');
  if (text.length > INSTRUCTIONS_MAX - 500) text = text.slice(0, INSTRUCTIONS_MAX - 500);
  return text + '\n';
}

export function templateExamplePrompts(snap: ModelSnapshot): string[] {
  const measures = snap.tables.flatMap((t) => t.measures.filter((m) => !m.isHidden));
  const m1 = measures[0] ? humanize(measures[0].name, 'measure') : undefined;
  const m2 = measures[1] ? humanize(measures[1].name, 'measure') : undefined;
  const dims = snap.tables
    .filter((t) => !t.isHidden && tableRole(snap, t) === 'dimension')
    .map((t) => ({ table: humanize(t.name, 'table'), attr: visibleCols(t).find((c) => c.dataType === 'string' && !isKeyLikeName(c.name)) }))
    .filter((d) => d.attr);
  const hasDate = snap.tables.some((t) => tableRole(snap, t) === 'date');
  const out: string[] = [];
  if (!m1) return out;
  if (dims[0]) out.push(`What is ${m1} by ${humanize(dims[0].attr!.name)}?`);
  if (dims[0]) out.push(`Top 5 ${plural(dims[0].table)} by ${m1}`);
  if (hasDate) out.push(`Show ${m1} by month`);
  if (m2 && dims[1]) out.push(`Compare ${m1} and ${m2} by ${humanize(dims[1].attr!.name)}`);
  if (dims[0]) out.push(`Which ${dims[0].table.toLowerCase()} has the highest ${m1}?`);
  if (out.length < 3) out.push(`What is the total ${m1}?`, `How did ${m1} change over time?`, `Break down ${m1} by the available categories`);
  return [...new Set(out)].slice(0, 6);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export async function proposeFixes(input: ProposeInput): Promise<ProposeOutput> {
  const snap = buildSnapshot(input.parts, { name: input.name, governance: input.governance });
  const score = scoreModel(snap);
  const notes: string[] = [];
  const proposals: FixProposal[] = [];
  const byRule = (...ids: string[]) => score.findings.filter((f) => ids.includes(f.ruleId));
  const ctx = input.context;
  const llm = input.llm;
  let llmFailed = false;

  async function tryLlm<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (!llm || llmFailed) return undefined;
    try {
      return await fn();
    } catch (e) {
      llmFailed = true;
      notes.push(`LLM unavailable for ${label} (${(e as Error).message}); used deterministic templates instead.`);
      return undefined;
    }
  }

  const add = (p: Omit<FixProposal, 'estimatedGain'>) => {
    if (p.changes.length > 0) proposals.push(p);
  };

  // --- Q&A --------------------------------------------------------------
  if (snap.governance.qnaEnabled === false) {
    add({
      id: 'fix:enable-qna',
      ruleIds: ['GOV-001'],
      title: 'Turn on Q&A',
      summary: 'Enable Q&A on the model so Prep data for AI settings take effect.',
      risk: 'low',
      requiresReview: false,
      generatedBy: 'rule',
      changes: [{ op: 'setQna', value: true }],
    });
  }

  // --- Starter measures ---------------------------------------------------
  const measureFindings = byRule('FND-001');
  if (measureFindings.length > 0) {
    const used = new Set<string>();
    for (const t of snap.tables) for (const m of t.measures) for (const mm of m.expression.matchAll(/\[([^\]]+)\]/g)) used.add(mm[1]!.toLowerCase());
    const existingNames = new Set(snap.tables.flatMap((t) => t.measures.map((m) => m.name.toLowerCase())));
    const changes: Change[] = [];
    for (const t of snap.tables.filter((x) => !x.isHidden && tableRole(snap, x) === 'fact')) {
      const tref = /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name) ? t.name : `'${t.name.replace(/'/g, "''")}'`;
      for (const c of t.columns) {
        if (!(c.dataType === 'int64' || c.dataType === 'double' || c.dataType === 'decimal')) continue;
        if (c.isKey || isKeyLikeName(c.name) || used.has(c.name.toLowerCase())) continue;
        const ratio = /pct|percent|rate|price|prc/i.test(c.name);
        const fn = ratio ? 'AVERAGE' : 'SUM';
        const name = `${ratio ? 'Average' : 'Total'} ${humanize(c.name)}`;
        if (existingNames.has(name.toLowerCase())) continue;
        const fmt = /pct|percent|rate/i.test(c.name) ? '0.0%' : /qty|quantity|cnt|count/i.test(c.name) ? '#,0' : '#,0.00';
        changes.push({
          op: 'addMeasure',
          table: t.name,
          name,
          expression: `${fn}(${tref}[${c.name}])`,
          formatString: fmt,
          description: `${ratio ? 'Average' : 'Total'} ${humanize(c.name)} across ${humanize(t.name, 'table').toLowerCase()} records; responds to filters on related tables.`,
        });
      }
      if (!existingNames.has(`${humanize(t.name, 'table').toLowerCase()} count`)) {
        changes.push({
          op: 'addMeasure',
          table: t.name,
          name: `${humanize(t.name, 'table')} Count`,
          expression: `COUNTROWS(${tref})`,
          formatString: '#,0',
          description: `Number of ${humanize(t.name, 'table').toLowerCase()} records in the current filter context.`,
        });
      }
    }
    add({
      id: 'fix:starter-measures',
      ruleIds: ['FND-001', 'GATE-NO-MEASURES'],
      title: 'Create starter measures',
      summary: `Add ${changes.length} explicit measure(s) (sums, averages and a row count) for the fact tables.`,
      risk: 'low',
      requiresReview: true,
      generatedBy: 'template',
      changes,
    });
  }

  // --- Hide technical keys --------------------------------------------------
  const keyFindings = byRule('FND-005');
  add({
    id: 'fix:hide-keys',
    ruleIds: ['FND-005', 'SCH-001'],
    title: 'Hide technical key columns',
    summary: `Hide ${keyFindings.length} key / ID column(s) that business users never need. Relationships keep working.`,
    risk: 'low',
    requiresReview: false,
    generatedBy: 'rule',
    changes: uniqueRefs(keyFindings).map((target): Change => ({ op: 'setHidden', target, value: true })),
  });

  // --- Implicit aggregation -------------------------------------------------
  const aggFindings = byRule('FND-003');
  add({
    id: 'fix:no-implicit-aggregation',
    ruleIds: ['FND-003'],
    title: 'Stop numeric columns from auto-summing',
    summary: `Set summarizeBy to none on ${aggFindings.length} numeric column(s) so Copilot uses explicit measures.`,
    risk: 'medium',
    requiresReview: false,
    generatedBy: 'rule',
    changes: uniqueRefs(aggFindings).map((target): Change => ({ op: 'setProperty', target, property: 'summarizeBy', value: 'none' })),
  });

  // --- Format strings -------------------------------------------------------
  const fmtFindings = byRule('FND-006');
  add({
    id: 'fix:format-strings',
    ruleIds: ['FND-006'],
    title: 'Add measure format strings',
    summary: `Infer a number format for ${fmtFindings.length} measure(s) from their names and expressions.`,
    risk: 'low',
    requiresReview: true,
    generatedBy: 'rule',
    changes: uniqueRefs(fmtFindings).flatMap((target): Change[] => {
      const l = lookup(snap, target);
      return l && 'measure' in l && l.measure ? [{ op: 'setProperty', target, property: 'formatString', value: inferFormatString(l.measure) }] : [];
    }),
  });

  // --- Date table -----------------------------------------------------------
  const dateFinding = byRule('FND-004').find((f) => f.fixKind === 'mark-date-table');
  if (dateFinding?.data) {
    const d = dateFinding.data as { table: string; name: string };
    add({
      id: 'fix:mark-date-table',
      ruleIds: ['FND-004'],
      title: `Mark ${d.table} as the date table`,
      summary: `Set ${d.table} as the date table using column ${d.name} (it must contain unique, contiguous dates).`,
      risk: 'medium',
      requiresReview: true,
      generatedBy: 'rule',
      changes: [
        { op: 'setProperty', target: { type: 'table', table: d.table }, property: 'dataCategory', value: 'Time' },
        { op: 'setProperty', target: { type: 'column', table: d.table, name: d.name }, property: 'isKey', value: 'true' },
      ],
    });
  }

  const hiddenNote = (refs: ObjectRef[]) => {
    const n = refs.filter((r) => isHiddenRef(snap, r)).length;
    return n > 0 ? `, ${n} of them hidden` : '';
  };
  // --- Descriptions -----------------------------------------------------------
  const describeRefs = [
    ...new Map([...uniqueRefs(byRule('DSC-001', 'DSC-002', 'DSC-003', 'DSC-004')), ...undescribedRefs(snap)].map((r) => [keyOf(r), r] as const)).values(),
  ];
  for (const [type, id, title, noun] of [
    ['table', 'fix:describe-tables', 'Describe tables', 'table'],
    ['measure', 'fix:describe-measures', 'Describe measures', 'measure'],
    ['column', 'fix:describe-columns', 'Describe columns', 'column'],
  ] as const) {
    const refs = describeRefs.filter((r) => r.type === type);
    if (refs.length === 0) continue;
    const llmMap = await tryLlm(`${noun} descriptions`, () =>
      llmDescriptions(
        llm!,
        snap,
        ctx,
        refs.map((r) => toTarget(snap, r)).filter((x): x is DescribeTarget => !!x),
      ),
    );
    const changes: Change[] = [];
    for (const r of refs) {
      const l = lookup(snap, r);
      if (!l) continue;
      let text = llmMap?.get(keyOf(r));
      if (!text) {
        text =
          r.type === 'table'
            ? templateTableDescription(snap, l.table)
            : r.type === 'column'
              ? templateColumnDescription(l.table, (l as { column: TableInfo['columns'][number] }).column)
              : templateMeasureDescription(l.table, (l as { measure: MeasureInfo }).measure);
      }
      changes.push({ op: 'setDescription', target: r, value: text });
    }
    add({
      id,
      ruleIds: type === 'table' ? ['DSC-001', 'DSC-004'] : type === 'measure' ? ['DSC-002', 'DSC-004'] : ['DSC-003', 'DSC-004'],
      title,
      summary: `Write ${changes.length} ${noun} description(s)${hiddenNote(refs)} (${llmMap && llmMap.size > 0 ? 'AI generated' : 'template based'}); review before applying.`,
      risk: 'low',
      requiresReview: true,
      generatedBy: llmMap && llmMap.size > 0 ? 'llm' : 'template',
      changes,
    });
  }

  // --- AI data schema (hide keys from AI) ------------------------------------
  const schemaFindings = byRule('SCH-001').filter((f) => f.objectType === 'column');
  const noSchema = byRule('SCH-001').some((f) => f.objectType === 'copilot');
  const schemaChanges: Change[] = uniqueRefs(schemaFindings).map((target): Change => ({ op: 'setAiVisibility', target, value: 'Hidden' }));
  if (noSchema && schemaChanges.length === 0) {
    // Create the schema file with the current visibility by setting visibility on the first visible table.
    const t = snap.tables.find((x) => !x.isHidden);
    if (t) schemaChanges.push({ op: 'setAiVisibility', target: { type: 'table', table: t.name }, value: 'Visible' });
  }
  add({
    id: 'fix:ai-schema',
    ruleIds: ['SCH-001'],
    title: 'Define the AI data schema',
    summary: 'Create the AI data schema and keep technical key columns out of Copilot.',
    risk: 'low',
    requiresReview: false,
    generatedBy: 'rule',
    changes: noSchema || schemaChanges.length > 0 ? schemaChanges : [],
  });

  // --- Indexing ---------------------------------------------------------------
  if (byRule('SCH-004').length > 0) {
    add({
      id: 'fix:indexing',
      ruleIds: ['SCH-004'],
      title: 'Enable value indexing',
      summary: 'Turn on indexing so Copilot can match spelled values (for example customer names) to filters.',
      risk: 'low',
      requiresReview: false,
      generatedBy: 'rule',
      changes: [{ op: 'setIndexing', value: true }],
    });
  }

  // --- Instructions -----------------------------------------------------------
  if (byRule('INS-001', 'INS-002', 'INS-003', 'INS-004').length > 0) {
    // Draft against the model as it will look after the description proposals.
    const interim = applyChanges(input.parts, proposals.flatMap((p) => p.changes), { newId: input.newId });
    const draftSnap = buildSnapshot(interim.parts, { name: input.name, governance: input.governance });
    const draft = templateInstructions(draftSnap, ctx);
    const llmText = await tryLlm('instructions', () => llmInstructions(llm!, draftSnap, ctx, draft));
    add({
      id: 'fix:instructions',
      ruleIds: ['INS-001', 'INS-002', 'INS-003', 'INS-004'],
      title: snap.copilot.instructions?.trim() ? 'Improve AI instructions' : 'Write AI instructions',
      summary: `Create model-level AI instructions with business context, terminology, defaults and preferred measures (${llmText ? 'AI generated' : 'template based'}${ctx?.description?.trim() ? ', grounded in your context description' : ''}).`,
      risk: 'low',
      requiresReview: true,
      generatedBy: llmText ? 'llm' : 'template',
      changes: [{ op: 'setInstructions', value: llmText ?? draft }],
    });
  }

  // --- Example prompts ---------------------------------------------------------
  if (byRule('EXM-001').length > 0) {
    const interim = applyChanges(input.parts, proposals.flatMap((p) => p.changes), { newId: input.newId });
    const draftSnap = buildSnapshot(interim.parts, { name: input.name, governance: input.governance });
    const llmPrompts = await tryLlm('example prompts', () => llmExamplePrompts(llm!, draftSnap, ctx));
    const prompts = llmPrompts ?? templateExamplePrompts(draftSnap);
    add({
      id: 'fix:example-prompts',
      ruleIds: ['EXM-001'],
      title: 'Add example prompts',
      summary: `Add ${prompts.length} example prompt(s) that use the model's measures and dimensions.`,
      risk: 'low',
      requiresReview: true,
      generatedBy: llmPrompts ? 'llm' : 'template',
      changes: [{ op: 'setExamplePrompts', value: prompts }],
    });
  }

  // --- Estimate gains ------------------------------------------------------------
  const finalProposals: FixProposal[] = proposals.map((p) => {
    const r = applyChanges(input.parts, p.changes, { newId: input.newId });
    const after = scoreModel(buildSnapshot(r.parts, { name: input.name, governance: input.governance }));
    return { ...p, estimatedGain: Math.round((after.score - score.score) * 10) / 10 };
  });
  finalProposals.sort((a, b) => (b.estimatedGain ?? 0) - (a.estimatedGain ?? 0));

  return { snapshot: snap, score, proposals: finalProposals, notes };
}

/** Convenience: apply a set of proposals (by id) and return the new parts and score. */
export function applyProposals(
  input: Pick<ProposeInput, 'parts' | 'name' | 'governance' | 'newId'>,
  proposals: FixProposal[],
) {
  const changes = proposals.flatMap((p) => p.changes);
  const result = applyChanges(input.parts, changes, { newId: input.newId });
  const snapshot = buildSnapshot(result.parts, { name: input.name, governance: input.governance });
  return { ...result, snapshot, score: scoreModel(snapshot) };
}
