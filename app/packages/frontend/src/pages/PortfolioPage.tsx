import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ScoreChip } from '@/components/ScoreDial';
import { Badge, Button, Card, EmptyState, ErrorState, Kpi, LoadingBlock, Notice, PageHeader, Select, TextInput } from '@/components/ui';
import { cx } from '@/lib/cx';
import { WeaveHero } from '@/components/WeaveHero';
import { api, useAsync, type Portfolio, type PortfolioQuery } from '@/lib/api';
import { TIER_ORDER, formatNumber, relativeTime, toneBar, tierTone } from '@/lib/format';
import { modelHref } from '@/lib/route';
import { scanNotice } from '@/lib/scan';

const PAGE = 25;
type SortBy = NonNullable<PortfolioQuery['sortBy']>;

function TierBar({ totals, active, onPick }: { totals: Portfolio['totals']; active: string; onPick: (tier: string) => void }) {
  const scored = TIER_ORDER.reduce((n, t) => n + (totals.tiers[t] ?? 0), 0);
  if (scored === 0) return <p className="text-300 text-muted-foreground">No scored models yet.</p>;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label="Models by readiness tier">
        {TIER_ORDER.map((tier) => {
          const n = totals.tiers[tier] ?? 0;
          if (n === 0) return null;
          return <div key={tier} className={cx(toneBar[tierTone(tier)], active && active !== tier ? 'opacity-30' : undefined)} style={{ width: `${(n / scored) * 100}%` }} title={`${tier}: ${n}`} />;
        })}
      </div>
      <ul className="mt-300 flex flex-wrap gap-x-500 gap-y-200">
        {TIER_ORDER.map((tier) => (
          <li key={tier}>
            <button
              type="button"
              aria-pressed={active === tier}
              onClick={() => onPick(active === tier ? '' : tier)}
              className={cx('flex items-center gap-200 rounded-md px-200 py-100 text-300 hover:bg-accent', active === tier ? 'bg-accent font-medium' : undefined)}
            >
              <span className={cx('h-2.5 w-2.5 rounded-full', toneBar[tierTone(tier)])} aria-hidden />
              {tier}
              <span className="font-numeric tabular-nums text-muted-foreground">{totals.tiers[tier] ?? 0}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PortfolioBody() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tier, setTier] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const portfolio = useAsync(() => {
    const query: PortfolioQuery = { sortBy, sortDir, offset, limit: PAGE };
    if (debounced) query.search = debounced;
    if (tier) query.tier = tier;
    return api.getPortfolio(query);
  }, [debounced, tier, sortBy, sortDir, offset]);

  const data = portfolio.data;

  if (portfolio.loading && !data) {
    return (
      <>
        <PageHeader as="h2" eyebrow="Portfolio" title="AI-readiness across your estate" />
        <Card>
          <LoadingBlock label="Loading the portfolio" rows={5} />
        </Card>
      </>
    );
  }
  if (portfolio.error && !data) {
    return (
      <>
        <PageHeader as="h2" eyebrow="Portfolio" title="AI-readiness across your estate" />
        <Card>
          <ErrorState message={portfolio.error} onRetry={portfolio.reload} title="The portfolio could not be loaded" />
        </Card>
      </>
    );
  }
  if (!data) return null;

  if (!data.available) {
    const failure = scanNotice(data);
    return (
      <>
        <PageHeader as="h2" eyebrow="Portfolio" title="AI-readiness across your estate" />
        {failure ? (
          <Notice tone={failure.tone} title={failure.title} className="mb-500">
            {failure.body}
          </Notice>
        ) : null}
        <Card>
          <EmptyState
            title="The portfolio has not been built yet"
            action={
              <div className="flex gap-200">
                <a href="#/models" className="inline-flex h-9 items-center rounded-md border border-primary bg-primary px-400 text-300 font-medium text-primary-foreground hover:bg-primary/90">
                  Browse models now
                </a>
                <a href="#/status" className="inline-flex h-9 items-center rounded-md border border-input bg-card px-400 text-300 font-medium hover:bg-accent">
                  Check setup
                </a>
              </div>
            }
          >
            <p>{data.reason ?? 'The scan pipeline has not produced an inventory yet.'}</p>
            <p className="mt-200">The scan notebooks read workspace metadata, usage and model definitions into a Lakehouse. You can already inspect any model from the Models page.</p>
          </EmptyState>
        </Card>
      </>
    );
  }

  const t = data.totals;
  const pages = Math.max(1, Math.ceil(data.total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;
  const ready = t.tiers['AI-ready'] ?? 0;
  const freshness = scanNotice(data);

  return (
    <>
      <PageHeader
        as="h2"
        eyebrow="Portfolio"
        title="AI-readiness across your estate"
        subtitle="Quick scores come from a metadata scan of every model in scope. Open a model for the full assessment, then fix it."
      />

      {freshness ? (
        <Notice tone={freshness.tone} title={freshness.title} className="mb-500">
          {freshness.body}
        </Notice>
      ) : null}

      <div className="mb-500 grid gap-300 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Models" value={formatNumber(t.models)} hint={`${formatNumber(t.workspaces)} workspaces`} />
        <Kpi label="Average score" value={t.averageScore === null ? '—' : t.averageScore.toFixed(1)} hint={`${formatNumber(t.scored)} models scored`} />
        <Kpi label="AI-ready" value={formatNumber(ready)} hint={t.scored > 0 ? `${Math.round((ready / t.scored) * 100)}% of scored models` : undefined} />
        <Kpi label="Unused" value={formatNumber(t.unusedModels)} hint={`${formatNumber(t.withUsage)} models have usage data`} />
      </div>

      <Card className="mb-500">
        <div className="px-500 py-400">
          <TierBar totals={t} active={tier} onPick={(next) => { setTier(next); setOffset(0); }} />
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-300 border-b border-border px-500 py-400">
          <div className="relative min-w-56 flex-1">
            <Search className="icon-size-200 pointer-events-none absolute top-1/2 left-300 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <TextInput aria-label="Search models" placeholder="Search by model or workspace…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-800" />
          </div>
          <Select aria-label="Tier" value={tier} onChange={(e) => { setTier(e.target.value); setOffset(0); }} className="w-44">
            <option value="">All tiers</option>
            {TIER_ORDER.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <Select aria-label="Sort by" value={sortBy} onChange={(e) => { setSortBy(e.target.value as SortBy); setOffset(0); }} className="w-40">
            <option value="score">Sort: score</option>
            <option value="usage">Sort: usage</option>
            <option value="name">Sort: name</option>
            <option value="workspace">Sort: workspace</option>
          </Select>
          <Button variant="secondary" aria-label={sortDir === 'asc' ? 'Ascending' : 'Descending'} onClick={() => { setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); setOffset(0); }}>
            {sortDir === 'asc' ? <ArrowUp className="icon-size-200" aria-hidden /> : <ArrowDown className="icon-size-200" aria-hidden />}
            {sortDir === 'asc' ? 'Low first' : 'High first'}
          </Button>
        </div>

        {data.models.length === 0 ? (
          <EmptyState title="No models match">Change the search or clear the tier filter.</EmptyState>
        ) : (
          <div className={cx('overflow-x-auto', portfolio.loading ? 'opacity-60' : undefined)}>
            <table className="w-full min-w-[56rem] text-left text-300 leading-300">
              <thead className="border-b border-border bg-muted/50 text-200 text-muted-foreground">
                <tr>
                  <th className="px-500 py-300 font-medium">Model</th>
                  <th className="px-300 py-300 font-medium">AI-readiness</th>
                  <th className="px-300 py-300 font-medium">Tier</th>
                  <th className="px-300 py-300 text-right font-medium">Tables / measures</th>
                  <th className="px-300 py-300 text-right font-medium">Views 30d</th>
                  <th className="px-300 py-300 text-right font-medium">Users 30d</th>
                  <th className="px-500 py-300 font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.models.map((m) => {
                  const score = m.deepScore ?? m.quickScore?.score ?? null;
                  const tierName = m.quickScore?.tier ?? null;
                  return (
                    <tr key={`${m.workspaceId}/${m.modelId}`} className="hover:bg-accent/60">
                      <td className="max-w-80 px-500 py-300">
                        <a href={modelHref(m.workspaceId, m.modelId)} className="block truncate font-medium text-primary underline-offset-2 hover:underline">
                          {m.name}
                        </a>
                        <span className="block truncate text-200 text-muted-foreground">{m.workspaceName}</span>
                      </td>
                      <td className="px-300 py-300">
                        {m.scanError ? <Badge tone="warning">not scanned</Badge> : <ScoreChip score={score} />}
                      </td>
                      <td className="px-300 py-300">
                        {tierName && score !== null ? <Badge tone={tierTone(tierName)}>{tierName}</Badge> : <span className="text-muted-foreground">—</span>}
                        {m.deepScore !== null ? <Badge className="ml-100">deep</Badge> : null}
                      </td>
                      <td className="px-300 py-300 text-right font-numeric tabular-nums">
                        {m.tables ?? '—'} / {m.measures ?? '—'}
                      </td>
                      <td className="px-300 py-300 text-right font-numeric tabular-nums">{formatNumber(m.usage?.views30d)}</td>
                      <td className="px-300 py-300 text-right font-numeric tabular-nums">{formatNumber(m.usage?.uniqueUsers30d)}</td>
                      <td className="px-500 py-300 text-200 text-muted-foreground">{m.usage?.lastActivity ? relativeTime(m.usage.lastActivity) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-300 border-t border-border px-500 py-300 text-200 text-muted-foreground">
          <span>
            {data.total} models{data.generatedAt ? ` · scanned ${relativeTime(data.generatedAt)}` : ''}
          </span>
          <span className="flex items-center gap-200">
            <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </Button>
            <span className="font-numeric tabular-nums">
              {page} / {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setOffset(offset + PAGE)}>
              Next
            </Button>
          </span>
        </footer>
      </Card>
    </>
  );
}

export function PortfolioPage() {
  return (
    <>
      <WeaveHero />
      <PortfolioBody />
    </>
  );
}
