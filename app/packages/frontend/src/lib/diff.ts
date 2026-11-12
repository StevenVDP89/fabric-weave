export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

const MAX_LINES = 1500;

/** Line diff via longest common subsequence; falls back to a set comparison for very large parts. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const inB = new Set(b);
    const inA = new Set(a);
    return [
      ...a.filter((line) => !inB.has(line)).map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.filter((line) => !inA.has(line)).map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = a[i] === b[j] ? lcs[(i + 1) * cols + j + 1] + 1 : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      out.push({ kind: 'remove', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'remove', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Keeps changed lines plus `context` unchanged lines around them; collapses the rest into a gap marker. */
export function collapseDiff(lines: DiffLine[], context = 2): (DiffLine | { kind: 'gap'; hidden: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { kind: 'gap'; hidden: number })[] = [];
  let hidden = 0;
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      if (hidden > 0) out.push({ kind: 'gap', hidden });
      hidden = 0;
      out.push(line);
    } else {
      hidden++;
    }
  });
  if (hidden > 0) out.push({ kind: 'gap', hidden });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    if (l.kind === 'remove') removed++;
  }
  return { added, removed };
}
