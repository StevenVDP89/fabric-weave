import { describe, expect, it } from 'vitest';

import { isEditable, summariseChanges, type Change } from './changes';

const c = (op: string, extra: Record<string, unknown> = {}) => ({ op, ...extra }) as unknown as Change;

describe('isEditable', () => {
  it('lets people edit descriptions, instructions and example prompts only; synonyms are no longer editable', () => {
    expect(['setDescription', 'setInstructions', 'setExamplePrompts'].map((op) => isEditable(c(op)))).toEqual([true, true, true]);
    expect(isEditable(c('setSynonyms'))).toBe(false);
    expect(isEditable(c('rename'))).toBe(false);
  });
});

describe('summariseChanges', () => {
  it('counts changes by kind, singular or plural, in a stable order', () => {
    const out = summariseChanges([c('addMeasure'), c('setDescription'), c('setDescription'), c('setDescription'), c('rename')]);
    expect(out).toEqual(['3 descriptions', '1 new measure', '1 rename']);
  });

  it('is empty for no changes', () => {
    expect(summariseChanges([])).toEqual([]);
  });
});
