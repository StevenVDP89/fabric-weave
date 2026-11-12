import { ChevronDown, ChevronRight, EyeOff, Search, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge, Card, CardHeader, Mono, Notice, TextInput } from '@/components/ui';
import { cx } from '@/lib/cx';
import type { Assessment } from '@/lib/api';

type Tree = Assessment['tree'];
type Table = Tree['tables'][number];

function Missing({ children = 'no description' }: { children?: string }) {
  return <span className="text-200 text-warning italic">{children}</span>;
}

function TableRow({ table, query }: { table: Table; query: string }) {
  const [open, setOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const columns = q ? table.columns.filter((c) => c.name.toLowerCase().includes(q)) : table.columns;
  const measures = q ? table.measures.filter((m) => m.name.toLowerCase().includes(q)) : table.measures;
  const expanded = open || (q.length > 0 && (columns.length > 0 || measures.length > 0));
  const undescribed = table.columns.filter((c) => !c.hidden && !c.description).length + table.measures.filter((m) => !m.hidden && !m.description).length;

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-300 px-500 py-300 text-left hover:bg-accent"
      >
        {expanded ? <ChevronDown className="icon-size-200 shrink-0" aria-hidden /> : <ChevronRight className="icon-size-200 shrink-0" aria-hidden />}
        <Table2 className="icon-size-200 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cx('min-w-0 flex-1 truncate text-300 leading-300 font-medium', table.hidden ? 'text-muted-foreground' : undefined)}>{table.name}</span>
        <span className="hidden items-center gap-200 sm:flex">
          {table.hidden ? (
            <Badge>
              <EyeOff className="icon-size-100" aria-hidden /> hidden
            </Badge>
          ) : null}
          {table.calculated ? <Badge tone="info">calculated</Badge> : null}
          {!table.description && !table.hidden ? <Badge tone="warning">no description</Badge> : null}
          <span className="font-numeric text-200 text-muted-foreground">
            {table.columns.length} cols · {table.measures.length} measures
          </span>
          {undescribed > 0 ? <Badge tone="warning">{undescribed} undescribed</Badge> : null}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border bg-muted/40 px-500 py-300">
          {table.description ? <p className="mb-300 text-200 leading-300 text-muted-foreground">{table.description}</p> : null}
          {measures.length > 0 ? (
            <>
              <p className="mb-100 font-numeric text-100 tracking-[0.14em] text-muted-foreground uppercase">Measures</p>
              <ul className="mb-300 space-y-200">
                {measures.map((m) => (
                  <li key={m.name} className="rounded-md border border-border bg-card px-300 py-200">
                    <div className="flex flex-wrap items-center gap-200">
                      <span className={cx('text-300 font-medium', m.hidden ? 'text-muted-foreground' : undefined)}>{m.name}</span>
                      {m.hidden ? <Badge>hidden</Badge> : null}
                      {m.formatString ? <Badge>{m.formatString}</Badge> : <Badge tone="warning">no format</Badge>}
                      {m.aiVisibility === 'Hidden' ? <Badge tone="info">hidden from AI</Badge> : null}
                    </div>
                    {m.description ? <p className="mt-100 text-200 leading-300 text-muted-foreground">{m.description}</p> : <Missing />}
                    <Mono className="mt-100 block max-h-20 overflow-hidden text-muted-foreground">{m.expression}</Mono>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {columns.length > 0 ? (
            <>
              <p className="mb-100 font-numeric text-100 tracking-[0.14em] text-muted-foreground uppercase">Columns</p>
              <div className="overflow-x-auto rounded-md border border-border bg-card">
                <table className="w-full text-left text-200 leading-300">
                  <thead className="border-b border-border bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-300 py-200 font-medium">Name</th>
                      <th className="px-300 py-200 font-medium">Type</th>
                      <th className="px-300 py-200 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {columns.map((c) => (
                      <tr key={c.name} className={c.hidden ? 'text-muted-foreground' : undefined}>
                        <td className="px-300 py-200 font-medium whitespace-nowrap">
                          {c.name}
                          {c.hidden ? <EyeOff className="icon-size-100 ml-100 inline" aria-label="hidden" /> : null}
                        </td>
                        <td className="px-300 py-200 font-numeric whitespace-nowrap">{c.dataType}</td>
                        <td className="px-300 py-200">{c.description ?? (c.hidden ? '—' : <Missing>missing</Missing>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function SchemaTab({ tree }: { tree: Tree }) {
  const [query, setQuery] = useState('');
  const tables = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tree.tables;
    return tree.tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q)) || t.measures.some((m) => m.name.toLowerCase().includes(q)));
  }, [tree.tables, query]);

  return (
    <div className="grid gap-500 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <Card className="min-w-0">
        <CardHeader
          title="Tables, columns and measures"
          subtitle="Warnings mark visible objects that Copilot has no description for."
          actions={
            <div className="relative w-64">
              <Search className="icon-size-200 pointer-events-none absolute top-1/2 left-300 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <TextInput aria-label="Search the model" placeholder="Search objects…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-800" />
            </div>
          }
        />
        {tree.truncated ? (
          <div className="px-500 pt-400">
            <Notice tone="caution" title="Large model">
              Only part of the model is shown. Scoring always covers the whole model.
            </Notice>
          </div>
        ) : null}
        {tables.length === 0 ? (
          <p className="px-500 py-600 text-center text-300 text-muted-foreground">Nothing matches “{query}”.</p>
        ) : (
          <ul className="divide-y divide-border">
            {tables.map((t) => (
              <TableRow key={t.name} table={t} query={query} />
            ))}
          </ul>
        )}
      </Card>

      <div className="min-w-0 space-y-500">
        <Card>
          <CardHeader title="AI instructions" subtitle={tree.hasSchema ? 'Prep-for-AI is configured.' : 'Prep-for-AI has not been configured.'} />
          <div className="px-500 py-400">
            {tree.instructions ? (
              <pre className="max-h-72 overflow-auto font-base text-200 leading-300 whitespace-pre-wrap">{tree.instructions}</pre>
            ) : (
              <p className="text-300 leading-300 text-warning">No AI instructions yet. Add them in the Fix workbench.</p>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Example prompts" subtitle="Shown to users as suggestions in Copilot." />
          <div className="px-500 py-400">
            {tree.examplePrompts.length > 0 ? (
              <ul className="list-inside list-disc space-y-100 text-300 leading-300">
                {tree.examplePrompts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="text-300 leading-300 text-warning">No example prompts yet.</p>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Relationships" subtitle={`${tree.relationships.length} defined`} />
          {tree.relationships.length === 0 ? (
            <p className="px-500 py-400 text-300 text-warning">No relationships. Copilot cannot combine tables without them.</p>
          ) : (
            <ul className="divide-y divide-border">
              {tree.relationships.map((r) => (
                <li key={r.name} className="px-500 py-300 text-200 leading-300">
                  <span className="font-medium">
                    {r.fromTable}[{r.fromColumn}]
                  </span>{' '}
                  <span className="text-muted-foreground">
                    {r.fromCardinality === 'many' ? '∗' : '1'} → {r.toCardinality === 'many' ? '∗' : '1'}
                  </span>{' '}
                  <span className="font-medium">
                    {r.toTable}[{r.toColumn}]
                  </span>
                  <span className="ml-200 inline-flex gap-100">
                    {!r.isActive ? <Badge tone="warning">inactive</Badge> : null}
                    {r.crossFilter === 'both' ? <Badge tone="info">both directions</Badge> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
