import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui';
import { cx } from '@/lib/cx';
import type { Assessment } from '@/lib/api';
import { groupFindingsByCategory, severityCounts, type CategoryGroup } from '@/lib/findingGroups';
import { formatScore, toneBar, toneForScore, toneStroke, toneText, type Tone } from '@/lib/format';

const severityTone: Record<string, Tone> = { critical: 'danger', major: 'warning', minor: 'caution', info: 'neutral' };
const severityLabel: Record<string, string> = { critical: 'Critical', major: 'Major', minor: 'Minor', info: 'Info' };
const ITEM_LIMIT = 80;

/** Circular readout of a category score, tinted by tier. */
function ScoreRing({ score }: { score: number }) {
  const tone = toneForScore(score);
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="relative size-14 shrink-0" role="img" aria-label={`Category score ${formatScore(score)} out of 100`}>
      <svg viewBox="0 0 56 56" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx={28} cy={28} r={22} fill="none" strokeWidth={5} className="stroke-muted" />
        <circle cx={28} cy={28} r={22} fill="none" strokeWidth={5} strokeLinecap="round" pathLength={100} strokeDasharray={100} strokeDashoffset={100 - pct} className={toneStroke[tone]} />
      </svg>
      <span className={cx('absolute inset-0 grid place-items-center font-numeric text-300 font-medium tabular-nums', toneText[tone])}>{Math.round(score)}</span>
    </div>
  );
}

function SeverityChips({ counts }: { counts: { severity: string; count: number }[] }) {
  return (
    <div className="flex flex-wrap gap-200">
      {counts.map((c) => (
        <Badge key={c.severity} tone={severityTone[c.severity] ?? 'neutral'}>
          <span className="font-numeric tabular-nums">{c.count.toLocaleString()}</span> {severityLabel[c.severity] ?? c.severity}
        </Badge>
      ))}
    </div>
  );
}

function CategoryCard({ category, open, onToggle }: { category: CategoryGroup; open: string | null; onToggle: (key: string | null) => void }) {
  const tone = toneForScore(category.score);
  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground" aria-label={category.title}>
      <div className={cx('h-1', toneBar[tone])} aria-hidden />
      <header className="flex items-start gap-400 p-400">
        <ScoreRing score={category.score} />
        <div className="min-w-0 flex-1 space-y-200">
          <div>
            <h3 className="font-heading text-400 leading-400 font-semibold tracking-tight">{category.title}</h3>
            <p className="text-200 leading-200 text-muted-foreground">
              {category.count.toLocaleString()} {category.count === 1 ? 'finding' : 'findings'} in {category.rules.length} {category.rules.length === 1 ? 'check' : 'checks'}
            </p>
          </div>
          <SeverityChips counts={category.severities} />
        </div>
        {category.pointsLost >= 0.05 ? (
          <div className="shrink-0 text-right">
            <p className="font-numeric text-400 leading-400 font-medium text-success tabular-nums">+{formatScore(category.pointsLost)}</p>
            <p className="text-100 leading-100 text-muted-foreground">pts to gain</p>
          </div>
        ) : null}
      </header>
      <ul className="border-t border-border">
        {category.rules.map((rule) => {
          const key = `${category.id}:${rule.key}`;
          const expanded = open === key;
          const ruleTone = severityTone[rule.severity] ?? 'neutral';
          return (
            <li key={key} className="border-b border-border last:border-b-0">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => onToggle(expanded ? null : key)}
                className="flex w-full items-start gap-300 px-400 py-300 text-left hover:bg-accent"
              >
                <span className={cx('mt-200 size-2 shrink-0 rounded-full', toneBar[ruleTone])} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-300 leading-300 font-medium">{rule.title}</span>
                  <span className="mt-100 block text-200 leading-200 text-muted-foreground">
                    <span className={cx('font-medium', toneText[ruleTone])}>{severityLabel[rule.severity] ?? rule.severity}</span>
                    {!expanded && rule.items[0]?.message ? <span className="line-clamp-1"> · {rule.items[0].message}</span> : null}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-200">
                  <span className="rounded-full bg-muted px-300 py-100 font-numeric text-200 leading-200 font-medium tabular-nums">{rule.count.toLocaleString()}</span>
                  {expanded ? <ChevronDown className="icon-size-200" aria-hidden /> : <ChevronRight className="icon-size-200" aria-hidden />}
                </span>
              </button>
              {expanded ? (
                <div className="space-y-300 border-t border-border bg-muted/50 px-400 py-400">
                  {rule.rationale ? <p className="text-200 leading-300 text-muted-foreground">{rule.rationale}</p> : null}
                  {rule.remediation ? (
                    <p className="text-200 leading-300">
                      <span className="font-semibold">How to fix: </span>
                      {rule.remediation}
                    </p>
                  ) : null}
                  <ul className="max-h-72 space-y-100 overflow-y-auto rounded-md border border-border bg-card p-300">
                    {rule.items.slice(0, ITEM_LIMIT).map((f, i) => (
                      <li key={`${f.objectPath}-${i}`} className="text-200 leading-300">
                        <span className="font-monospace break-all text-foreground">{f.objectPath || f.objectType}</span>
                        <span className="text-muted-foreground"> — {f.message}</span>
                      </li>
                    ))}
                    {rule.count > ITEM_LIMIT ? <li className="text-200 text-muted-foreground">+ {(rule.count - ITEM_LIMIT).toLocaleString()} more</li> : null}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function ClearCard({ title, score }: { title: string; score: number }) {
  return (
    <article className="flex items-center gap-400 overflow-hidden rounded-lg border border-border bg-card p-400 text-card-foreground" aria-label={title}>
      <ScoreRing score={score} />
      <div className="min-w-0 flex-1">
        <h3 className="font-heading text-400 leading-400 font-semibold tracking-tight">{title}</h3>
        <p className="mt-100 flex items-center gap-100 text-200 leading-200 text-success">
          <CheckCircle2 className="icon-size-200" aria-hidden /> No findings
        </p>
      </div>
    </article>
  );
}

/** Findings as one card per readiness category, the ones that cost the most points first. */
export function FindingsPanel({ score }: { score: Assessment['score'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const categories = useMemo(() => groupFindingsByCategory(score), [score]);
  const clear = useMemo(() => score.categories.filter((c) => !categories.some((g) => g.id === c.id)), [score, categories]);
  const totals = useMemo(() => severityCounts(categories.flatMap((c) => c.rules)), [categories]);

  return (
    <section aria-label="Findings" className="space-y-400">
      <div className="flex flex-wrap items-end justify-between gap-300">
        <div className="min-w-0">
          <h2 className="font-heading text-400 leading-400 font-semibold tracking-tight">Findings</h2>
          <p className="mt-100 text-200 leading-200 text-muted-foreground">
            {categories.length === 0
              ? 'Every rule that could be evaluated passed.'
              : `${score.findingsTotal.toLocaleString()} ${score.findingsTotal === 1 ? 'finding' : 'findings'} across ${categories.length} readiness ${categories.length === 1 ? 'category' : 'categories'}, the costliest first. Open the Fix workbench to resolve them.`}
            {score.findingsTotal > score.findings.length ? ` Showing the first ${score.findings.length.toLocaleString()}.` : ''}
          </p>
        </div>
        {totals.length > 0 ? <SeverityChips counts={totals} /> : null}
      </div>

      {categories.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-500 py-600 text-center text-300 text-muted-foreground">No findings. Every rule that could be evaluated passed.</p>
      ) : (
        <div className="grid items-start gap-400 xl:grid-cols-2">
          {categories.map((category) => (
            <CategoryCard key={category.id} category={category} open={open} onToggle={setOpen} />
          ))}
        </div>
      )}

      {clear.length > 0 ? (
        <div className="grid gap-400 sm:grid-cols-2 xl:grid-cols-3">
          {clear.map((c) => (
            <ClearCard key={c.id} title={c.title} score={c.score} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
