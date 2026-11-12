import { CheckCircle2, CircleAlert, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge, Button, Card, CardHeader, ErrorState, LoadingBlock, Mono, PageHeader } from '@/components/ui';
import { useApp } from '@/lib/use-app';
import { relativeTime } from '@/lib/format';

type State = 'ok' | 'warn' | 'bad';

const icon: Record<State, ReactNode> = {
  ok: <CheckCircle2 className="icon-size-400 shrink-0 text-success" aria-hidden />,
  warn: <CircleAlert className="icon-size-400 shrink-0 text-caution" aria-hidden />,
  bad: <XCircle className="icon-size-400 shrink-0 text-destructive" aria-hidden />,
};

function Row({ state, title, detail, children }: { state: State; title: string; detail: string; children?: ReactNode }) {
  return (
    <li className="flex gap-400 px-500 py-400">
      {icon[state]}
      <div className="min-w-0 flex-1 space-y-200">
        <div className="flex flex-wrap items-center gap-200">
          <p className="text-300 leading-300 font-semibold">{title}</p>
          <Badge tone={state === 'ok' ? 'success' : state === 'warn' ? 'caution' : 'danger'}>{state === 'ok' ? 'Working' : state === 'warn' ? 'Optional' : 'Needs setup'}</Badge>
        </div>
        <p className="text-200 leading-300 text-muted-foreground">{detail}</p>
        {children}
      </div>
    </li>
  );
}

function Command({ children }: { children: string }) {
  return <Mono className="block overflow-x-auto rounded-md border border-border bg-muted px-300 py-200 whitespace-pre">{children}</Mono>;
}

export function StatusPage() {
  const app = useApp();
  const s = app.status;

  return (
    <>
      <PageHeader
        eyebrow="Status"
        title="Setup and connections"
        subtitle="Everything Fabric Weave needs to do its job. Items marked optional only unlock extra features."
        actions={
          <Button onClick={app.reloadStatus} variant="secondary">
            Check again
          </Button>
        }
      />
      <Card>
        <CardHeader title="Connections" subtitle={s ? `Signed in as ${s.actor}` : undefined} />
        {!s && !app.statusError ? (
          <LoadingBlock rows={3} />
        ) : app.statusError ? (
          <ErrorState message={app.statusError} onRetry={app.reloadStatus} title="Status could not be read" />
        ) : s ? (
          <ul className="divide-y divide-border">
            <Row
              state={s.fabricTokenOk ? 'ok' : 'bad'}
              title="Fabric and Power BI access"
              detail={s.fabricTokenOk ? 'The app can call the Fabric and Power BI APIs.' : (s.fabricError ?? 'The app could not get a Fabric token.')}
            >
              {!s.fabricTokenOk ? <p className="text-200 leading-300">Make sure the app is deployed with its function identity, and add that identity to each workspace as Member or Contributor.</p> : null}
            </Row>
            <Row
              state={s.llm.configured ? 'ok' : 'warn'}
              title="AI model for drafting and review"
              detail={s.llm.configured ? `${s.llm.name}${s.llm.deployment ? `, deployment ${s.llm.deployment}` : ''}. Only names, descriptions and DAX are sent.` : 'No Azure OpenAI deployment is configured. Scoring and rule-based fixes work without it; AI drafts and the AI review are switched off.'}
            >
              {!s.llm.configured ? (
                <div className="space-y-200">
                  <Command>{`npx rayfin secret set AOAI_ENDPOINT --stdin\nnpx rayfin secret set AOAI_DEPLOYMENT --stdin`}</Command>
                  <p className="text-200 leading-300 text-muted-foreground">
                    Give the app’s identity the “Cognitive Services OpenAI User” role on the Azure OpenAI resource, then redeploy.
                  </p>
                </div>
              ) : null}
            </Row>
            <Row
              state={s.portfolio.available ? 'ok' : 'warn'}
              title="Estate scan and Portfolio page"
              detail={
                s.portfolio.available
                  ? `The scan pipeline last produced an inventory ${s.portfolio.generatedAt ? relativeTime(s.portfolio.generatedAt) : 'recently'}.`
                  : s.portfolio.configured
                    ? 'The inventory file is not there yet. Run the PL_AI_Readiness_Refresh pipeline in the workspace.'
                    : 'Not installed. This is optional: without it there is no Portfolio page and no usage numbers, and everyone still inspects, scores and fixes the models they can reach from the Models page.'
              }
            >
              {!s.portfolio.configured ? (
                <div className="space-y-200">
                  <Command>{`node install.mjs --workspace <workspace-id>`}</Command>
                  <p className="text-200 leading-300 text-muted-foreground">
                    Run the installer again without <Mono>--app-only</Mono> to add the scan: it deploys the lakehouse, notebooks and nightly pipeline and sets{' '}
                    <Mono>PORTFOLIO_PATH</Mono> to <Mono>{'{workspaceId}/{lakehouseId}'}</Mono>.
                  </p>
                </div>
              ) : null}
            </Row>
            <Row
              state={s.isAdmin || s.access.source === 'fabric-admin-api' ? 'ok' : s.access.source === 'workspace-roles' ? 'warn' : 'bad'}
              title="What you can see and change"
              detail={
                s.isAdmin
                  ? 'You are an app administrator: you see every workspace and model the app can reach, and can change any of them.'
                  : s.access.source === 'fabric-admin-api'
                    ? `Read from Fabric: you can reach ${s.access.models ?? 0} model${s.access.models === 1 ? '' : 's'} in ${s.access.workspaces ?? 0} workspace${s.access.workspaces === 1 ? '' : 's'}. You can change the models where Fabric gives you write access, and the write mode of workspaces where you are an Admin.`
                    : s.access.source === 'workspace-roles'
                      ? `Read from workspace roles: you hold a direct role in ${s.access.workspaces ?? 0} workspace${s.access.workspaces === 1 ? '' : 's'}. Contributors, Members and Admins can change models; only Admins can change write modes.`
                      : 'The app could not work out your access, so it shows you nothing and changes nothing.'
              }
            >
              <div className="space-y-200">
                <p className="text-200 leading-300 text-muted-foreground">
                  You are signed in as <Mono>{s.actor}</Mono>
                  {s.access.userRef ? (
                    <>
                      . The app asks Fabric about <Mono>{s.access.userRef}</Mono>
                    </>
                  ) : null}
                  {s.identities.length > 0 ? (
                    <>
                      . Any of these values identifies you: <Mono>{s.identities.join('  ')}</Mono>
                    </>
                  ) : null}
                </p>
                {s.access.note ? <p className="text-200 leading-300">{s.access.note}</p> : null}
                {s.access.source !== 'fabric-admin-api' && !s.isAdmin ? (
                  <p className="text-200 leading-300 text-muted-foreground">
                    For the most accurate view, make the app’s owner a Fabric administrator: Fabric then reports each person’s effective access, including groups and sharing. People in the APP_ADMINS secret see and change everything. Set it with <Mono>npx rayfin secret set APP_ADMINS --stdin</Mono> and redeploy.
                  </p>
                ) : null}
              </div>
            </Row>
            <Row
              state={s.snapshotSigning ? 'ok' : 'warn'}
              title="Rollback snapshot signing"
              detail={
                s.snapshotSigning
                  ? 'Rollback snapshots and the stored write mode of every workspace are signed, and verified before they are trusted.'
                  : 'No signing key is set, so in-place changes and rollback are switched off. Clone and propose-only modes still work.'
              }
            >
              {!s.snapshotSigning ? (
                <div className="space-y-200">
                  <Command>{`npx rayfin secret set SIGNING_KEY --stdin`}</Command>
                  <p className="text-200 leading-300 text-muted-foreground">
                    Use a long random value (at least 32 characters), for example 48 random bytes, base64 encoded. Then redeploy.
                  </p>
                </div>
              ) : null}
            </Row>
          </ul>
        ) : null}
      </Card>
    </>
  );
}
