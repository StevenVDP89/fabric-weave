import { PART, buildSnapshot } from './snapshot.js';
import { parseTmdl, type TmdlNode } from './tmdl.js';
import type { Change, DefinitionParts, ModelSnapshot, ObjectRef } from './types.js';

export interface PatchOptions {
  /** Injectable for deterministic tests. */
  newId?: () => string;
}

export interface PatchResult {
  parts: DefinitionParts;
  applied: Change[];
  skipped: { change: Change; reason: string }[];
}

const COPILOT_SCHEMA_URL =
  'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/copilot/schema/1.0.0/schema.json';
const COPILOT_SETTINGS_URL =
  'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/copilot/settings/1.0.0/schema.json';
const COPILOT_EXAMPLES_URL =
  'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/copilot/examplePrompts/1.0.0/schema.json';

const FLAG_PROPS = new Set(['isHidden', 'isKey']);

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}
export function quoteName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Line based TMDL editing
// ---------------------------------------------------------------------------

interface Edit {
  start: number;
  /** Inclusive. end === start - 1 means a pure insertion before `start`. */
  end: number;
  lines: string[];
  seq: number;
  /** Order of pure insertions at the same index: properties, then doc comments, then new objects. */
  rank: number;
}

class TmdlFile {
  readonly lines: string[];
  readonly eol: string;
  readonly unit: string;
  readonly roots: TmdlNode[];
  private edits = new Map<string, Edit>();
  private seq = 0;
  private addedAt = new Map<number, number>();

  constructor(
    readonly path: string,
    text: string,
  ) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    this.lines = text.replace(/\r\n/g, '\n').split('\n');
    this.roots = parseTmdl(text);
    const indented = this.lines.find((l) => /^[\t ]+\S/.test(l));
    if (!indented) this.unit = '\t';
    else if (indented.startsWith('\t')) this.unit = '\t';
    else this.unit = ' '.repeat(Math.max(1, /^ +/.exec(indented)![0].length));
  }

  headerIndent(node: TmdlNode): string {
    return /^[\t ]*/.exec(this.lines[node.line]!)![0];
  }

  set(key: string, start: number, end: number, lines: string[], rank = 0): void {
    this.edits.set(key, { start, end, lines, seq: this.seq++, rank });
  }

  get dirty(): boolean {
    return this.edits.size > 0;
  }

  setDescription(node: TmdlNode, text: string): void {
    const ind = this.headerIndent(node);
    const doc = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => `${ind}/// ${l}`.trimEnd());
    if (node.docStart < node.line) this.set(`doc:${node.line}`, node.docStart, node.line - 1, doc, 1);
    else this.set(`doc:${node.line}`, node.line, node.line - 1, doc, 1);
  }

  setProp(node: TmdlNode, key: string, value: string | boolean): void {
    const existing = node.props.get(key);
    const ind = this.headerIndent(node) + this.unit;
    const isFlag = FLAG_PROPS.has(key) && (typeof value === 'boolean' || value === 'true' || value === 'false');
    const on = value === true || value === 'true';
    if (isFlag) {
      if (on) {
        if (existing && existing.isFlag) return;
        if (existing) this.set(`prop:${node.line}:${key}`, existing.line, existing.endLine, [`${ind}${key}`]);
        else this.set(`prop:${node.line}:${key}`, node.headerEnd + 1, node.headerEnd, [`${ind}${key}`]);
      } else if (existing) {
        this.set(`prop:${node.line}:${key}`, existing.line, existing.endLine, []);
      }
      return;
    }
    const line = `${ind}${key}: ${String(value)}`;
    if (existing) this.set(`prop:${node.line}:${key}`, existing.line, existing.endLine, [line]);
    else this.set(`prop:${node.line}:${key}`, node.headerEnd + 1, node.headerEnd, [line]);
  }

  addMeasure(table: TmdlNode, m: { name: string; expression: string; formatString?: string; description?: string; displayFolder?: string }, id: string): void {
    const ind = this.headerIndent(table) + this.unit;
    const ind2 = ind + this.unit;
    const out: string[] = [];
    if (m.description) {
      for (const l of m.description.replace(/\r\n/g, '\n').split('\n')) out.push(`${ind}/// ${l}`.trimEnd());
    }
    out.push(`${ind}measure ${quoteName(m.name)} = ${m.expression.replace(/\s*\n\s*/g, ' ')}`);
    if (m.formatString) out.push(`${ind2}formatString: ${m.formatString}`);
    if (m.displayFolder) out.push(`${ind2}displayFolder: ${m.displayFolder}`);
    out.push(`${ind2}lineageTag: ${id}`);
    const firstPartition = table.children.find((c) => c.kind === 'partition');
    const at = firstPartition ? firstPartition.docStart : table.endLine + 1;
    const alreadyAdded = this.addedAt.get(at) ?? 0;
    this.addedAt.set(at, alreadyAdded + 1);
    const needsLeadingBlank = alreadyAdded === 0 && (this.lines[at - 1] ?? '').trim() !== '';
    const lines = [...(needsLeadingBlank ? [''] : []), ...out, ''];
    this.set(`measure:${table.line}:${m.name}`, at, at - 1, lines, 2);
  }

  render(): string {
    const edits = [...this.edits.values()].sort((a, b) => {
      if (a.start !== b.start) return b.start - a.start;
      const ar = a.end >= a.start ? 0 : 1;
      const br = b.end >= b.start ? 0 : 1;
      if (ar !== br) return ar - br;
      if (a.rank !== b.rank) return b.rank - a.rank;
      return b.seq - a.seq;
    });
    const out = [...this.lines];
    for (const e of edits) out.splice(e.start, e.end - e.start + 1, ...e.lines);
    return out.join(this.eol);
  }
}

function openTmdlFiles(parts: DefinitionParts): TmdlFile[] {
  return Object.keys(parts)
    .filter((p) => /^definition\/.+\.tmdl$/i.test(p) && !/\/cultures\//i.test(p))
    .map((p) => new TmdlFile(p, parts[p]!));
}

interface Located {
  file: TmdlFile;
  node: TmdlNode;
}

function locate(files: TmdlFile[], ref: ObjectRef): Located | undefined {
  for (const file of files) {
    const table = file.roots.find((r) => r.kind === 'table' && r.name === ref.table);
    if (!table) continue;
    if (ref.type === 'table') return { file, node: table };
    const kind = ref.type;
    const node = table.children.find((c) => c.kind === kind && c.name === ref.name);
    if (node) return { file, node };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Lineage tags (needed as ids in Copilot/schema.json)
// ---------------------------------------------------------------------------

export function ensureLineageTags(parts: DefinitionParts, newId: () => string = defaultId): DefinitionParts {
  const out = { ...parts };
  for (const file of openTmdlFiles(parts)) {
    const visit = (n: TmdlNode) => {
      if (['table', 'column', 'measure', 'hierarchy', 'level'].includes(n.kind) && !n.props.has('lineageTag')) {
        file.setProp(n, 'lineageTag', newId());
      }
      n.children.forEach(visit);
    };
    file.roots.filter((r) => r.kind === 'table').forEach(visit);
    if (file.dirty) out[file.path] = file.render();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copilot JSON helpers
// ---------------------------------------------------------------------------

interface SchemaMember {
  id?: string;
  name: string;
  visibility: 'Visible' | 'Hidden';
  synonyms: string[];
  [k: string]: unknown;
}
interface SchemaTable extends SchemaMember {
  columns: SchemaMember[];
  measures: SchemaMember[];
  hierarchies?: (SchemaMember & { levels?: SchemaMember[] })[];
}
interface SchemaDoc {
  $schema?: string;
  tables: SchemaTable[];
  [k: string]: unknown;
}

function json(o: unknown): string {
  return JSON.stringify(o, null, 2) + '\n';
}

function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
  } catch {
    return undefined;
  }
}

export function buildSchemaDoc(snap: ModelSnapshot): SchemaDoc {
  return {
    $schema: COPILOT_SCHEMA_URL,
    tables: snap.tables.map((t) => ({
      id: t.lineageTag,
      name: t.name,
      visibility: t.isHidden || t.aiVisibility === 'Hidden' ? 'Hidden' : 'Visible',
      columns: t.columns.map((c) => ({
        id: c.lineageTag,
        name: c.name,
        visibility: c.isHidden || c.aiVisibility === 'Hidden' ? 'Hidden' : 'Visible',
        synonyms: [...c.synonyms],
      })),
      measures: t.measures.map((m) => ({
        id: m.lineageTag,
        name: m.name,
        visibility: m.isHidden || m.aiVisibility === 'Hidden' ? 'Hidden' : 'Visible',
        synonyms: [...m.synonyms],
      })),
      synonyms: [...t.synonyms],
    })),
  };
}

function upsert<T extends SchemaMember>(list: T[], id: string | undefined, name: string, make: () => T): T {
  const found = list.find((x) => (id && x.id === id) || x.name === name);
  if (found) return found;
  const created = make();
  list.push(created);
  return created;
}

function schemaEntry(doc: SchemaDoc, snap: ModelSnapshot, ref: ObjectRef): SchemaMember | undefined {
  const t = snap.tables.find((x) => x.name === ref.table);
  if (!t) return undefined;
  const st = upsert(doc.tables, t.lineageTag, t.name, () => ({
    id: t.lineageTag,
    name: t.name,
    visibility: 'Visible',
    synonyms: [],
    columns: [],
    measures: [],
  }));
  st.columns ??= [];
  st.measures ??= [];
  if (ref.type === 'table') return st;
  if (ref.type === 'column') {
    const c = t.columns.find((x) => x.name === ref.name);
    if (!c) return undefined;
    return upsert(st.columns, c.lineageTag, c.name, () => ({ id: c.lineageTag, name: c.name, visibility: 'Visible', synonyms: [] }));
  }
  const m = t.measures.find((x) => x.name === ref.name);
  if (!m) return undefined;
  return upsert(st.measures, m.lineageTag, m.name, () => ({ id: m.lineageTag, name: m.name, visibility: 'Visible', synonyms: [] }));
}

// ---------------------------------------------------------------------------
// Public: apply changes
// ---------------------------------------------------------------------------

const TMDL_OPS = new Set<Change['op']>(['setDescription', 'setProperty', 'setHidden']);
const SCHEMA_OPS = new Set<Change['op']>(['setAiVisibility']);

export function applyChanges(parts: DefinitionParts, changes: Change[], opts: PatchOptions = {}): PatchResult {
  const newId = opts.newId ?? defaultId;
  const applied: Change[] = [];
  const skipped: PatchResult['skipped'] = [];
  let current: DefinitionParts = { ...parts };

  // Pass 1: TMDL edits.
  const files = openTmdlFiles(current);
  for (const ch of changes) {
    if (ch.op === 'addMeasure') {
      const loc = locate(files, { type: 'table', table: ch.table });
      if (!loc) {
        skipped.push({ change: ch, reason: `Table not found: ${ch.table}` });
      } else if (loc.node.children.some((c) => c.kind === 'measure' && c.name === ch.name)) {
        skipped.push({ change: ch, reason: `Measure already exists: ${ch.name}` });
      } else {
        loc.file.addMeasure(loc.node, ch, newId());
        applied.push(ch);
      }
      continue;
    }
    if (!TMDL_OPS.has(ch.op)) continue;
    const target = (ch as { target: ObjectRef }).target;
    const loc = locate(files, target);
    if (!loc) {
      skipped.push({ change: ch, reason: `Object not found: ${target.table}${target.name ? `.${target.name}` : ''}` });
      continue;
    }
    if (ch.op === 'setDescription') loc.file.setDescription(loc.node, ch.value);
    else if (ch.op === 'setProperty') loc.file.setProp(loc.node, ch.property, ch.value);
    else if (ch.op === 'setHidden') loc.file.setProp(loc.node, 'isHidden', ch.value);
    applied.push(ch);
  }
  for (const f of files) if (f.dirty) current[f.path] = f.render();

  // Pass 2: Copilot schema (needs lineage tags as ids).
  const schemaChanges = changes.filter((c) => SCHEMA_OPS.has(c.op));
  if (schemaChanges.length > 0) {
    current = ensureLineageTags(current, newId);
    const snap = buildSnapshot(current);
    const existing = parseJson<SchemaDoc>(current[PART.schema]);
    const doc: SchemaDoc = existing && Array.isArray(existing.tables) ? existing : buildSchemaDoc(snap);
    doc.$schema ??= COPILOT_SCHEMA_URL;
    for (const ch of schemaChanges) {
      const target = (ch as { target: ObjectRef }).target;
      const entry = schemaEntry(doc, snap, target);
      if (!entry) {
        skipped.push({ change: ch, reason: `Object not found: ${target.table}${target.name ? `.${target.name}` : ''}` });
        continue;
      }
      if (ch.op === 'setAiVisibility') entry.visibility = ch.value;
      applied.push(ch);
    }
    current[PART.schema] = json(doc);
  }

  // Model-level Copilot parts.
  for (const ch of changes) {
    switch (ch.op) {
      case 'setInstructions':
        current[PART.instructions] = ch.value.endsWith('\n') ? ch.value : ch.value + '\n';
        applied.push(ch);
        break;
      case 'setIndexing': {
        const s = parseJson<Record<string, unknown>>(current[PART.settings]) ?? { $schema: COPILOT_SETTINGS_URL };
        s.indexingEnabled = ch.value;
        current[PART.settings] = json(s);
        applied.push(ch);
        break;
      }
      case 'setExamplePrompts': {
        const s = parseJson<Record<string, unknown>>(current[PART.examples]) ?? { $schema: COPILOT_EXAMPLES_URL };
        s.prompts = ch.value.filter((p) => p.trim().length > 0);
        current[PART.examples] = json(s);
        applied.push(ch);
        break;
      }
      case 'setQna': {
        const p = parseJson<{ settings?: Record<string, unknown> } & Record<string, unknown>>(current[PART.pbism]);
        if (!p) {
          skipped.push({ change: ch, reason: 'definition.pbism is missing or unreadable' });
          break;
        }
        p.settings = { ...(p.settings ?? {}), qnaEnabled: ch.value };
        current[PART.pbism] = json(p);
        applied.push(ch);
        break;
      }
      case 'rename':
        skipped.push({
          change: ch,
          reason: 'Renames can break reports and DAX that reference the old name; rename in the model source (Power BI Desktop or TMDL) and update the reports instead.',
        });
        break;
      default:
        break;
    }
  }

  ensureCopilotInfrastructure(current);
  return { parts: current, applied, skipped };
}

const ITEM_VERSION_URL = 'https://developer.microsoft.com/json-schemas/fabric/item/version/1.0.0/schema.json';
/** The service only keeps Copilot/* parts when definition.pbism is at format 5.0 or higher. */
const MIN_PBISM_FOR_COPILOT = 5;

/** Copilot parts need version.json markers and a new enough definition.pbism, otherwise Fabric silently drops them. */
function ensureCopilotInfrastructure(current: DefinitionParts): void {
  const hasCopilot = Object.keys(current).some((p) => p.startsWith('Copilot/'));
  if (!hasCopilot) return;
  const marker = json({ $schema: ITEM_VERSION_URL, version: '1.0.0' });
  current['Copilot/version.json'] ??= marker;
  if (current[PART.instructions] !== undefined) current['Copilot/Instructions/version.json'] ??= marker;
  const p = parseJson<Record<string, unknown>>(current[PART.pbism]);
  if (p && !(Number.parseFloat(String(p.version ?? '0')) >= MIN_PBISM_FOR_COPILOT)) {
    p.version = '5.0';
    current[PART.pbism] = json(p);
  }
}

/** Parts that differ between two definitions (for diff views, audit and snapshots). */
export function diffParts(before: DefinitionParts, after: DefinitionParts) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: { path: string; status: 'added' | 'modified' | 'removed'; before?: string; after?: string }[] = [];
  for (const p of [...paths].sort()) {
    const b = before[p];
    const a = after[p];
    if (b === undefined && a !== undefined) out.push({ path: p, status: 'added', after: a });
    else if (b !== undefined && a === undefined) out.push({ path: p, status: 'removed', before: b });
    else if (b !== a) out.push({ path: p, status: 'modified', before: b, after: a });
  }
  return out;
}
