import { Sparkles } from 'lucide-react';

import { FindingsPanel } from '@/components/FindingsPanel';
import { CategoryBars, ScoreDial } from '@/components/ScoreDial';
import { Badge, Button, Card, CardHeader, Notice } from '@/components/ui';
import { cx } from '@/lib/cx';
import type { Assessment } from '@/lib/api';
import { formatNumber, formatScore, relativeTime, toneForScore, toneText } from '@/lib/format';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-200 leading-200 text-muted-foreground">{label}</dt>
      <dd className="font-numeric text-500 leading-500 font-medium tabular-nums">{value}</dd>
      {hint ? <p className="text-100 leading-100 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Quality({ label, value }: { label: string; value: number | null }) {
  const pct = value === null ? null : value * 100;
  return (
    <div>
      <p className="text-200 leading-200 text-muted-foreground">{label}</p>
      <p className={cx('font-numeric text-500 leading-500 font-medium', toneText[toneForScore(pct)])}>{pct === null ? '—' : `${Math.round(pct)}%`}</p>
    </div>
  );
}

export function OverviewTab({
  data,
  judging,
  judgeActionError,
  onRunJudge,
  llmConfigured,
}: {
  data: Assessment;
  judging: boolean;
  judgeActionError: string | null;
  onRunJudge: () => void;
  llmConfigured: boolean | undefined;
}) {
  const { score, tree, judge } = data;
  const triggered = score.gates.filter((g) => g.triggered);
  const refresh = data.lastRefresh;

  return (
    <div className="grid gap-500 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <Card className="self-start">
        <div className="px-500 pt-500 pb-400">
          <ScoreDial score={score.score} tier={score.tier} />
        </div>
        <div className="border-t border-border px-500 py-400">
          <p className="mb-200 text-200 leading-200 text-muted-foreground">
            {score.mode === 'deep' ? 'Deep assessment from the full model definition.' : 'Quick assessment from metadata only.'} Raw score before gates:{' '}
            <span className="font-numeric">{formatScore(score.rawScore)}</span>
          </p>
          {triggered.length > 0 ? (
            <div className="space-y-200">
              {triggered.map((g) => (
                <Notice key={g.id} tone="warning" title={`${g.title} — capped at ${g.cap}`}>
                  This gate limits the overall score until it is resolved.
                </Notice>
              ))}
            </div>
          ) : (
            <p className="text-200 leading-200 text-muted-foreground">No score caps apply.</p>
          )}
        </div>
      </Card>

      <div className="min-w-0 space-y-500">
        <Card>
          <CardHeader title="Readiness by category" subtitle={`Rule catalog v${score.catalogVersion}`} />
          <div className="grid gap-600 px-500 py-400 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
            <CategoryBars categories={score.categories} />
            <dl className="grid grid-cols-2 content-start gap-400 md:grid-cols-1">
              <Stat label="Tables" value={`${score.stats.visibleTables} / ${score.stats.tables}`} hint="visible / total" />
              <Stat label="Measures" value={`${score.stats.visibleMeasures} / ${score.stats.measures}`} hint="visible / total" />
              <Stat label="Columns" value={`${formatNumber(score.stats.visibleColumns)} / ${formatNumber(score.stats.columns)}`} hint="visible / total" />
              <Stat label="Relationships" value={String(score.stats.relationships)} />
            </dl>
          </div>
          <div className="flex flex-wrap items-center gap-x-500 gap-y-100 border-t border-border px-500 py-300 text-200 leading-200 text-muted-foreground">
            <span>
              Instructions:{' '}
              <span className="font-medium text-foreground">{tree.instructions ? `${tree.instructions.length.toLocaleString()} chars` : 'none'}</span>
            </span>
            <span>
              Example prompts: <span className="font-medium text-foreground">{tree.examplePrompts.length}</span>
            </span>
            <span>
              Verified answers: <span className="font-medium text-foreground">{tree.verifiedAnswerCount}</span>
            </span>
            <span>
              Last refresh:{' '}
              <span className="font-medium text-foreground">
                {refresh?.endTime ? `${relativeTime(refresh.endTime)}${refresh.status ? ` (${refresh.status})` : ''}` : 'unknown'}
              </span>
            </span>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="AI review"
            subtitle="A language model reads the descriptions and instructions and grades their quality. Only metadata and your own text are sent; row data never leaves the model."
            actions={
              <Button
                variant={judge ? 'secondary' : 'primary'}
                size="sm"
                busy={judging}
                icon={<Sparkles className="icon-size-200" aria-hidden />}
                disabled={llmConfigured === false}
                onClick={onRunJudge}
              >
                {judge ? 'Re-run AI review' : 'Run AI review'}
              </Button>
            }
          />
          <div className="space-y-300 px-500 py-400">
            {llmConfigured === false ? (
              <Notice tone="warning" title="No language model is configured">
                Set the AOAI_ENDPOINT and AOAI_DEPLOYMENT secrets (see the Status page). The deterministic score above does not need one.
              </Notice>
            ) : null}
            {judgeActionError ? <Notice tone="danger" title="AI review failed">{judgeActionError}</Notice> : null}
            {data.judgeError && !judgeActionError ? <Notice tone="warning" title="AI review unavailable">{data.judgeError}</Notice> : null}
            {judge ? (
              <>
                <div className="flex flex-wrap gap-600">
                  <Quality label="Description quality" value={judge.descriptionQuality} />
                  <Quality label="Instruction quality" value={judge.instructionQuality} />
                </div>
                {judge.notes ? <p className="text-300 leading-300">{judge.notes}</p> : null}
                {judge.descriptionIssues.length > 0 ? (
                  <ul className="space-y-100 rounded-md border border-border bg-muted/50 p-300">
                    {judge.descriptionIssues.slice(0, 12).map((issue, i) => (
                      <li key={`${issue.path}-${i}`} className="text-200 leading-300">
                        <Badge tone="warning" className="mr-200">
                          {issue.path}
                        </Badge>
                        {issue.problem}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : !data.judgeError && llmConfigured !== false ? (
              <p className="text-300 leading-300 text-muted-foreground">Not run yet. The AI review adds two qualitative rules (description and instruction quality) to the score.</p>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="min-w-0 lg:col-span-2">
        <FindingsPanel score={score} />
      </div>
    </div>
  );
}
