import type { Change, FixProposal, ObjectRef } from './types.js';

/**
 * Input hardening for fix proposals that arrive from a browser. The patcher writes these values
 * into TMDL and JSON files, so only a known set of operations, properties and value shapes is accepted.
 */

export type ValidationResult = { ok: true; proposals: FixProposal[]; changeCount: number } | { ok: false; errors: string[] };

export const LIMITS = {
  proposals: 200,
  changes: 3000,
  name: 256,
  description: 4000,
  instructions: 10000,
  expression: 8000,
  examplePrompts: 20,
  examplePrompt: 300,
  propertyValue: 200,
} as const;

const SETTABLE_PROPERTIES = new Set(['formatString', 'summarizeBy', 'dataCategory', 'isKey', 'displayFolder']);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

class Collector {
  readonly errors: string[] = [];
  add(path: string, message: string) {
    if (this.errors.length < 25) this.errors.push(`${path}: ${message}`);
  }
}

function str(c: Collector, path: string, v: unknown, max: number, opts: { multiline?: boolean; optional?: boolean; allowEmpty?: boolean } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (!opts.optional) c.add(path, 'is required');
    return undefined;
  }
  if (typeof v !== 'string') {
    c.add(path, 'must be a string');
    return undefined;
  }
  if (!opts.allowEmpty && v.trim().length === 0) {
    c.add(path, 'must not be empty');
    return undefined;
  }
  if (v.length > max) {
    c.add(path, `must be at most ${max} characters`);
    return undefined;
  }
  if (CONTROL.test(v) || (!opts.multiline && LINE_BREAK.test(v))) {
    c.add(path, 'contains characters that are not allowed');
    return undefined;
  }
  return v;
}

function target(c: Collector, path: string, v: unknown): ObjectRef | undefined {
  if (!v || typeof v !== 'object') {
    c.add(path, 'is required');
    return undefined;
  }
  const t = v as Record<string, unknown>;
  const type = t.type;
  if (type !== 'table' && type !== 'column' && type !== 'measure') {
    c.add(`${path}.type`, 'must be table, column or measure');
    return undefined;
  }
  const table = str(c, `${path}.table`, t.table, LIMITS.name);
  const name = str(c, `${path}.name`, t.name, LIMITS.name, { optional: type === 'table' });
  if (table === undefined) return undefined;
  if (type !== 'table' && name === undefined) return undefined;
  return type === 'table' ? { type, table } : { type, table, name };
}

function strings(c: Collector, path: string, v: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(v)) {
    c.add(path, 'must be an array');
    return undefined;
  }
  if (v.length > maxItems) {
    c.add(path, `must have at most ${maxItems} items`);
    return undefined;
  }
  const out: string[] = [];
  v.forEach((x, i) => {
    const s = str(c, `${path}[${i}]`, x, maxLen);
    if (s !== undefined) out.push(s.trim());
  });
  return out;
}

function change(c: Collector, path: string, raw: unknown): Change | undefined {
  if (!raw || typeof raw !== 'object') {
    c.add(path, 'must be an object');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  switch (r.op) {
    case 'setDescription': {
      const t = target(c, `${path}.target`, r.target);
      const value = str(c, `${path}.value`, r.value, LIMITS.description, { multiline: true });
      return t && value !== undefined ? { op: 'setDescription', target: t, value } : undefined;
    }
    case 'setProperty': {
      const t = target(c, `${path}.target`, r.target);
      const property = typeof r.property === 'string' ? r.property : '';
      if (!SETTABLE_PROPERTIES.has(property)) c.add(`${path}.property`, `must be one of ${[...SETTABLE_PROPERTIES].join(', ')}`);
      const value = str(c, `${path}.value`, r.value, LIMITS.propertyValue);
      return t && value !== undefined && SETTABLE_PROPERTIES.has(property) ? { op: 'setProperty', target: t, property, value } : undefined;
    }
    case 'setHidden': {
      const t = target(c, `${path}.target`, r.target);
      if (typeof r.value !== 'boolean') c.add(`${path}.value`, 'must be a boolean');
      return t && typeof r.value === 'boolean' ? { op: 'setHidden', target: t, value: r.value } : undefined;
    }
    case 'setAiVisibility': {
      const t = target(c, `${path}.target`, r.target);
      if (r.value !== 'Visible' && r.value !== 'Hidden') c.add(`${path}.value`, 'must be Visible or Hidden');
      return t && (r.value === 'Visible' || r.value === 'Hidden') ? { op: 'setAiVisibility', target: t, value: r.value } : undefined;
    }
    case 'setInstructions': {
      const value = str(c, `${path}.value`, r.value, LIMITS.instructions, { multiline: true });
      return value !== undefined ? { op: 'setInstructions', value } : undefined;
    }
    case 'setIndexing':
    case 'setQna': {
      if (typeof r.value !== 'boolean') c.add(`${path}.value`, 'must be a boolean');
      return typeof r.value === 'boolean' ? { op: r.op, value: r.value } : undefined;
    }
    case 'setExamplePrompts': {
      const value = strings(c, `${path}.value`, r.value, LIMITS.examplePrompts, LIMITS.examplePrompt);
      return value ? { op: 'setExamplePrompts', value } : undefined;
    }
    case 'addMeasure': {
      const table = str(c, `${path}.table`, r.table, LIMITS.name);
      const name = str(c, `${path}.name`, r.name, LIMITS.name);
      const expression = str(c, `${path}.expression`, r.expression, LIMITS.expression, { multiline: true });
      const formatString = str(c, `${path}.formatString`, r.formatString, LIMITS.propertyValue, { optional: true });
      const description = str(c, `${path}.description`, r.description, LIMITS.description, { optional: true, multiline: true });
      const displayFolder = str(c, `${path}.displayFolder`, r.displayFolder, LIMITS.name, { optional: true });
      if (table === undefined || name === undefined || expression === undefined) return undefined;
      return { op: 'addMeasure', table, name, expression, ...(formatString ? { formatString } : {}), ...(description ? { description } : {}), ...(displayFolder ? { displayFolder } : {}) };
    }
    case 'rename':
      c.add(`${path}.op`, 'renames are not applied automatically; rename objects manually so reports keep working');
      return undefined;
    default:
      c.add(`${path}.op`, 'is not a supported operation');
      return undefined;
  }
}

export function validateProposals(input: unknown): ValidationResult {
  const c = new Collector();
  if (!Array.isArray(input)) return { ok: false, errors: ['proposals must be an array'] };
  if (input.length === 0) return { ok: false, errors: ['select at least one proposal'] };
  if (input.length > LIMITS.proposals) return { ok: false, errors: [`at most ${LIMITS.proposals} proposals can be applied at once`] };
  const proposals: FixProposal[] = [];
  let changeCount = 0;
  input.forEach((raw, i) => {
    const path = `proposals[${i}]`;
    if (!raw || typeof raw !== 'object') {
      c.add(path, 'must be an object');
      return;
    }
    const p = raw as Record<string, unknown>;
    const id = str(c, `${path}.id`, p.id, 120);
    const title = str(c, `${path}.title`, p.title, 300, { optional: true }) ?? 'Fix';
    const summary = str(c, `${path}.summary`, p.summary, 1000, { optional: true, allowEmpty: true }) ?? '';
    const ruleIds = Array.isArray(p.ruleIds) ? p.ruleIds.filter((x): x is string => typeof x === 'string' && x.length <= 20).slice(0, 20) : [];
    if (!Array.isArray(p.changes)) {
      c.add(`${path}.changes`, 'must be an array');
      return;
    }
    const changes: Change[] = [];
    p.changes.forEach((ch, j) => {
      changeCount += 1;
      if (changeCount > LIMITS.changes) {
        if (changeCount === LIMITS.changes + 1) c.add(path, `more than ${LIMITS.changes} changes in total`);
        return;
      }
      const clean = change(c, `${path}.changes[${j}]`, ch);
      if (clean) changes.push(clean);
    });
    if (id === undefined) return;
    proposals.push({
      id,
      ruleIds,
      title,
      summary,
      risk: p.risk === 'high' || p.risk === 'medium' ? p.risk : 'low',
      requiresReview: p.requiresReview === true,
      generatedBy: p.generatedBy === 'llm' || p.generatedBy === 'template' ? p.generatedBy : 'rule',
      changes,
      estimatedGain: typeof p.estimatedGain === 'number' && Number.isFinite(p.estimatedGain) ? p.estimatedGain : undefined,
    });
  });
  if (c.errors.length) return { ok: false, errors: c.errors };
  return { ok: true, proposals, changeCount };
}
