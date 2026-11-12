import { Search, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge, Button, Card, Dialog, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, Select, TextInput, Toggle } from '@/components/ui';
import { api, useAction, type Workspace, type WriteMode } from '@/lib/api';
import { useApp } from '@/lib/use-app';

const MODES: { id: WriteMode; label: string; hint: string }[] = [
  { id: 'propose-only', label: 'Propose only', hint: 'Nothing is written. Fixes are recorded for your team to review and apply.' },
  { id: 'clone', label: 'AI-ready copy', hint: 'Fixes are applied to a new copy named “<model> (AI-ready)”. The original is untouched.' },
  { id: 'in-place', label: 'In place', hint: 'Fixes are written to the model itself. A snapshot is taken first, so the latest change can be rolled back.' },
];

function Row({ workspace, onSave, busy, canEdit }: { workspace: Workspace; onSave: (next: { inScope: boolean; writeMode: WriteMode }) => void; busy: boolean; canEdit: boolean }) {
  const [inScope, setInScope] = useState(workspace.inScope);
  const [writeMode, setWriteMode] = useState<WriteMode>(workspace.writeMode);
  const dirty = inScope !== workspace.inScope || writeMode !== workspace.writeMode || !workspace.configured || workspace.unverified;
  const hint = MODES.find((m) => m.id === writeMode)?.hint;

  return (
    <li className="grid items-center gap-300 px-500 py-300 md:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="truncate text-300 leading-300 font-medium">{workspace.name}</p>
        <p className="mt-100 flex flex-wrap items-center gap-200">
          {workspace.configured ? <Badge tone={workspace.inScope ? 'success' : 'neutral'}>{workspace.inScope ? 'in scope' : 'out of scope'}</Badge> : <Badge tone="warning">not configured</Badge>}
          {workspace.unverified ? <Badge tone="warning">save again to confirm</Badge> : null}
        </p>
      </div>
      <Toggle checked={inScope} onChange={setInScope} label="In scope" disabled={!canEdit} />
      <div>
        <Select aria-label={`Write mode for ${workspace.name}`} value={writeMode} onChange={(e) => setWriteMode(e.target.value as WriteMode)} disabled={!inScope || !canEdit}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
        {inScope ? <p className="mt-100 text-200 leading-300 text-muted-foreground">{hint}</p> : null}
        {workspace.unverified ? <p className="mt-100 text-200 leading-300 text-muted-foreground">The stored write mode was not saved by the app and is ignored. Choose the mode and save it again.</p> : null}
      </div>
      <Button variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || !canEdit} busy={busy} onClick={() => onSave({ inScope, writeMode })}>
        Save
      </Button>
    </li>
  );
}

export function WorkspacesPage() {
  const app = useApp();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ workspace: Workspace; inScope: boolean; writeMode: WriteMode } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const save = useAction((input: { workspaceId: string; writeMode: WriteMode; inScope: boolean }) => api.saveWorkspaceSetting(input));

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (app.workspaces ?? []).filter((w) => !q || w.name.toLowerCase().includes(q));
  }, [app.workspaces, query]);

  const commit = async (workspace: Workspace, inScope: boolean, writeMode: WriteMode) => {
    setSavingId(workspace.id);
    const res = await save.run({ workspaceId: workspace.id, writeMode, inScope });
    setSavingId(null);
    setPending(null);
    if (res) app.replaceWorkspace(res);
  };

  const request = (workspace: Workspace, next: { inScope: boolean; writeMode: WriteMode }) => {
    if (next.inScope && next.writeMode === 'in-place') setPending({ workspace, ...next });
    else void commit(workspace, next.inScope, next.writeMode);
  };

  return (
    <>
      <PageHeader eyebrow="Workspaces" title="Scope and write mode" subtitle="Choose which of your workspaces Fabric Weave may change, and how. Reading and scoring never need this." />

      {app.status && !app.status.isAdmin ? (
        <Notice tone="info" title="You see the workspaces and models Fabric gives you access to" className="mb-500">
          {`You are signed in as ${app.status.actor}. You can change the write mode of the workspaces where you are an Admin, and apply fixes to the models you have write access to. An app administrator can change everything.`}
        </Notice>
      ) : null}

      <Notice tone="info" title="Changes are written with the app’s identity, not the signed-in person’s" className="mb-500">
        <span className="inline-flex items-start gap-200">
          <ShieldAlert className="icon-size-300 mt-100 shrink-0" aria-hidden />
          <span>
            Before every change the app asks Fabric what you may do, and refuses anything beyond your own access. Keep most workspaces on “Propose only”, and use “In place” only where a model owner has agreed to it.
          </span>
        </span>
      </Notice>

      <Card>
        <div className="border-b border-border px-500 py-400">
          <div className="relative max-w-sm">
            <Search className="icon-size-200 pointer-events-none absolute top-1/2 left-300 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <TextInput aria-label="Filter workspaces" placeholder="Filter workspaces…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-800" />
          </div>
        </div>
        {save.error ? (
          <div className="px-500 pt-400">
            <Notice tone="danger" title="The setting was not saved">
              {save.error}
            </Notice>
          </div>
        ) : null}
        {app.workspacesLoading && !app.workspaces ? (
          <LoadingBlock rows={5} />
        ) : app.workspacesError ? (
          <ErrorState message={app.workspacesError} onRetry={app.reloadWorkspaces} title="Workspaces unavailable" />
        ) : list.length === 0 ? (
          <EmptyState title="No workspaces found">
            {app.status?.isAdmin === false
              ? 'Fabric shows no workspaces with semantic models that you can reach. Ask for access to a workspace, or check the Status page to see how the app worked out your access.'
              : 'Add the app’s identity to a workspace as Member or Contributor and it will appear here.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((w) => (
              <Row key={`${w.id}:${w.inScope}:${w.writeMode}:${w.configured}:${w.unverified}`} workspace={w} busy={savingId === w.id} canEdit={w.canEdit} onSave={(next) => request(w, next)} />
            ))}
          </ul>
        )}
      </Card>

      <Dialog
        open={pending !== null}
        dismissible={savingId === null}
        onClose={() => (savingId === null ? setPending(null) : undefined)}
        title="Allow in-place changes?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant="danger" busy={savingId !== null} onClick={() => pending && void commit(pending.workspace, pending.inScope, pending.writeMode)}>
              Allow in-place changes
            </Button>
          </>
        }
      >
        <p className="text-300 leading-300">
          Fixes applied to models in <span className="font-semibold">{pending?.workspace.name}</span> will be written straight to the models. A snapshot is taken before each change so the latest one can be rolled back, but reports that rely on current descriptions or names may behave differently.
        </p>
      </Dialog>
    </>
  );
}
