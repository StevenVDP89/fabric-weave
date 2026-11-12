import {
  CONTEXT_TEXT_MAX,
  INTERVIEW_MAX_QUESTIONS,
  UnavailableLlm,
  VALIDATION_LIMITS,
  applyProposals,
  gatherAgentAvailability,
  judgeToExternal,
  llmBusinessContext,
  llmInterview,
  llmJudge,
  proposeFixes,
  scoreModel,
  type AgentAvailability,
  type FixProposal,
  type JudgeResult,
} from '@rayfin-app/engine';
import type { WriteMode } from '@rayfin-app/shared';
import type {
  ApprovalResult,
  AssessmentSummary,
  AssessmentView,
  BusinessContextDraft,
  InterviewStep,
  InterviewTurn,
  ModelView,
  PortfolioQuery,
  PortfolioView,
  ProposalView,
  ServiceStatus,
  WorkspaceView,
} from '../contracts.js';
import { portfolioConfigured, readPortfolio, EMPTY_TOTALS } from './portfolio.js';
import { adminsConfigured, identitiesOf, isAdmin, userRefOf } from './access.js';
import {
  accessCounts,
  canRead,
  canSeeWorkspace,
  canWrite,
  editableWorkspaces,
  grantsOf,
  requireModelRead,
  requireModelWrite,
  requireWorkspaceAdmin,
  requireWorkspaceRead,
} from './permissions.js';
import { unreachableSources } from './sourceCheck.js';
import { definitionDigest, signSetting, usableSigningKey } from './integrity.js';
import { actorOf, config, errorMessage, fabricClient, llmClient, type Ctx } from './runtime.js';
import { audit, readAssessmentRow, readBusinessContext, readSettings, saveAssessment } from './store.js';
import { headline, loadModel, loadModelCached, proposalImpacts, scoreView, snapshotOf, treeView } from './views.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_MODES: readonly WriteMode[] = ['in-place', 'propose-only', 'clone'];

export function assertGuid(value: string, label: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error(`${label} must be a GUID.`);
  return value.toLowerCase();
}

export function iso(d: Date | string | null | undefined): string {
  if (!d) return '';
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

// ---------------------------------------------------------------------------
// Workspaces and models
// ---------------------------------------------------------------------------

export async function listWorkspaces(ctx: Ctx): Promise<WorkspaceView[]> {
  const [workspaces, settings, grants] = await Promise.all([fabricClient(ctx).listWorkspaces(), readSettings(ctx), grantsOf(ctx)]);
  const visible = workspaces.filter((w) => (!w.type || w.type === 'Workspace') && canSeeWorkspace(grants, w.id)).slice(0, 1000);
  const editable = await editableWorkspaces(
    ctx,
    grants,
    visible.map((w) => w.id),
  ).catch(() => new Set<string>());
  return visible
    .map((w): WorkspaceView => {
      const s = settings.get(w.id);
      return {
        id: w.id,
        name: w.displayName,
        capacityId: w.capacityId ?? null,
        writeMode: s?.write_mode ?? 'propose-only',
        inScope: s?.in_scope ?? false,
        configured: !!s,
        unverified: s?.unverified ?? false,
        canEdit: editable.has(w.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveWorkspaceSetting(ctx: Ctx, workspaceId: string, writeMode: WriteMode, inScope: boolean): Promise<WorkspaceView> {
  const id = assertGuid(workspaceId, 'workspaceId');
  await requireWorkspaceAdmin(ctx, id, 'change a workspace write mode');
  if (!WRITE_MODES.includes(writeMode)) throw new Error('writeMode must be in-place, propose-only or clone.');
  const key = config(ctx, 'SIGNING_KEY');
  if (writeMode !== 'propose-only' && !usableSigningKey(key)) {
    throw new Error('Writing to models needs the SIGNING_KEY secret (at least 32 characters). Set it, or keep this workspace on propose-only. See the Status page.');
  }
  const ws = await fabricClient(ctx).getWorkspace(id);
  const data = ctx.getDataClient();
  const record = {
    workspace_id: id,
    workspace_name: ws.displayName.slice(0, 200),
    write_mode: writeMode,
    in_scope: !!inScope,
    // Always overwritten: a stale signature on an edited row must not survive.
    sig: usableSigningKey(key) ? signSetting(key, { workspaceId: id, writeMode, inScope: !!inScope }) : '',
    updated_at: new Date(),
    updated_by: actorOf(ctx),
  };
  const [existing] = await data.WorkspaceSetting.select(['id']).where({ workspace_id: { eq: id } }).first(1).execute();
  if (existing) await data.WorkspaceSetting.update({ id: existing.id }, record);
  else await data.WorkspaceSetting.create(record);
  await audit(ctx, { action: 'workspace.setting', workspaceId: id, details: `mode=${writeMode} inScope=${!!inScope}` });
  return { id, name: ws.displayName, capacityId: ws.capacityId ?? null, writeMode, inScope: !!inScope, configured: true, unverified: false, canEdit: true };
}

export async function listModels(ctx: Ctx, workspaceId: string): Promise<ModelView[]> {
  const id = assertGuid(workspaceId, 'workspaceId');
  const grants = await requireWorkspaceRead(ctx, id);
  const client = fabricClient(ctx);
  const [workspace, models, rows] = await Promise.all([
    client.getWorkspace(id).catch(() => undefined),
    client.listSemanticModels(id),
    ctx
      .getDataClient()
      .ModelAssessment.select(['model_id', 'score10', 'tier', 'mode', 'assessed_at', 'findings_count', 'approved_for_copilot'])
      .where({ workspace_id: { eq: id } })
      .first(1000)
      .execute(),
  ]);
  const byModel = new Map(rows.map((r) => [r.model_id, r]));
  return models
    .filter((m) => canRead(grants, id, m.id))
    .map((m): ModelView => {
      const r = byModel.get(m.id);
      const assessment: AssessmentSummary | null = r
        ? {
            score: r.score10 / 10,
            tier: r.tier,
            mode: r.mode,
            assessedAt: iso(r.assessed_at),
            findingsCount: r.findings_count,
            approvedForCopilot: r.approved_for_copilot ?? null,
          }
        : null;
      return {
        workspaceId: id,
        workspaceName: workspace?.displayName ?? id,
        id: m.id,
        name: m.displayName,
        description: m.description ?? null,
        assessment,
        canWrite: canWrite(grants, id, m.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export async function assessModel(ctx: Ctx, workspaceId: string, modelId: string, useJudge: boolean): Promise<AssessmentView> {
  const ws = assertGuid(workspaceId, 'workspaceId');
  const mid = assertGuid(modelId, 'modelId');
  const grants = await requireModelRead(ctx, ws, mid);
  const client = fabricClient(ctx);
  const row = await readAssessmentRow(ctx, mid);
  const loaded = await loadModel(client, ws, mid, row?.approved_for_copilot ?? null);
  const snap = snapshotOf(loaded);

  let judge: JudgeResult | null = null;
  let judgeError: string | null = null;
  if (useJudge) {
    const llm = llmClient(ctx);
    if (llm instanceof UnavailableLlm) judgeError = 'No Azure OpenAI deployment is configured for this app.';
    else {
      try {
        judge = await llmJudge(llm, snap);
      } catch (e) {
        judgeError = errorMessage(e);
      }
    }
  }
  const score = scoreModel(snap, judge ? { external: judgeToExternal(judge) } : {});
  try {
    await saveAssessment(ctx, { workspaceId: ws, workspaceName: loaded.workspaceName, modelId: mid, modelName: loaded.modelName, score });
  } catch (e) {
    judgeError = judgeError ?? `The score was computed but could not be saved: ${errorMessage(e)}`;
  }
  await audit(ctx, { action: 'model.assess', workspaceId: ws, modelId: mid, details: `score=${score.score.toFixed(1)} judge=${judge ? 'yes' : 'no'}` });
  return {
    workspaceId: ws,
    workspaceName: loaded.workspaceName,
    modelId: mid,
    modelName: loaded.modelName,
    score: scoreView(score),
    tree: treeView(snap),
    judge,
    judgeError,
    businessContext: (await readBusinessContext(ctx, mid).catch(() => undefined)) ?? null,
    lastRefresh: loaded.lastRefresh,
    assessedAt: new Date().toISOString(),
    canWrite: canWrite(grants, ws, mid),
  };
}

// ---------------------------------------------------------------------------
// Fix proposals
// ---------------------------------------------------------------------------

/** Keeps the proposal list inside the limits the apply step will accept. */
function fitToLimits(proposals: FixProposal[], notes: string[]): FixProposal[] {
  const out: FixProposal[] = [];
  let changes = 0;
  for (const p of proposals) {
    if (out.length >= VALIDATION_LIMITS.proposals || changes + p.changes.length > VALIDATION_LIMITS.changes) continue;
    out.push(p);
    changes += p.changes.length;
  }
  if (out.length < proposals.length) {
    notes.push(`${proposals.length - out.length} lower-impact proposals were left out to keep one change set reviewable. Apply this batch, then run the analysis again.`);
  }
  return out;
}

export async function getFixProposals(ctx: Ctx, workspaceId: string, modelId: string, useAi: boolean): Promise<ProposalView> {
  const ws = assertGuid(workspaceId, 'workspaceId');
  const mid = assertGuid(modelId, 'modelId');
  await requireModelRead(ctx, ws, mid);
  const client = fabricClient(ctx);
  const row = await readAssessmentRow(ctx, mid);
  const loaded = await loadModel(client, ws, mid, row?.approved_for_copilot ?? null);
  const context = await readBusinessContext(ctx, mid).catch(() => undefined);
  const llm = useAi ? llmClient(ctx) : undefined;
  const out = await proposeFixes({ parts: loaded.parts, name: loaded.modelName, governance: loaded.governance, context, llm });
  const notes = [...out.notes];
  if (useAi && llm instanceof UnavailableLlm) notes.push('No Azure OpenAI deployment is configured, so deterministic templates were used.');
  const proposals = fitToLimits(out.proposals, notes);
  const base = { parts: loaded.parts, name: loaded.modelName, governance: loaded.governance };
  const projected = applyProposals(base, proposals);
  await audit(ctx, { action: 'model.propose', workspaceId: ws, modelId: mid, details: `proposals=${proposals.length} ai=${useAi && !(llm instanceof UnavailableLlm)}` });
  return {
    proposals,
    before: headline(out.score),
    projected: headline(projected.score),
    impacts: proposalImpacts(base, out.score, proposals),
    writeBlockers: await unreachableSources(client, loaded.parts),
    notes,
    generator: useAi && llm && !(llm instanceof UnavailableLlm) ? llm.name : 'templates',
    businessContextUsed: !!context,
    baseDigest: definitionDigest(loaded.parts),
  };
}

// ---------------------------------------------------------------------------
// Agent availability and AI helpers
// ---------------------------------------------------------------------------

export async function getAgentReadiness(ctx: Ctx, workspaceId: string, modelId: string): Promise<AgentAvailability> {
  const ws = assertGuid(workspaceId, 'workspaceId');
  const mid = assertGuid(modelId, 'modelId');
  await requireModelRead(ctx, ws, mid);
  const client = fabricClient(ctx);
  const row = await readAssessmentRow(ctx, mid);
  const parts = await client.getDefinition(ws, mid);
  const snapshot = snapshotOf({
    workspaceName: ws,
    modelName: row?.model_name ?? mid,
    parts,
    governance: {},
    lastRefresh: null,
  });
  return gatherAgentAvailability(client, ws, mid, { snapshot, approvedForCopilotAttested: row?.approved_for_copilot ?? null });
}

export async function setApprovedForCopilot(ctx: Ctx, workspaceId: string, modelId: string, approved: boolean): Promise<ApprovalResult> {
  const ws = assertGuid(workspaceId, 'workspaceId');
  const mid = assertGuid(modelId, 'modelId');
  await requireModelWrite(ctx, ws, mid, 'record whether a model is approved for Copilot');
  const data = ctx.getDataClient();
  const row = await readAssessmentRow(ctx, mid);
  if (!row) throw new Error('Assess the model first, then record whether it is approved for Copilot.');
  await data.ModelAssessment.update({ id: row.id }, { approved_for_copilot: !!approved });
  await audit(ctx, { action: 'model.approvedForCopilot', workspaceId: ws, modelId: mid, details: `attested=${!!approved}` });
  return { modelId: mid, approvedForCopilot: !!approved };
}

export async function draftBusinessContext(ctx: Ctx, workspaceId: string, modelId: string): Promise<BusinessContextDraft> {
  const ws = assertGuid(workspaceId, 'workspaceId');
  const mid = assertGuid(modelId, 'modelId');
  await requireModelRead(ctx, ws, mid);
  const llm = llmClient(ctx);
  if (llm instanceof UnavailableLlm) throw new Error('No Azure OpenAI deployment is configured, so the AI draft is unavailable. Fill the business context in by hand.');
  const loaded = await loadModelCached(fabricClient(ctx), ws, mid, null);
  const context = await llmBusinessContext(llm, snapshotOf(loaded));
  await audit(ctx, { action: 'context.draft', workspaceId: ws, modelId: mid });
  return { context, generator: llm.name };
}

const INTERVIEW_QUESTION_MAX = 500;
const INTERVIEW_ANSWER_MAX = 1500;

/** Bounds the replayed interview: the client is not trusted to keep it small or well formed. */
export function cleanInterviewTurns(turns: unknown): InterviewTurn[] {
  if (!Array.isArray(turns)) throw new Error('turns must be a list of questions and answers.');
  return turns.slice(0, INTERVIEW_MAX_QUESTIONS).map((t: unknown) => {
    const item = (t ?? {}) as { question?: unknown; answer?: unknown };
    const question = typeof item.question === 'string' ? item.question.trim().slice(0, INTERVIEW_QUESTION_MAX) : '';
    const answer = typeof item.answer === 'string' ? item.answer.trim().slice(0, INTERVIEW_ANSWER_MAX) : '';
    if (!question) throw new Error('Every answer needs the question it responds to.');
    return { question, answer: answer || '(no answer)' };
  });
}

/** One step of the context interview. The server keeps no state: the client replays the turns so far. */
export async function interviewBusinessContext(
  ctx: Ctx,
  workspaceId: string,
  modelId: string,
  turns: InterviewTurn[],
  existing: string,
  finish: boolean,
): Promise<InterviewStep> {
  const ws = assertGuid(workspaceId, 'workspaceId');
  const mid = assertGuid(modelId, 'modelId');
  const clean = cleanInterviewTurns(turns);
  const prior = typeof existing === 'string' ? existing.trim().slice(0, CONTEXT_TEXT_MAX) : '';
  const wrapUp = !!finish;
  if (wrapUp && clean.length === 0 && !prior) throw new Error('There is nothing to summarise yet. Answer at least one question first.');
  await requireModelRead(ctx, ws, mid);
  const llm = llmClient(ctx);
  if (llm instanceof UnavailableLlm) throw new Error('No Azure OpenAI deployment is configured, so the interview agent is unavailable. Write the context by hand.');
  const loaded = await loadModelCached(fabricClient(ctx), ws, mid, null);
  const step = await llmInterview(llm, snapshotOf(loaded), { existing: prior, turns: clean, finish: wrapUp });
  // Answers can hold business detail: the audit trail records the shape of the interview, not its content.
  await audit(ctx, { action: 'context.interview', workspaceId: ws, modelId: mid, details: `answered=${clean.length},done=${step.done}` });
  return step;
}

// ---------------------------------------------------------------------------
// Portfolio and service status
// ---------------------------------------------------------------------------

export async function getPortfolio(ctx: Ctx, query: PortfolioQuery): Promise<PortfolioView> {
  const grants = await grantsOf(ctx);
  if (grants.source === 'unresolved') {
    return { available: false, reason: grants.note, generatedAt: null, lastRun: null, totals: EMPTY_TOTALS, total: 0, models: [] };
  }
  const rows = await ctx
    .getDataClient()
    .ModelAssessment.select(['model_id', 'score10', 'assessed_at', 'mode'])
    .first(5000)
    .execute();
  const deep = new Map(rows.filter((r) => r.mode === 'deep').map((r) => [r.model_id, { score: r.score10 / 10, assessedAt: iso(r.assessed_at) }]));
  return readPortfolio(ctx, query ?? {}, deep, grants.source === 'everything' ? undefined : (m) => canRead(grants, m.workspaceId, m.modelId));
}

export async function getServiceStatus(ctx: Ctx): Promise<ServiceStatus> {
  let fabricTokenOk = true;
  let fabricError: string | null = null;
  try {
    await fabricClient(ctx).listWorkspaces();
  } catch (e) {
    fabricTokenOk = false;
    fabricError = errorMessage(e);
  }
  const llm = llmClient(ctx);
  const configured = !(llm instanceof UnavailableLlm);
  let available = false;
  let generatedAt: string | null = null;
  const portfolio = portfolioConfigured(ctx);
  if (portfolio) {
    const view = await readPortfolio(ctx, { limit: 1 }, new Map());
    available = view.available;
    generatedAt = view.generatedAt;
  }
  const grants = await grantsOf(ctx);
  const counts = accessCounts(grants);
  return {
    fabricTokenOk,
    fabricError,
    llm: { configured, name: llm.name, deployment: configured ? (config(ctx, 'AOAI_DEPLOYMENT') ?? 'gpt-4.1') : null },
    portfolio: { configured: portfolio, available, generatedAt },
    snapshotSigning: usableSigningKey(config(ctx, 'SIGNING_KEY')),
    actor: actorOf(ctx),
    identities: identitiesOf(ctx),
    isAdmin: isAdmin(ctx),
    adminsConfigured: adminsConfigured(ctx),
    access: { source: grants.source, userRef: userRefOf(ctx) ?? null, workspaces: counts.workspaces, models: counts.models, note: grants.note },
  };
}
