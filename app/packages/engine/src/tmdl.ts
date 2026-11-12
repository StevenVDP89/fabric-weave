/**
 * Minimal, line-preserving TMDL parser.
 *
 * It builds a tree of objects (table > column/measure/partition ...) and keeps
 * original line numbers so that the patcher can edit text in place without
 * re-serialising (and therefore without losing anything it does not understand).
 */

export interface TmdlProp {
  key: string;
  /** Raw text after the colon / equals sign (multi-line values joined with \n). */
  value: string;
  /** First and last (inclusive) original line index of this property. */
  line: number;
  endLine: number;
  isFlag: boolean;
}

export interface TmdlNode {
  kind: string;
  /** Unquoted object name. */
  name: string;
  /** Text after '=' on the header line (default property / expression). */
  inline?: string;
  /** Full expression including continuation lines. */
  expression?: string;
  indent: number;
  /** Original line index of the header line. */
  line: number;
  /** First line of the leading /// description block (== line when none). */
  docStart: number;
  /** Last line of the header + expression continuation. */
  headerEnd: number;
  /** Last line (inclusive) of the whole object block. */
  endLine: number;
  description?: string;
  props: Map<string, TmdlProp>;
  children: TmdlNode[];
}

const KEYWORDS = new Set([
  'model',
  'database',
  'table',
  'column',
  'measure',
  'hierarchy',
  'level',
  'partition',
  'relationship',
  'role',
  'culture',
  'expression',
  'perspective',
  'annotation',
  'calendar',
  'calculationGroup',
  'calculationItem',
  'dataSource',
  'function',
  'ref',
  'tablePermission',
  'columnPermission',
  'linguisticMetadata',
  'translation',
  'extendedProperty',
  'queryGroup',
  'kpi',
  'variation',
  'alternateOf',
  'refreshPolicy',
  'detailRowsDefinition',
  'formatStringDefinition',
  'calculationItems',
  'namedExpression',
]);

interface Line {
  idx: number;
  raw: string;
  text: string;
  indent: number;
  blank: boolean;
}

function toLines(text: string): Line[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  return raw.map((r, idx) => {
    let indent = 0;
    let i = 0;
    while (i < r.length) {
      const c = r[i];
      if (c === '\t') {
        indent += 1;
        i += 1;
      } else if (c === ' ') {
        // Treat each run of 4 spaces as one level; tolerate hand-written 2/4-space TMDL.
        let spaces = 0;
        while (i < r.length && r[i] === ' ') {
          spaces += 1;
          i += 1;
        }
        indent += Math.floor(spaces / 4);
        break;
      } else break;
    }
    const t = r.trim();
    return { idx, raw: r, text: t, indent, blank: t.length === 0 };
  });
}

export function unquoteName(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("'")) {
    // Quoted identifier: '' escapes a quote.
    let out = '';
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 1;
        } else break;
      } else out += s[i];
    }
    return out;
  }
  return s;
}

/** Split "<kw> <name> [= inline]" -> pieces. Handles quoted names containing '='. */
function parseHeader(text: string): { kind: string; name: string; inline?: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)\b\s*(.*)$/.exec(text);
  if (!m) return null;
  const kind = m[1]!;
  if (!KEYWORDS.has(kind)) return null;
  const rest = m[2] ?? '';
  // Property-looking lines such as "annotation Foo = bar" are still headers; but "column: x" is not.
  if (rest.startsWith(':')) return null;
  let name = '';
  let i = 0;
  if (rest.startsWith("'")) {
    let j = 1;
    while (j < rest.length) {
      if (rest[j] === "'") {
        if (rest[j + 1] === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j += 1;
    }
    name = unquoteName(rest.slice(0, j + 1));
    i = j + 1;
  } else {
    const nm = /^[^=\s]+(?:\s+[^=\s]+)*?(?=\s*(?:=|$))/.exec(rest);
    if (nm && nm[0].length > 0) {
      name = nm[0].trim();
      i = nm[0].length;
    } else {
      name = rest.trim();
      i = rest.length;
    }
  }
  const tail = rest.slice(i).trim();
  let inline: string | undefined;
  if (tail.startsWith('=')) inline = tail.slice(1).trim();
  return { kind, name, inline };
}

function isDocLine(text: string): boolean {
  return text.startsWith('///');
}

function docText(text: string): string {
  return text.replace(/^\/\/\/\s?/, '');
}

export function parseTmdl(text: string): TmdlNode[] {
  const lines = toLines(text);
  const roots: TmdlNode[] = [];
  let i = 0;
  const n = lines.length;

  function skipBlank(): void {
    while (i < n && lines[i]!.blank) i++;
  }

  function parseChildren(parent: TmdlNode): void {
    let pendingDocs: Line[] = [];
    while (i < n) {
      const ln = lines[i]!;
      if (ln.blank) {
        i++;
        continue;
      }
      if (ln.indent <= parent.indent) break;
      if (isDocLine(ln.text)) {
        pendingDocs.push(ln);
        i++;
        continue;
      }
      if (ln.text.startsWith('//')) {
        i++;
        continue;
      }
      const hdr = parseHeader(ln.text);
      if (hdr && !/^[A-Za-z]+\s*:/.test(ln.text)) {
        const node = parseNode(hdr, pendingDocs);
        pendingDocs = [];
        parent.children.push(node);
        continue;
      }
      // Property or flag.
      pendingDocs = [];
      const prop = parseProp(ln);
      parent.props.set(prop.key, prop);
      parent.endLine = Math.max(parent.endLine, prop.endLine);
    }
  }

  function parseProp(ln: Line): TmdlProp {
    i++;
    const colon = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/.exec(ln.text);
    if (colon) {
      return { key: colon[1]!, value: colon[2]!.trim(), line: ln.idx, endLine: ln.idx, isFlag: false };
    }
    const eq = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(ln.text);
    if (eq) {
      let value = eq[2]!;
      let end = ln.idx;
      // Multi-line value (e.g. partition source): deeper indented lines or a ``` fence.
      if (value.startsWith('```')) {
        const parts: string[] = [value.replace(/^```/, '')];
        if (!value.slice(3).includes('```')) {
          while (i < n) {
            const l = lines[i]!;
            i++;
            end = l.idx;
            if (l.text.includes('```')) {
              parts.push(l.text.replace(/```.*$/, ''));
              break;
            }
            parts.push(l.raw);
          }
        }
        value = parts.join('\n').trim();
      } else {
        const parts: string[] = value ? [value] : [];
        while (i < n && (lines[i]!.blank || lines[i]!.indent > ln.indent)) {
          const l = lines[i]!;
          i++;
          if (!l.blank) {
            end = l.idx;
            parts.push(l.text);
          }
        }
        value = parts.join('\n');
      }
      return { key: eq[1]!, value, line: ln.idx, endLine: end, isFlag: false };
    }
    // Bare flag (isHidden, isKey ...) or unknown line.
    return { key: ln.text.split(/\s+/)[0]!, value: 'true', line: ln.idx, endLine: ln.idx, isFlag: true };
  }

  function parseNode(
    hdr: { kind: string; name: string; inline?: string },
    docs: Line[],
  ): TmdlNode {
    const ln = lines[i]!;
    const node: TmdlNode = {
      kind: hdr.kind,
      name: hdr.name,
      inline: hdr.inline,
      indent: ln.indent,
      line: ln.idx,
      docStart: docs.length ? docs[0]!.idx : ln.idx,
      headerEnd: ln.idx,
      endLine: ln.idx,
      description: docs.length ? docs.map((d) => docText(d.text)).join('\n') : undefined,
      props: new Map(),
      children: [],
    };
    i++;
    // Expression continuation lines.
    if (hdr.inline !== undefined) {
      const exprParts: string[] = [];
      if (hdr.inline.startsWith('```')) {
        let body = hdr.inline.replace(/^```/, '');
        if (body.includes('```')) {
          exprParts.push(body.replace(/```.*$/, ''));
        } else {
          if (body) exprParts.push(body);
          while (i < n) {
            const l = lines[i]!;
            i++;
            node.headerEnd = l.idx;
            if (l.text.includes('```')) {
              const before = l.text.replace(/```.*$/, '');
              if (before) exprParts.push(before);
              break;
            }
            exprParts.push(l.text);
          }
        }
      } else {
        if (hdr.inline) exprParts.push(hdr.inline);
        while (i < n && (lines[i]!.blank || lines[i]!.indent >= node.indent + 2)) {
          const l = lines[i]!;
          i++;
          if (!l.blank) {
            node.headerEnd = l.idx;
            exprParts.push(l.text);
          }
        }
      }
      node.expression = exprParts.join('\n').trim();
    }
    node.endLine = node.headerEnd;
    parseChildren(node);
    // Extend endLine to cover children.
    for (const c of node.children) node.endLine = Math.max(node.endLine, c.endLine);
    return node;
  }

  const topDocs: Line[] = [];
  while (i < n) {
    skipBlank();
    if (i >= n) break;
    const ln = lines[i]!;
    if (isDocLine(ln.text)) {
      topDocs.push(ln);
      i++;
      continue;
    }
    const hdr = parseHeader(ln.text);
    if (hdr && ln.indent === 0) {
      const node = parseNode(hdr, topDocs.splice(0));
      roots.push(node);
    } else {
      i++;
    }
  }
  return roots;
}

export function propValue(node: TmdlNode, key: string): string | undefined {
  return node.props.get(key)?.value;
}

export function propBool(node: TmdlNode, key: string): boolean | undefined {
  const p = node.props.get(key);
  if (!p) return undefined;
  if (p.isFlag) return true;
  const v = p.value.trim().toLowerCase();
  if (v === 'true' || v === '') return true;
  if (v === 'false') return false;
  return undefined;
}
