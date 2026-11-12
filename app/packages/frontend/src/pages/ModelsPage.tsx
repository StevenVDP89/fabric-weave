import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ScoreChip } from '@/components/ScoreDial';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, TextInput } from '@/components/ui';
import { cx } from '@/lib/cx';
import { api, useAsync } from '@/lib/api';
import { useApp } from '@/lib/use-app';
import { relativeTime, tierTone } from '@/lib/format';
import { modelHref } from '@/lib/route';

const STORAGE_KEY = 'airc.workspace';

function remembered(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function ModelsPage() {
  const app = useApp();
  const [picked, setSelected] = useState<string | null>(remembered);
  const [filter, setFilter] = useState('');
  const [wsFilter, setWsFilter] = useState('');

  const workspaces = app.workspaces;
  // A remembered workspace may no longer exist; fall back to the first in-scope one.
  const selected = picked && workspaces?.some((w) => w.id === picked) ? picked : workspaces?.length ? (workspaces.find((w) => w.inScope) ?? workspaces[0]).id : null;

  useEffect(() => {
    if (!selected) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, selected);
    } catch {
      // sessionStorage can be blocked inside embedded frames; the selection is then just not remembered
    }
  }, [selected]);

  const models = useAsync(() => (selected ? api.listModels(selected) : Promise.resolve([])), [selected]);
  const current = workspaces?.find((w) => w.id === selected);

  const visibleWorkspaces = useMemo(() => {
    const q = wsFilter.trim().toLowerCase();
    return (workspaces ?? []).filter((w) => !q || w.name.toLowerCase().includes(q));
  }, [workspaces, wsFilter]);

  const visibleModels = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (models.data ?? []).filter((m) => !q || m.name.toLowerCase().includes(q));
  }, [models.data, filter]);

  return (
    <>
      <PageHeader eyebrow="Models" title="Inspect a semantic model" subtitle="Pick a workspace, open a model, and Fabric Weave reads its definition, scores it and proposes fixes." />

      <div className="grid gap-500 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <Card className="self-start">
          <div className="border-b border-border px-400 py-300">
            <div className="relative">
              <Search className="icon-size-200 pointer-events-none absolute top-1/2 left-300 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <TextInput aria-label="Filter workspaces" placeholder="Filter workspaces…" value={wsFilter} onChange={(e) => setWsFilter(e.target.value)} className="pl-800" />
            </div>
          </div>
          {app.workspacesLoading && !workspaces ? (
            <LoadingBlock rows={4} />
          ) : app.workspacesError ? (
            <ErrorState message={app.workspacesError} onRetry={app.reloadWorkspaces} title="Workspaces unavailable" />
          ) : visibleWorkspaces.length === 0 ? (
            <EmptyState title="No workspaces">The app’s identity has not been added to any workspace yet. Add it as a Member or Contributor.</EmptyState>
          ) : (
            <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto" aria-label="Workspaces">
              {visibleWorkspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    aria-current={w.id === selected}
                    onClick={() => setSelected(w.id)}
                    className={cx('flex w-full flex-col items-start gap-100 px-400 py-300 text-left hover:bg-accent', w.id === selected ? 'bg-accent' : undefined)}
                  >
                    <span className="w-full truncate text-300 leading-300 font-medium">{w.name}</span>
                    <span className="flex flex-wrap gap-100">
                      {w.inScope ? <Badge tone="success">in scope · {w.writeMode}</Badge> : <Badge>read only</Badge>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="min-w-0">
          <header className="flex flex-wrap items-center justify-between gap-300 border-b border-border px-500 py-400">
            <div className="min-w-0">
              <h2 className="truncate font-heading text-400 leading-400 font-semibold">{current?.name ?? 'Models'}</h2>
              <p className="mt-100 text-200 text-muted-foreground">{models.data ? `${models.data.length} semantic models` : 'Loading models'}</p>
            </div>
            <div className="relative w-64">
              <Search className="icon-size-200 pointer-events-none absolute top-1/2 left-300 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <TextInput aria-label="Filter models" placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-800" />
            </div>
          </header>
          {models.loading && !models.data ? (
            <LoadingBlock label="Listing semantic models" rows={4} />
          ) : models.error ? (
            <ErrorState message={models.error} onRetry={models.reload} title="Models could not be listed" />
          ) : visibleModels.length === 0 ? (
            <EmptyState title={filter ? 'No models match' : 'No semantic models in this workspace'}>{filter ? 'Clear the filter to see every model.' : 'Publish a model here, or pick another workspace.'}</EmptyState>
          ) : (
            <ul className={cx('divide-y divide-border', models.loading ? 'opacity-60' : undefined)}>
              {visibleModels.map((m) => (
                <li key={m.id}>
                  <a href={modelHref(m.workspaceId, m.id)} className="flex flex-wrap items-center gap-300 px-500 py-300 hover:bg-accent">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-300 leading-300 font-medium text-primary">{m.name}</span>
                      {m.description ? <span className="block truncate text-200 text-muted-foreground">{m.description}</span> : null}
                    </span>
                    {m.assessment ? (
                      <>
                        {m.assessment.approvedForCopilot ? <Badge tone="success">approved for Copilot</Badge> : null}
                        <Badge tone={tierTone(m.assessment.tier)}>{m.assessment.tier}</Badge>
                        <ScoreChip score={m.assessment.score} />
                        <span className="w-24 text-right text-200 text-muted-foreground">{relativeTime(m.assessment.assessedAt)}</span>
                      </>
                    ) : (
                      <Badge>not assessed yet</Badge>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
