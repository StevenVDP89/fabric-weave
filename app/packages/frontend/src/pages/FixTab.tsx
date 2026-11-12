import { ArrowRight, History, RotateCcw, ShieldCheck, Sparkles, Undo2, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DiffView } from '@/components/DiffView';
import { CategoryBars, ScoreDial } from '@/components/ScoreDial';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, LoadingBlock, Notice, TextArea } from '@/components/ui';
import { cx } from '@/lib/cx';
import { api, useAction, useAsync, type ApplyResult, type Assessment, type Proposal, type Workspace } from '@/lib/api';
import { describeChange, isEditable, splitList, summariseChanges, type Change } from '@/lib/changes';
import { loadChangeSets, type ChangeSetItem } from '@/lib/data';
import { proposalCategories } from '@/lib/findingGroups';
import { fabricModelUrl, formatDelta, formatScore, relativeTime, toneForScore, toneText, type Tone } from '@/lib/format';
import { liveScore } from '@/lib/liveScore';
import { modelHref } from '@/lib/route';
import { useApp } from '@/lib/use-app';

const riskTone: Record<Proposal['risk'], Tone> = { low: 'success', medium: 'caution', high: 'warning' };
const sourceLabel: Record<Proposal['generatedBy'], string> = { rule: 'Rule', template: 'Template', llm: 'AI draft' };

function ChangeEditor({ change, onChange }: { change: Change; onChange: (next: Change) => void }) {
  const [draft, setDraft] = useState(() => (change.op === 'setExamplePrompts' ? change.value.join('\n') : ''));

  if (change.op === 'setDescription') {
    return <TextArea aria-label={describeChange(change)} value={change.value} rows={2} className="min-h-16" onChange={(e) => onChange({ ...change, value: e.target.value })} />;
  }
  if (change.op === 'setInstructions') {
    return <TextArea aria-label="AI instructions" value={change.value} rows={10} className="font-base" onChange={(e) => onChange({ ...change, value: e.target.value })} />;
  }
  if (change.op === 'setExamplePrompts') {
    return (
      <TextArea
        aria-label="Example prompts"
        value={draft}
        rows={Math.max(3, change.value.length + 1)}
        placeholder="One prompt per line"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange({ ...change, value: splitList(draft, /\n/) })}
      />
    );
  }
  return null;
}

function ProposalCard({
  proposal,
  categories,
  selected,
  edited,
  onToggle,
  onEdit,
}: {
  proposal: Proposal;
  categories: { id: string; title: string }[];
  selected: boolean;
  edited: boolean;
  onToggle: () => void;
  onEdit: (changes: Change[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const checkId = `proposal-${proposal.id}`;

  return (
    <li className={cx('rounded-lg border bg-card', selected ? 'border-primary/60' : 'border-border')}>
      <div className="flex items-start gap-300 px-400 py-300">
        <input id={checkId} type="checkbox" checked={selected} onChange={onToggle} className="mt-100 icon-size-300 accent-primary" />
        <div className="min-w-0 flex-1">
          <label htmlFor={checkId} className="block cursor-pointer text-300 leading-300 font-semibold">
            {proposal.title}
          </label>
          <p className="mt-100 text-200 leading-300 text-muted-foreground">{proposal.summary}</p>
          <div className="mt-200 flex flex-wrap items-center gap-200">
            <Badge tone={riskTone[proposal.risk]}>{proposal.risk} risk</Badge>
            <Badge tone={proposal.generatedBy === 'llm' ? 'info' : 'neutral'}>
              {proposal.generatedBy === 'llm' ? <Sparkles className="icon-size-100" aria-hidden /> : null}
              {sourceLabel[proposal.generatedBy]}
            </Badge>
            {proposal.requiresReview ? <Badge tone="warning">review wording</Badge> : null}
            {edited ? <Badge tone="info">edited</Badge> : null}
            {proposal.estimatedGain ? <Badge tone="success">≈ {formatDelta(proposal.estimatedGain)} pts</Badge> : null}
            {proposalCategories(proposal.ruleIds, categories).map((title) => (
              <Badge key={title} tone="neutral">
                {title}
              </Badge>
            ))}
          </div>
        </div>
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Review'} {proposal.changes.length} {proposal.changes.length === 1 ? 'change' : 'changes'}
        </Button>
      </div>
      {open ? (
        <ul className="space-y-300 border-t border-border bg-muted/40 px-400 py-300">
          {proposal.changes.map((change, i) => (
            <li key={i} className="space-y-100">
              <p className="text-200 leading-300 font-medium">{describeChange(change)}</p>
              {isEditable(change) ? (
                <ChangeEditor
                  change={change}
                  onChange={(next) => {
                    const copy = [...proposal.changes];
                    copy[i] = next;
                    onEdit(copy);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function modeCopy(workspace: Workspace | undefined, modelName: string): { tone: Tone; title: string; body: string; canApply: boolean } {
  if (!workspace) return { tone: 'warning', title: 'Workspace not found', body: 'The workspace could not be loaded, so changes are disabled.', canApply: false };
  if (workspace.unverified) {
    return {
      tone: 'warning',
      title: 'This workspace setting must be saved again',
      body: 'The write mode stored for this workspace was not saved by the app, so it is ignored and the workspace behaves as propose-only. A workspace Admin (or an app administrator) has to open the Workspaces page and save it again.',
      canApply: false,
    };
  }
  if (!workspace.inScope || !workspace.configured) {
    return {
      tone: 'warning',
      title: 'Changes are switched off for this workspace',
      body: 'A workspace owner has to bring it into scope and choose a write mode on the Workspaces page before anything can be written.',
      canApply: false,
    };
  }
  if (workspace.writeMode === 'in-place')
    return {
      tone: 'caution',
      title: 'In-place mode',
      body: 'Changes are written to this model. A snapshot is taken first, so the latest change set can be rolled back.',
      canApply: true,
    };
  if (workspace.writeMode === 'clone')
    return { tone: 'info', title: 'Clone mode', body: `A copy named “${modelName} (AI-ready)” is created. The original model is not touched.`, canApply: true };
  return { tone: 'info', title: 'Propose-only mode', body: 'Nothing is written to Fabric. The change set is recorded so your team can review and apply it.', canApply: true };
}

function ResultPanel({ result, workspaceId, onRollback, rolling, canRollback }: { result: ApplyResult; workspaceId: string; onRollback: () => void; rolling: boolean; canRollback: boolean }) {
  const ok = result.status !== 'failed';
  const delta = result.after.score - result.before.score;
  return (
    <Card>
      <CardHeader
        title={result.status === 'proposed' ? 'Change set recorded' : result.status === 'failed' ? 'No changes were written' : 'Changes written'}
        subtitle={result.message}
        actions={
          <>
            {result.mode === 'in-place' && result.status === 'applied' && canRollback ? (
              <Button size="sm" icon={<Undo2 className="icon-size-200" aria-hidden />} busy={rolling} onClick={onRollback}>
                Roll back
              </Button>
            ) : null}
            {result.mode === 'clone' && result.targetModelId ? (
              <>
                <a className="inline-flex h-8 items-center rounded-md border border-input bg-card px-300 text-200 font-medium hover:bg-accent" href={modelHref(workspaceId, result.targetModelId)}>
                  Inspect the copy
                </a>
                <a
                  className="inline-flex h-8 items-center rounded-md border border-input bg-card px-300 text-200 font-medium hover:bg-accent"
                  href={fabricModelUrl(workspaceId, result.targetModelId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Fabric
                </a>
              </>
            ) : null}
          </>
        }
      />
      <div className="space-y-400 px-500 py-400">
        {ok ? (
          <div className="flex flex-wrap items-center gap-400">
            <div className="flex items-center gap-300 font-numeric text-hero-700 leading-hero-700">
              <span className="text-muted-foreground">{formatScore(result.before.score)}</span>
              <ArrowRight className="icon-size-400 text-muted-foreground" aria-hidden />
              <span>{formatScore(result.after.score)}</span>
              <span className={cx('text-400', delta >= 0 ? 'text-success' : 'text-destructive')}>{formatDelta(delta)}</span>
            </div>
            <Badge tone={result.after.tier === 'AI-ready' ? 'success' : 'caution'}>{result.after.tier}</Badge>
            {result.mode === 'in-place' ? (
              result.verified ? (
                <Badge tone="success">
                  <ShieldCheck className="icon-size-100" aria-hidden /> verified by re-reading the model
                </Badge>
              ) : (
                <Badge tone="warning">not verified</Badge>
              )
            ) : null}
            <span className="text-200 text-muted-foreground">{result.applied} changes applied</span>
          </div>
        ) : null}
        {result.skipped.length > 0 ? (
          <Notice tone="warning" title={`${result.skipped.length} changes were skipped`}>
            <ul className="list-inside list-disc">
              {result.skipped.slice(0, 8).map((s, i) => (
                <li key={i}>
                  {s.op}: {s.reason}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <div>
          <p className="mb-200 text-200 font-medium">Exactly what changed in the model definition</p>
          <DiffView parts={result.changedParts} />
        </div>
      </div>
    </Card>
  );
}

function HistoryPanel({ items, loading, error, latestAppliedId, onRollback, busyId, canRollback }: { items: ChangeSetItem[] | undefined; loading: boolean; error: string | null; latestAppliedId: string | null; onRollback: (id: string) => void; busyId: string | null; canRollback: boolean }) {
  return (
    <Card>
      <CardHeader title="Change history" subtitle="Every apply, proposal and rollback for this model." />
      {loading && !items ? (
        <LoadingBlock rows={2} />
      ) : error ? (
        <ErrorState message={error} title="History unavailable" />
      ) : !items || items.length === 0 ? (
        <EmptyState title="No changes yet">Applied and proposed fixes appear here.</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-300 px-500 py-300 text-300 leading-300">
              <Badge tone={c.status === 'applied' ? 'success' : c.status === 'failed' ? 'danger' : c.status === 'rolled-back' ? 'neutral' : 'info'}>{c.status}</Badge>
              <Badge>{c.mode}</Badge>
              <span className="font-numeric tabular-nums">
                {formatScore(c.score_before10 / 10)} → {formatScore(c.score_after10 / 10)}
              </span>
              <span className="min-w-0 flex-1 break-words text-muted-foreground" title={c.summary}>
                {c.change_count} changes · {c.summary}
              </span>
              <span className="text-200 text-muted-foreground">
                {c.created_by} · {relativeTime(String(c.created_at))}
              </span>
              {c.id === latestAppliedId && canRollback ? (
                <Button size="sm" icon={<RotateCcw className="icon-size-200" aria-hidden />} busy={busyId === c.id} onClick={() => onRollback(c.id)}>
                  Roll back
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function FixTab({ assessment, workspace, llmConfigured, onChanged }: { assessment: Assessment; workspace: Workspace | undefined; llmConfigured: boolean; onChanged: () => void }) {
  const { workspaceId, modelId, modelName } = assessment;
  const [useAi, setUseAi] = useState(false);
  const proposals = useAsync(() => api.getFixProposals(workspaceId, modelId, useAi), [workspaceId, modelId, useAi]);
  const history = useAsync(() => loadChangeSets(modelId), [modelId]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Change[]>>({});
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<ApplyResult | undefined>(undefined);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const { status } = useApp();
  const canWrite = assessment.canWrite;

  const apply = useAction((picked: Proposal[], baseDigest: string) => api.applyFixes(workspaceId, modelId, picked, baseDigest));
  const rollback = useAction((id: string, discardLaterEdits: boolean) => api.rollbackChangeSet(id, discardLaterEdits));
  // The server refuses a rollback when the model was edited after the apply, until the user confirms discarding those edits.
  const needsDiscardConfirm = rollback.error !== null && /discard later edits|accept discarding/i.test(rollback.error);

  const list = proposals.data?.proposals;
  // Start from today's score with nothing selected (done while rendering, not in an effect), so ticking a fix visibly raises it.
  const [seededFrom, setSeededFrom] = useState<typeof list>(undefined);
  if (list && list !== seededFrom) {
    setSeededFrom(list);
    setSelected(new Set());
    setEdits({});
  }

  const data = proposals.data;
  const live = useMemo(() => (data ? liveScore(data.before, data.projected, data.impacts, selected) : undefined), [data, selected]);
  const safeIds = useMemo(() => (list ?? []).filter((p) => p.risk === 'low' && !p.requiresReview).map((p) => p.id), [list]);
  const effective = useMemo(() => (list ?? []).filter((p) => selected.has(p.id)).map((p): Proposal => ({ ...p, changes: edits[p.id] ?? p.changes })), [list, selected, edits]);
  const changeCount = effective.reduce((n, p) => n + p.changes.length, 0);
  const copy = modeCopy(workspace, modelName);
  const blocked = (data?.writeBlockers.length ?? 0) > 0;
  const latestAppliedId = history.data?.find((c) => c.mode === 'in-place' && c.status === 'applied')?.id ?? null;

  const refreshAll = () => {
    history.reload();
    proposals.reload();
    onChanged();
  };

  const runApply = async () => {
    if (!data) return;
    const res = await apply.run(effective, data.baseDigest);
    setConfirm(false);
    if (res) {
      setResult(res);
      refreshAll();
    } else {
      // A failed or timed-out call may still have written the model or recorded a change set, so show the true state.
      history.reload();
    }
  };

  const closeConfirm = () => {
    if (apply.busy) return;
    apply.reset();
    setConfirm(false);
  };

  const closeRollback = () => {
    if (rollback.busy) return;
    rollback.reset();
    setRollbackTarget(null);
  };

  const runRollback = async () => {
    if (!rollbackTarget) return;
    const res = await rollback.run(rollbackTarget, needsDiscardConfirm);
    if (res) {
      setRollbackTarget(null);
      setResult(undefined);
      refreshAll();
    } else {
      history.reload();
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-500">
      <Notice tone={copy.tone} title={copy.title}>
        {copy.body}
      </Notice>
      {!canWrite ? (
        <Notice tone="caution" title="You can look, but not change">
          {`Fabric does not give you write access to this model, so you can review fixes but not apply them or roll them back. You are signed in as ${status?.actor ?? 'an unknown user'}. Ask the model owner for the Contributor role in the workspace, or for write access to the model. An app administrator can change any model.`}
        </Notice>
      ) : null}

      {result ? <ResultPanel result={result} workspaceId={workspaceId} onRollback={() => setRollbackTarget(result.changeSetId)} rolling={rollback.busy} canRollback={canWrite} /> : null}
      {apply.error ? (
        <Notice tone="danger" title="The fixes were not applied">
          <p>{apply.error}</p>
          {/timed out/i.test(apply.error) ? <p className="mt-100">The request timed out, so the change may still have gone through. Check the change history below before trying again.</p> : null}
          {/changed in fabric|run the analysis again/i.test(apply.error) ? (
            <Button size="sm" className="mt-200" icon={<RotateCcw className="icon-size-200" aria-hidden />} onClick={() => { apply.reset(); proposals.reload(); }}>
              Analyse the model again
            </Button>
          ) : null}
        </Notice>
      ) : null}

      <div className="grid gap-500 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Card className="self-start lg:sticky lg:top-400 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <CardHeader title="Your score" subtitle="Starts at today's score and rises as you tick fixes" />
          {proposals.loading && !data ? (
            <LoadingBlock rows={2} />
          ) : data && live ? (
            <div className="space-y-500 px-500 py-400">
              <ScoreDial score={live.score} tier={live.tier} compare={data.before.score} caption={selected.size === 0 ? 'Today' : 'With your selection'} />
              <dl className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-muted/40 text-center">
                <div className="px-200 py-300">
                  <dt className="text-100 leading-100 tracking-wider text-muted-foreground uppercase">Today</dt>
                  <dd className="font-numeric text-400 leading-400 font-medium tabular-nums">{formatScore(data.before.score)}</dd>
                </div>
                <div className="px-200 py-300">
                  <dt className="text-100 leading-100 tracking-wider text-muted-foreground uppercase">Selected</dt>
                  <dd className={cx('font-numeric text-400 leading-400 font-medium tabular-nums', toneText[toneForScore(live.score)])}>{formatScore(live.score)}</dd>
                </div>
                <div className="px-200 py-300">
                  <dt className="text-100 leading-100 tracking-wider text-muted-foreground uppercase">Gain</dt>
                  <dd className={cx('font-numeric text-400 leading-400 font-medium tabular-nums', live.delta > 0 ? 'text-success' : 'text-muted-foreground')}>{formatDelta(live.delta)}</dd>
                </div>
              </dl>
              <p className="text-center text-200 leading-300 text-muted-foreground" aria-live="polite">
                {selected.size === 0
                  ? `Tick a proposal to see its effect. All ${data.proposals.length} together would reach ${formatScore(data.projected.score)}.`
                  : `${selected.size} of ${data.proposals.length} proposals selected. All of them would reach ${formatScore(data.projected.score)}.`}
              </p>
              <CategoryBars categories={live.categories} compare={data.before.categories} />
              <p className="text-100 leading-200 text-muted-foreground">An estimate from each proposal's own effect. The real score is re-checked against Fabric after writing.</p>
            </div>
          ) : null}
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title="Proposed fixes"
            subtitle={data ? `${data.proposals.length} proposals from ${data.generator}` : 'Generating proposals'}
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(safeIds))} disabled={safeIds.length === 0} title="Select the low-risk proposals that need no review">
                  Safe only
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set((list ?? []).map((p) => p.id)))} disabled={!list?.length}>
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                  Clear
                </Button>
                <Button
                  size="sm"
                  icon={<Wand2 className="icon-size-200" aria-hidden />}
                  disabled={!llmConfigured || useAi}
                  busy={proposals.loading && useAi}
                  title={llmConfigured ? 'Draft descriptions and instructions with the configured AI model' : 'No AI model is configured. See the Status page.'}
                  onClick={() => setUseAi(true)}
                >
                  {useAi ? 'AI drafts on' : 'Draft with AI'}
                </Button>
              </>
            }
          />
          <div className="space-y-300 px-500 py-400">
            {data && data.writeBlockers.length > 0 ? (
              <Notice tone={workspace?.writeMode === 'propose-only' ? 'info' : 'danger'} title={workspace?.writeMode === 'propose-only' ? 'The model source is broken' : 'This model cannot be changed yet'}>
                {data.writeBlockers.join(' ')}{' '}
                {workspace?.writeMode === 'propose-only'
                  ? 'Propose-only mode is not affected, but the change set cannot be applied until the source is fixed.'
                  : 'Fabric checks the source on every update. Re-point the model to an existing lakehouse in Fabric (Edit tables), give the app access to it, or switch this workspace to propose-only mode.'}
              </Notice>
            ) : null}
            {data && useAi && !data.businessContextUsed ? (
              <Notice tone="caution" title="No business context yet">
                AI drafts are much better with a description of the model. Add it on the Context tab: write it yourself, or let the agent interview you. Then draft again.
              </Notice>
            ) : null}
            {data && useAi && data.businessContextUsed ? (
              <Notice tone="success" title="Drafted from your business context">
                The descriptions, example prompts and AI instructions below follow what you wrote on the Context tab. Change it there and draft again to update them.
              </Notice>
            ) : null}
            {data?.notes.map((note) => (
              <Notice key={note} tone="info">
                {note}
              </Notice>
            ))}
            {proposals.loading && !data ? (
              <LoadingBlock label={useAi ? 'Drafting with AI. This can take a minute.' : 'Analysing the model'} />
            ) : proposals.error ? (
              <ErrorState message={proposals.error} onRetry={proposals.reload} />
            ) : data && data.proposals.length === 0 ? (
              <EmptyState title="Nothing to fix">This model already passes every rule that has an automatic fix.</EmptyState>
            ) : data ? (
              <ul className={cx('space-y-200', proposals.loading ? 'opacity-60' : undefined)}>
                {data.proposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} categories={assessment.score.categories} selected={selected.has(p.id)} edited={Boolean(edits[p.id])} onToggle={() => toggle(p.id)} onEdit={(changes) => setEdits((prev) => ({ ...prev, [p.id]: changes }))} />
                ))}
              </ul>
            ) : null}
          </div>
          {data && data.proposals.length > 0 ? (
            <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-300 rounded-b-lg border-t border-border bg-card px-500 py-300">
              <p className="text-300 text-muted-foreground">
                <span className="font-numeric text-foreground">{selected.size}</span> proposals · <span className="font-numeric text-foreground">{changeCount}</span> changes selected
              </p>
              <Button variant="primary" icon={<ShieldCheck className="icon-size-200" aria-hidden />} disabled={!canWrite || !copy.canApply || selected.size === 0 || (blocked && workspace?.writeMode !== 'propose-only')} onClick={() => { apply.reset(); setConfirm(true); }}>
                Review and apply
              </Button>
            </footer>
          ) : null}
        </Card>
      </div>

      <HistoryPanel items={history.data} loading={history.loading} error={history.error} latestAppliedId={latestAppliedId} onRollback={setRollbackTarget} busyId={rollback.busy ? rollbackTarget : null} canRollback={canWrite} />

      <Dialog
        open={confirm}
        dismissible={!apply.busy}
        onClose={closeConfirm}
        title="Apply selected fixes?"
        footer={
          <>
            <Button variant="ghost" onClick={closeConfirm} disabled={apply.busy}>
              Cancel
            </Button>
            <Button variant={workspace?.writeMode === 'in-place' ? 'danger' : 'primary'} busy={apply.busy} onClick={runApply}>
              {workspace?.writeMode === 'propose-only' ? 'Record change set' : workspace?.writeMode === 'clone' ? 'Create AI-ready copy' : 'Write to the live model'}
            </Button>
          </>
        }
      >
        <div className="space-y-300">
          <Notice tone={copy.tone} title={copy.title}>
            {copy.body}
          </Notice>
          <p className="text-300 leading-300">
            <span className="font-numeric font-semibold">{changeCount}</span> changes across <span className="font-numeric font-semibold">{selected.size}</span> proposals on{' '}
            <span className="font-semibold">{modelName}</span>.
          </p>
          <p className="text-300 leading-300 text-muted-foreground">{summariseChanges(effective.flatMap((p) => p.changes)).join(', ')}.</p>
          {workspace?.writeMode === 'in-place' ? (
            <Notice tone="warning" title="This changes the live model">
              Reports and Copilot that use “{modelName}” see the change straight away. The model is checked again before writing: if it was edited in Fabric since these fixes were generated, nothing is written.
            </Notice>
          ) : null}
          {effective.some((p) => p.generatedBy === 'llm') ? (
            <Notice tone="caution" title="Contains AI-written text">
              Read the AI-drafted descriptions and instructions before you apply. They are metadata about your model, but Copilot will repeat them to users.
            </Notice>
          ) : null}
          <ul className="max-h-56 list-inside list-disc overflow-auto text-200 leading-300 text-muted-foreground">
            {effective.map((p) => (
              <li key={p.id}>
                {p.title} <span className="font-numeric">({p.changes.length})</span>
              </li>
            ))}
          </ul>
        </div>
      </Dialog>

      <Dialog
        open={rollbackTarget !== null}
        dismissible={!rollback.busy}
        onClose={closeRollback}
        title="Roll back this change set?"
        footer={
          <>
            <Button variant="ghost" onClick={closeRollback} disabled={rollback.busy}>
              Cancel
            </Button>
            <Button variant="danger" busy={rollback.busy} icon={<History className="icon-size-200" aria-hidden />} onClick={runRollback}>
              {needsDiscardConfirm ? 'Discard later edits and restore' : 'Restore the snapshot'}
            </Button>
          </>
        }
      >
        <div className="space-y-300">
          <p className="text-300 leading-300">
            The model definition is restored to the snapshot taken just before this change set was applied. The app first checks that nobody edited the model since; if they did, you are asked to confirm before those edits are discarded.
          </p>
          {rollback.error ? (
            <Notice tone={needsDiscardConfirm ? 'warning' : 'danger'} title={needsDiscardConfirm ? 'The model was edited since' : 'Rollback failed'}>
              {rollback.error}
            </Notice>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
