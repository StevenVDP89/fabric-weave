import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge, Button, Card, CardHeader, ErrorState, LoadingBlock, Notice, Toggle } from '@/components/ui';
import { cx } from '@/lib/cx';
import { api, useAction, useAsync, type Assessment, type Readiness } from '@/lib/api';
import { fabricModelUrl, formatDateTime, toneSoft, type Tone } from '@/lib/format';

type Check = Readiness['checks'][number];
type Status = Check['status'];

const statusTone: Record<Status, Tone> = { pass: 'success', warn: 'caution', fail: 'danger', unknown: 'neutral' };
const statusLabel: Record<Status, string> = { pass: 'Ready', warn: 'Needs attention', fail: 'Blocked', unknown: 'Cannot verify' };
const statusIcon: Record<Status, ReactNode> = {
  pass: <CheckCircle2 className="icon-size-300 shrink-0 text-success" aria-hidden />,
  warn: <AlertTriangle className="icon-size-300 shrink-0 text-caution" aria-hidden />,
  fail: <XCircle className="icon-size-300 shrink-0 text-destructive" aria-hidden />,
  unknown: <CircleHelp className="icon-size-300 shrink-0 text-muted-foreground" aria-hidden />,
};
const ownerLabel: Record<Check['owner'], string> = {
  app: 'Fix in this app',
  'model-owner': 'Model owner',
  'workspace-admin': 'Workspace admin',
  'tenant-admin': 'Tenant admin',
};
const levels: { id: Check['level']; title: string; hint: string }[] = [
  { id: 'tenant', title: 'Tenant', hint: 'Fabric admin portal settings.' },
  { id: 'workspace', title: 'Workspace', hint: 'Capacity and licence of the workspace that holds the model.' },
  { id: 'model', title: 'Model', hint: 'What the model itself needs so agents can use it.' },
];

function CheckRow({ check }: { check: Check }) {
  return (
    <li className="flex gap-300 px-500 py-300">
      {statusIcon[check.status]}
      <div className="min-w-0 flex-1 space-y-100">
        <div className="flex flex-wrap items-center gap-200">
          <p className="text-300 leading-300 font-medium">{check.title}</p>
          <Badge tone={statusTone[check.status]}>{statusLabel[check.status]}</Badge>
          {check.status !== 'pass' ? <Badge>{ownerLabel[check.owner]}</Badge> : null}
        </div>
        <p className="text-200 leading-300 text-muted-foreground">{check.detail}</p>
        {check.action ? <p className="text-200 leading-300">{check.action}</p> : null}
        {check.link && check.status !== 'pass' ? (
          <a href={check.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-100 text-200 font-medium text-primary underline-offset-2 hover:underline">
            Open in Fabric <ExternalLink className="icon-size-100" aria-hidden />
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function AgentsTab({ assessment }: { assessment: Assessment }) {
  const { workspaceId, modelId } = assessment;
  const canChange = assessment.canWrite;
  const readiness = useAsync(() => api.getAgentReadiness(workspaceId, modelId), [workspaceId, modelId]);
  const approve = useAction(async (approved: boolean) => {
    const res = await api.setApprovedForCopilot(workspaceId, modelId, approved);
    readiness.reload();
    return res;
  });

  if (readiness.loading && !readiness.data) return <Card><LoadingBlock label="Checking tenant, workspace and model settings" rows={4} /></Card>;
  if (readiness.error) return <Card><ErrorState message={readiness.error} onRetry={readiness.reload} title="Could not check availability" /></Card>;
  const data = readiness.data;
  if (!data) return null;

  const approved = data.checks.find((c) => c.id === 'MOD-004')?.status === 'pass';

  return (
    <div className="space-y-500">
      <div className="grid gap-400 md:grid-cols-3">
        {data.surfaces.map((s) => (
          <div key={s.surface} className={cx('rounded-lg border px-400 py-300', toneSoft[statusTone[s.status]])}>
            <div className="flex items-center gap-200">
              {statusIcon[s.status]}
              <p className="font-heading text-400 leading-400 font-semibold text-foreground">{s.label}</p>
            </div>
            <p className="mt-100 text-200 leading-300 font-medium text-foreground">{statusLabel[s.status]}</p>
            {s.blockers.length > 0 ? (
              <ul className="mt-200 list-inside list-disc text-200 leading-300 text-muted-foreground">
                {s.blockers.slice(0, 4).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-200 text-200 leading-300 text-muted-foreground">No blockers found.</p>
            )}
          </div>
        ))}
      </div>

      {!data.tenantSettingsReadable ? (
        <Notice tone="caution" title="Tenant settings could not be read">
          The app’s identity is not a Fabric admin, so tenant checks show “Cannot verify”. Ask a tenant admin to confirm them in the Fabric admin portal.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Approved for Copilot"
          subtitle="Models marked approved are surfaced first in standalone Copilot. Microsoft offers no API for this flag, so Fabric Weave records a confirmation instead."
        />
        <div className="flex flex-wrap items-center justify-between gap-400 px-500 py-400">
          <Toggle
            checked={approved}
            disabled={approve.busy || !canChange}
            onChange={(next) => void approve.run(next)}
            label="A model owner has marked this model Approved for Copilot"
            description={canChange ? 'Tick this after you have set the flag in the model settings, so the checks below reflect it.' : 'Only people with write access to this model can record this confirmation.'}
          />
          <a
            href={fabricModelUrl(workspaceId, modelId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-200 rounded-md border border-input bg-card px-400 text-300 font-medium hover:bg-accent"
          >
            Open model settings <ExternalLink className="icon-size-200" aria-hidden />
          </a>
        </div>
        {approve.error ? (
          <div className="px-500 pb-400">
            <Notice tone="danger" title="Could not save the confirmation">
              {approve.error}
            </Notice>
          </div>
        ) : null}
      </Card>

      {levels.map((level) => {
        const rows = data.checks.filter((c) => c.level === level.id);
        if (rows.length === 0) return null;
        return (
          <Card key={level.id}>
            <CardHeader title={level.title} subtitle={level.hint} />
            <ul className="divide-y divide-border">
              {rows.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </ul>
          </Card>
        );
      })}

      <div className="flex items-center justify-between text-200 text-muted-foreground">
        <span>Checked {formatDateTime(data.evaluatedAt)}</span>
        <Button size="sm" variant="ghost" onClick={readiness.reload} busy={readiness.loading}>
          Re-check
        </Button>
      </div>
    </div>
  );
}
