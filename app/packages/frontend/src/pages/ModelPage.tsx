import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { useRef, type ReactNode } from 'react';

import { ScoreChip } from '@/components/ScoreDial';
import { Badge, Button, Card, ErrorState, LoadingBlock, Notice, Tabs } from '@/components/ui';
import { api, useAction, useAsync } from '@/lib/api';
import { useApp } from '@/lib/use-app';
import { fabricModelUrl, relativeTime, tierTone } from '@/lib/format';
import { modelHref, type ModelTab } from '@/lib/route';
import { AgentsTab } from '@/pages/AgentsTab';
import { ContextTab } from '@/pages/ContextTab';
import { FixTab } from '@/pages/FixTab';
import { OverviewTab } from '@/pages/OverviewTab';
import { SchemaTab } from '@/pages/SchemaTab';

export function ModelPage({ workspaceId, modelId, tab, go }: { workspaceId: string; modelId: string; tab: ModelTab; go: (to: string) => void }) {
  const app = useApp();
  const judged = useRef(false);
  const assessment = useAsync(() => api.assessModel(workspaceId, modelId, judged.current), [workspaceId, modelId]);
  const judge = useAction(async () => {
    const res = await api.assessModel(workspaceId, modelId, true);
    judged.current = true;
    assessment.setData(res);
    return res;
  });

  const data = assessment.data;
  const workspace = app.workspaces?.find((w) => w.id === workspaceId);
  const llmConfigured = app.status?.llm.configured;

  if (assessment.loading && !data) {
    return (
      <Card>
        <LoadingBlock label="Reading the model definition and scoring it. Large models take a little longer." rows={5} />
      </Card>
    );
  }
  if (assessment.error && !data) {
    return (
      <Card>
        <ErrorState title="This model could not be assessed" message={assessment.error} onRetry={assessment.reload} />
      </Card>
    );
  }
  if (!data) return null;

  const tabs: { id: ModelTab; label: string; badge?: ReactNode }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'model', label: 'Model' },
    { id: 'fix', label: 'Fix workbench', badge: data.score.findingsTotal > 0 ? <Badge tone="warning">{data.score.findingsTotal}</Badge> : undefined },
    { id: 'context', label: 'Context' },
    { id: 'agents', label: 'Agent availability' },
  ];

  return (
    <div>
      <a href="#/models" className="mb-300 inline-flex items-center gap-100 text-200 font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="icon-size-200" aria-hidden /> All models
      </a>
      <div className="mb-500 flex flex-wrap items-end justify-between gap-400">
        <div className="min-w-0">
          <p className="font-numeric text-100 tracking-[0.14em] text-muted-foreground uppercase">{data.workspaceName}</p>
          <h1 className="mt-100 truncate font-heading text-hero-700 leading-hero-700 font-semibold tracking-tight">{data.modelName}</h1>
          <div className="mt-200 flex flex-wrap items-center gap-300 text-200 text-muted-foreground">
            <ScoreChip score={data.score.score} />
            <Badge tone={tierTone(data.score.tier)}>{data.score.tier}</Badge>
            <span>Assessed {relativeTime(data.assessedAt)}</span>
            {data.lastRefresh?.endTime ? <span>Last refresh {relativeTime(data.lastRefresh.endTime)}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-200">
          <Button icon={<RefreshCw className="icon-size-200" aria-hidden />} busy={assessment.loading} onClick={assessment.reload}>
            Re-assess
          </Button>
          <a
            href={fabricModelUrl(workspaceId, modelId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-200 rounded-md border border-input bg-card px-400 text-300 font-medium hover:bg-accent"
          >
            Open in Fabric <ExternalLink className="icon-size-200" aria-hidden />
          </a>
        </div>
      </div>

      {assessment.error ? (
        <Notice tone="warning" title="The last refresh failed" className="mb-400">
          {assessment.error} The scores below are from the previous read.
        </Notice>
      ) : null}

      <div className="mb-500">
        <Tabs label="Model sections" tabs={tabs} value={tab} onChange={(id) => go(modelHref(workspaceId, modelId, id))} />
      </div>

      {tab === 'overview' ? (
        <OverviewTab data={data} judging={judge.busy} judgeActionError={judge.error} onRunJudge={() => void judge.run()} llmConfigured={llmConfigured} />
      ) : null}
      {tab === 'model' ? <SchemaTab tree={data.tree} /> : null}
      {tab === 'fix' ? <FixTab assessment={data} workspace={workspace} llmConfigured={Boolean(llmConfigured)} onChanged={assessment.reload} /> : null}
      {tab === 'context' ? <ContextTab assessment={data} llmConfigured={Boolean(llmConfigured)} actor={app.status?.actor ?? 'unknown'} onSaved={assessment.reload} /> : null}
      {tab === 'agents' ? <AgentsTab assessment={data} /> : null}
    </div>
  );
}
