import type {
  ColumnInfo,
  CopilotArtifacts,
  DataType,
  DefinitionParts,
  GovernanceInfo,
  HierarchyInfo,
  MeasureInfo,
  ModelSnapshot,
  RelationshipInfo,
  TableInfo,
} from './types.js';
import { parseTmdl, propBool, propValue, unquoteName, type TmdlNode } from './tmdl.js';

const DATA_TYPES: Record<string, DataType> = {
  string: 'string',
  int64: 'int64',
  double: 'double',
  decimal: 'decimal',
  boolean: 'boolean',
  datetime: 'dateTime',
  binary: 'binary',
  variant: 'variant',
};

export const PART = {
  pbism: 'definition.pbism',
  instructions: 'Copilot/Instructions/instructions.md',
  schema: 'Copilot/schema.json',
  settings: 'Copilot/settings.json',
  examples: 'Copilot/examplePrompts.json',
} as const;

/** Parse "Table.Column", "'My Table'.'My Col'" -> [table, column]. */
export function splitObjectRef(ref: string): [string, string] {
  const s = ref.trim();
  let i = 0;
  const readSeg = (): string => {
    if (s[i] === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const seg = unquoteName(s.slice(i, j + 1));
      i = j + 1;
      return seg;
    }
    const j = s.indexOf('.', i);
    const seg = j === -1 ? s.slice(i) : s.slice(i, j);
    i = j === -1 ? s.length : j;
    return seg.trim();
  };
  const table = readSeg();
  if (s[i] === '.') i += 1;
  const column = readSeg();
  return [table, column];
}

function toDataType(v: string | undefined): DataType {
  return DATA_TYPES[(v ?? '').toLowerCase()] ?? 'unknown';
}

function parseColumn(n: TmdlNode): ColumnInfo {
  return {
    name: n.name,
    dataType: toDataType(propValue(n, 'dataType')),
    description: n.description,
    isHidden: propBool(n, 'isHidden') ?? false,
    isCalculated: n.inline !== undefined,
    isKey: propBool(n, 'isKey') ?? false,
    formatString: propValue(n, 'formatString'),
    summarizeBy: propValue(n, 'summarizeBy')?.toLowerCase(),
    sortByColumn: propValue(n, 'sortByColumn'),
    displayFolder: propValue(n, 'displayFolder'),
    dataCategory: propValue(n, 'dataCategory'),
    lineageTag: propValue(n, 'lineageTag'),
    synonyms: [],
  };
}

function parseMeasure(n: TmdlNode): MeasureInfo {
  return {
    name: n.name,
    expression: n.expression ?? n.inline ?? '',
    description: n.description,
    isHidden: propBool(n, 'isHidden') ?? false,
    formatString: propValue(n, 'formatString'),
    displayFolder: propValue(n, 'displayFolder'),
    lineageTag: propValue(n, 'lineageTag'),
    synonyms: [],
  };
}

function parseTable(n: TmdlNode): TableInfo {
  const columns = n.children.filter((c) => c.kind === 'column').map(parseColumn);
  const measures = n.children.filter((c) => c.kind === 'measure').map(parseMeasure);
  const hierarchies: HierarchyInfo[] = n.children
    .filter((c) => c.kind === 'hierarchy')
    .map((h) => ({
      name: h.name,
      levels: h.children.filter((l) => l.kind === 'level').map((l) => l.name),
      lineageTag: propValue(h, 'lineageTag'),
    }));
  const partitions = n.children.filter((c) => c.kind === 'partition');
  const calculated = partitions.some((p) => (p.inline ?? '').trim().toLowerCase() === 'calculated');
  const modes = partitions.map((p) => propValue(p, 'mode')).filter(Boolean) as string[];
  return {
    name: n.name,
    description: n.description,
    isHidden: propBool(n, 'isHidden') ?? false,
    dataCategory: propValue(n, 'dataCategory'),
    isCalculatedTable: calculated,
    lineageTag: propValue(n, 'lineageTag'),
    columns,
    measures,
    hierarchies,
    partitionMode: modes[0],
    synonyms: [],
  };
}

function parseRelationship(n: TmdlNode): RelationshipInfo | null {
  const from = propValue(n, 'fromColumn');
  const to = propValue(n, 'toColumn');
  if (!from || !to) return null;
  const [fromTable, fromColumn] = splitObjectRef(from);
  const [toTable, toColumn] = splitObjectRef(to);
  const cf = (propValue(n, 'crossFilteringBehavior') ?? '').toLowerCase();
  return {
    name: n.name,
    fromTable,
    fromColumn,
    toTable,
    toColumn,
    isActive: propBool(n, 'isActive') ?? true,
    crossFilter: cf.startsWith('both') ? 'both' : 'single',
    fromCardinality: (propValue(n, 'fromCardinality') ?? 'many').toLowerCase() === 'one' ? 'one' : 'many',
    toCardinality: (propValue(n, 'toCardinality') ?? 'one').toLowerCase() === 'many' ? 'many' : 'one',
  };
}

interface CopilotSchemaTable {
  id?: string;
  name?: string;
  visibility?: 'Visible' | 'Hidden';
  synonyms?: string[];
  columns?: { id?: string; name?: string; visibility?: string; synonyms?: string[] }[];
  measures?: { id?: string; name?: string; visibility?: string; synonyms?: string[] }[];
}

function safeJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
  } catch {
    return undefined;
  }
}

function readCopilot(parts: DefinitionParts): { artifacts: CopilotArtifacts; schema?: { tables?: CopilotSchemaTable[] } } {
  const instructions = parts[PART.instructions];
  const settings = safeJson<{ indexingEnabled?: boolean }>(parts[PART.settings]);
  const examples = safeJson<{ prompts?: string[] }>(parts[PART.examples]);
  const schema = safeJson<{ tables?: CopilotSchemaTable[] }>(parts[PART.schema]);
  const verified = new Set<string>();
  for (const p of Object.keys(parts)) {
    const m = /^Copilot\/VerifiedAnswers\/definitions\/([^/]+)\//i.exec(p);
    if (m) verified.add(m[1]!);
  }
  if (verified.size === 0) {
    for (const p of Object.keys(parts)) {
      if (/^Copilot\/VerifiedAnswers\/.+\.json$/i.test(p)) verified.add(p);
    }
  }
  return {
    artifacts: {
      instructions: instructions !== undefined ? instructions : undefined,
      indexingEnabled: settings ? settings.indexingEnabled !== false : undefined,
      hasSchema: !!schema && Array.isArray(schema.tables),
      examplePrompts: Array.isArray(examples?.prompts) ? examples!.prompts!.filter((p) => !!p?.trim()) : [],
      verifiedAnswerCount: verified.size,
    },
    schema,
  };
}

export function buildSnapshot(
  parts: DefinitionParts,
  opts: { name?: string; governance?: GovernanceInfo } = {},
): ModelSnapshot {
  const pbism = safeJson<{ settings?: { qnaEnabled?: boolean } }>(parts[PART.pbism]);
  const roots: TmdlNode[] = [];
  for (const [path, text] of Object.entries(parts)) {
    if (/^definition\/.+\.tmdl$/i.test(path) && !/\/cultures\//i.test(path)) {
      roots.push(...parseTmdl(text));
    }
  }
  const modelNode = roots.find((r) => r.kind === 'model');
  const dbNode = roots.find((r) => r.kind === 'database');
  const tables = roots.filter((r) => r.kind === 'table').map(parseTable);
  const relationships = roots
    .filter((r) => r.kind === 'relationship')
    .map(parseRelationship)
    .filter((r): r is RelationshipInfo => r !== null);

  const { artifacts, schema } = readCopilot(parts);

  // Overlay Copilot/schema.json (synonyms + AI visibility), matched by lineage tag then by name.
  if (schema?.tables) {
    for (const st of schema.tables) {
      const t = tables.find((x) => (st.id && x.lineageTag === st.id) || x.name === st.name);
      if (!t) continue;
      t.synonyms = st.synonyms ?? [];
      t.aiVisibility = st.visibility === 'Hidden' ? 'Hidden' : 'Visible';
      for (const sc of st.columns ?? []) {
        const c = t.columns.find((x) => (sc.id && x.lineageTag === sc.id) || x.name === sc.name);
        if (c) c.synonyms = sc.synonyms ?? [];
      }
      for (const sm of st.measures ?? []) {
        const m = t.measures.find((x) => (sm.id && x.lineageTag === sm.id) || x.name === sm.name);
        if (m) m.synonyms = sm.synonyms ?? [];
      }
    }
  }

  const governance: GovernanceInfo = {
    qnaEnabled: pbism?.settings?.qnaEnabled ?? true,
    ...opts.governance,
  };

  return {
    name: opts.name ?? modelNode?.name ?? 'Model',
    compatibilityLevel: dbNode ? Number(propValue(dbNode, 'compatibilityLevel')) || undefined : undefined,
    culture: modelNode ? propValue(modelNode, 'culture') : undefined,
    discourageImplicitMeasures: modelNode ? (propBool(modelNode, 'discourageImplicitMeasures') ?? false) : false,
    tables,
    relationships,
    copilot: artifacts,
    governance,
  };
}

/** Decode a Fabric getDefinition response into text parts (skips non-text parts such as .platform). */
export function decodeDefinition(def: {
  parts: { path: string; payload: string; payloadType?: string }[];
}): DefinitionParts {
  const out: DefinitionParts = {};
  for (const p of def.parts) {
    if (p.path === '.platform') continue;
    out[p.path] = base64ToUtf8(p.payload);
  }
  return out;
}

export function encodeDefinition(parts: DefinitionParts): { path: string; payload: string; payloadType: 'InlineBase64' }[] {
  return Object.entries(parts).map(([path, text]) => ({
    path,
    payload: utf8ToBase64(text),
    payloadType: 'InlineBase64',
  }));
}

export function base64ToUtf8(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function utf8ToBase64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
