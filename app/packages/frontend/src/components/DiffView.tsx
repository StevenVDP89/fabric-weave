import { useMemo } from 'react';

import { Badge } from '@/components/ui';
import { cx } from '@/lib/cx';
import { collapseDiff, diffStats, lineDiff } from '@/lib/diff';

type Part = { path: string; status: 'added' | 'modified' | 'removed'; before?: string; after?: string };

const statusTone = { added: 'success', modified: 'info', removed: 'danger' } as const;

function PartDiff({ part }: { part: Part }) {
  const rows = useMemo(() => {
    const lines = lineDiff(part.before ?? '', part.after ?? '');
    return { stats: diffStats(lines), view: collapseDiff(lines, 2) };
  }, [part.before, part.after]);

  return (
    <details className="group rounded-md border border-border bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-200 px-300 py-200 text-200 leading-300 hover:bg-accent">
        <Badge tone={statusTone[part.status]}>{part.status}</Badge>
        <span className="min-w-0 flex-1 truncate font-monospace">{part.path}</span>
        <span className="font-numeric tabular-nums text-success">+{rows.stats.added}</span>
        <span className="font-numeric tabular-nums text-destructive">−{rows.stats.removed}</span>
      </summary>
      <div className="max-h-96 overflow-auto border-t border-border font-monospace text-200 leading-300">
        {rows.view.map((row, i) =>
          row.kind === 'gap' ? (
            <div key={i} className="bg-muted px-300 py-100 text-center text-muted-foreground">
              {row.hidden} unchanged lines
            </div>
          ) : (
            <div
              key={i}
              className={cx(
                'flex gap-200 px-300 whitespace-pre-wrap break-words',
                row.kind === 'add' ? 'bg-success/10 text-foreground' : row.kind === 'remove' ? 'bg-destructive/10 text-foreground' : 'text-muted-foreground'
              )}
            >
              <span aria-hidden className="w-3 shrink-0 select-none">
                {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}
              </span>
              <span className="min-w-0">{row.text || ' '}</span>
            </div>
          )
        )}
      </div>
    </details>
  );
}

/** Line-level diff of every definition part a change touched; used to show exactly what was written. */
export function DiffView({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return <p className="text-300 text-muted-foreground">No definition parts changed.</p>;
  return (
    <div className="space-y-200">
      {parts.map((p) => (
        <PartDiff key={p.path} part={p} />
      ))}
    </div>
  );
}
