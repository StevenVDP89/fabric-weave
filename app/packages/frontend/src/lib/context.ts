/** The longest context description Fabric Weave stores (matches the `context_text` column). */
export const CONTEXT_TEXT_MAX = 4000;

/** The structured shape older entries and AI drafts use. */
export interface StructuredContext {
  description?: string | null;
  domain?: string | null;
  audience?: string | null;
  defaultTimeFrame?: string | null;
  fiscalYearStart?: string | null;
  preferredMeasures?: readonly string[] | null;
  glossary?: readonly { term: string; meaning: string }[] | null;
  notes?: string | null;
}

export function clipContext(text: string): string {
  return text.length > CONTEXT_TEXT_MAX ? text.slice(0, CONTEXT_TEXT_MAX) : text;
}

/** Turns the structured fields into the plain description that replaces them. Empty when nothing is filled in. */
export function composeContextText(c: StructuredContext): string {
  const lines: string[] = [];
  const add = (value: string | null | undefined, format: (v: string) => string) => {
    const v = value?.trim();
    if (v) lines.push(format(v));
  };
  add(c.description, (v) => v);
  add(c.domain, (v) => `This model is used for ${v}.`);
  add(c.audience, (v) => `Questions come from: ${v}.`);
  add(c.defaultTimeFrame, (v) => `Default time frame: ${v}.`);
  add(c.fiscalYearStart, (v) => `The fiscal year starts in ${v}.`);
  const measures = (c.preferredMeasures ?? []).map((m) => m.trim()).filter(Boolean);
  if (measures.length > 0) lines.push(`Preferred measures: ${measures.map((m) => `[${m}]`).join(', ')}.`);
  const terms = (c.glossary ?? []).filter((g) => g.term.trim() && g.meaning.trim());
  if (terms.length > 0) lines.push('Terms:', ...terms.map((g) => `- ${g.term.trim()}: ${g.meaning.trim()}`));
  add(c.notes, (v) => v);
  return clipContext(lines.join('\n'));
}

/** Adds a draft to what the person already wrote, never replacing it. */
export function appendContext(current: string, addition: string): string {
  const base = current.trim();
  const extra = addition.trim();
  if (!extra) return current;
  if (!base) return clipContext(extra);
  return clipContext(`${base}\n\n${extra}`);
}

/** Joins a dictated phrase to the text so far with exactly one space (or a fresh line after a newline). */
export function appendDictation(current: string, spoken: string): string {
  const phrase = spoken.trim();
  if (!phrase) return current;
  if (!current.trim()) return phrase;
  const separator = /\s$/.test(current) ? '' : ' ';
  return `${current}${separator}${phrase}`;
}

export const INTERVIEW_AREAS = [
  'Purpose and audience',
  'Terms and abbreviations',
  'Preferred measures',
  'Time frame and calendar',
  'Default filters',
  'Data quirks and limits',
] as const;
