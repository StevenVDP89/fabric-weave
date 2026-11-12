import type { Proposal } from '@/lib/api';

export type Change = Proposal['changes'][number];
type Target = Extract<Change, { op: 'setDescription' }>['target'];

export function targetPath(target: Target): string {
  return target.type === 'table' || !target.name ? target.table : `${target.table}[${target.name}]`;
}

/** One-line, human-readable summary of what a change does; shown in the review panel. */
export function describeChange(change: Change): string {
  switch (change.op) {
    case 'setDescription':
      return `Describe ${targetPath(change.target)}`;
    case 'setProperty':
      return `Set ${change.property} on ${targetPath(change.target)} to “${change.value}”`;
    case 'setHidden':
      return `${change.value ? 'Hide' : 'Show'} ${targetPath(change.target)}`;
    case 'setAiVisibility':
      return `${change.value === 'Hidden' ? 'Hide from' : 'Expose to'} AI: ${targetPath(change.target)}`;
    case 'setInstructions':
      return 'Write AI instructions for the model';
    case 'setIndexing':
      return `${change.value ? 'Enable' : 'Disable'} value indexing`;
    case 'setExamplePrompts':
      return `Set ${change.value.length} example prompts`;
    case 'setQna':
      return `${change.value ? 'Enable' : 'Disable'} Q&A`;
    case 'addMeasure':
      return `Add measure ${change.table}[${change.name}]`;
    case 'rename':
      return `Rename ${targetPath(change.target)} to “${change.value}”`;
  }
}

export function isEditable(change: Change): boolean {
  return ['setDescription', 'setInstructions', 'setExamplePrompts'].includes(change.op);
}

const opNoun: Record<Change['op'], [string, string]> = {
  setDescription: ['description', 'descriptions'],
  setProperty: ['property change', 'property changes'],
  setHidden: ['visibility change', 'visibility changes'],
  setAiVisibility: ['AI visibility change', 'AI visibility changes'],
  setInstructions: ['AI instruction text', 'AI instruction texts'],
  setIndexing: ['indexing setting', 'indexing settings'],
  setExamplePrompts: ['example prompt set', 'example prompt sets'],
  setQna: ['Q&A setting', 'Q&A settings'],
  addMeasure: ['new measure', 'new measures'],
  rename: ['rename', 'renames'],
};

/** Counts what a change set does, by kind, in a stable order: "12 descriptions, 3 new measures". */
export function summariseChanges(changes: Change[]): string[] {
  const counts = new Map<Change['op'], number>();
  for (const c of changes) counts.set(c.op, (counts.get(c.op) ?? 0) + 1);
  return (Object.keys(opNoun) as Change['op'][])
    .filter((op) => counts.has(op))
    .map((op) => {
      const n = counts.get(op) ?? 0;
      return `${n} ${opNoun[op][n === 1 ? 0 : 1]}`;
    });
}

export function sameChanges(a: Change[], b: Change[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function splitList(value: string, separator: RegExp): string[] {
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}
