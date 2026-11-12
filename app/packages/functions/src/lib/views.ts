import {
  applyProposals,
  assertModelDefinition,
  buildSnapshot,
  type DefinitionParts,
  type FabricClient,
  type FixProposal,
  type GovernanceInfo,
  type ModelSnapshot,
  type ScoreResult,
  isCopilotEligibleSku,
} from '@rayfin-app/engine';
import type { ProposalImpact, ScoreHeadline, ScoreView, TreeView } from '../contracts.js';

const MAX_FINDINGS = 400;
const MAX_TREE_OBJECTS = 4000;

export function scoreView(s: ScoreResult): ScoreView {
  return {
    catalogVersion: s.catalogVersion,
    mode: s.mode,
    modelName: s.modelName,
    score: round1(s.score),
    rawScore: round1(s.rawScore),
    tier: s.tier,
    categories: s.categories.map((c) => ({ ...c, score: round1(c.score), points: round1(c.points) })),
    gates: s.gates,
    rules: s.rules.map((r) => ({ ruleId: r.ruleId, score: r.score === null ? null : Math.round(r.score * 1000) / 1000, evidence: r.evidence, findingCount: r.findings.length })),
    findings: s.findings.slice(0, MAX_FINDINGS).map((f) => ({
      ruleId: f.ruleId,
      objectType: f.objectType,
      objectPath: f.objectPath,
      message: f.message,
      fixKind: f.fixKind,
    })),
    findingsTotal: s.findings.length,
    stats: s.stats,
    computedAt: s.computedAt,
  };
}

export function headline(s: ScoreResult): ScoreHeadline {
  return {
    score: round1(s.score),
    tier: s.tier,
    categories: s.categories.map((c) => ({ id: c.id, title: c.title, score: round1(c.score) })),
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What each proposal is worth when applied alone, per readiness category. The client combines these
 * to show a live score while the user ticks proposals, so only the gains that matter are kept.
 */
export function proposalImpacts(
  base: { parts: DefinitionParts; name: string; governance: GovernanceInfo },
  before: ScoreResult,
  proposals: FixProposal[],
): ProposalImpact[] {
  return proposals.map((p) => {
    const after = applyProposals(base, [p]).score;
    return {
      proposalId: p.id,
      gain: round3(after.score - before.score),
      categories: after.categories
        .map((c) => ({ id: c.id, gain: round3(c.score - (before.categories.find((b) => b.id === c.id)?.score ?? c.score)) }))
        .filter((c) => c.gain !== 0),
    };
  });
}

export function treeView(snap: ModelSnapshot): TreeView {
  let budget = MAX_TREE_OBJECTS;
  let truncated = false;
  const tables = snap.tables.map((t) => {
    const columns = t.columns.slice(0, Math.max(0, budget)).map((c) => ({
      name: c.name,
      dataType: c.dataType,
      hidden: c.isHidden,
      calculated: c.isCalculated,
      description: c.description ?? null,
      aiVisibility: c.aiVisibility ?? null,
    }));
    budget -= columns.length;
    if (columns.length < t.columns.length) truncated = true;
    const measures = t.measures.slice(0, Math.max(0, budget)).map((m) => ({
      name: m.name,
      expression: m.expression.length > 600 ? `${m.expression.slice(0, 600)}...` : m.expression,
      hidden: m.isHidden,
      description: m.description ?? null,
      formatString: m.formatString ?? null,
      displayFolder: m.displayFolder ?? null,
      aiVisibility: m.aiVisibility ?? null,
    }));
    budget -= measures.length;
    if (measures.length < t.measures.length) truncated = true;
    return {
      name: t.name,
      hidden: t.isHidden,
      calculated: t.isCalculatedTable,
      description: t.description ?? null,
      aiVisibility: t.aiVisibility ?? null,
      columns,
      measures,
    };
  });
  const c = snap.copilot;
  return {
    tables,
    relationships: snap.relationships,
    instructions: c.instructions ?? null,
    examplePrompts: c.examplePrompts,
    hasSchema: c.hasSchema,
    indexingEnabled: c.indexingEnabled ?? null,
    verifiedAnswerCount: c.verifiedAnswerCount,
    truncated,
  };
}

export interface LoadedModel {
  workspaceName: string;
  modelName: string;
  parts: DefinitionParts;
  governance: GovernanceInfo;
  lastRefresh: { status: string | null; endTime: string | null } | null;
}

/** Reads the definition plus the facts the governance rules need. Side lookups never fail the load. */
async function readModel(
  client: FabricClient,
  workspaceId: string,
  modelId: string,
  approved?: boolean | null,
): Promise<LoadedModel> {
  const [workspace, dataset, refresh, parts] = await Promise.all([
    client.getWorkspace(workspaceId).catch(() => undefined),
    client.getDataset(workspaceId, modelId).catch(() => undefined),
    client.lastRefresh(workspaceId, modelId).catch(() => undefined),
    client.getDefinition(workspaceId, modelId),
  ]);
  assertModelDefinition(parts);
  let capacityEligible: boolean | null = null;
  if (workspace?.capacityId) {
    const caps = await client.listCapacities().catch(() => undefined);
    const cap = caps?.find((c) => c.id.toLowerCase() === workspace.capacityId!.toLowerCase());
    capacityEligible = cap ? isCopilotEligibleSku(cap.sku) : null;
  } else if (workspace) {
    capacityEligible = false;
  }
  const datasetName = typeof dataset?.name === 'string' ? dataset.name : undefined;
  const storage = typeof dataset?.targetStorageMode === 'string' ? dataset.targetStorageMode : null;
  const governance: GovernanceInfo = {
    approvedForCopilot: typeof approved === 'boolean' ? approved : null,
    capacityEligible,
    lastRefreshSucceeded: refresh?.status ? refresh.status === 'Completed' : null,
    lastRefreshAt: refresh?.endTime ?? null,
    storageMode: storage,
  };
  return {
    workspaceName: workspace?.displayName ?? workspaceId,
    modelName: datasetName ?? modelId,
    parts,
    governance,
    lastRefresh: refresh ? { status: refresh.status ?? null, endTime: refresh.endTime ?? null } : null,
  };
}

export function snapshotOf(m: LoadedModel): ModelSnapshot {
  return buildSnapshot(m.parts, { name: m.modelName, governance: m.governance });
}

// Exporting a definition from Fabric takes several seconds, and the interview needs the model on every question.
// This keeps the last read for a few minutes. It is best effort: a cold instance simply reads again.
const MODEL_CACHE_MS = 5 * 60_000;
const MODEL_CACHE_MAX = 30;
const modelCache = new Map<string, { at: number; model: Promise<LoadedModel> }>();
const cacheKey = (workspaceId: string, modelId: string) => `${workspaceId}/${modelId}`.toLowerCase();

function remember(key: string, model: Promise<LoadedModel>): void {
  modelCache.delete(key);
  modelCache.set(key, { at: Date.now(), model });
  while (modelCache.size > MODEL_CACHE_MAX) {
    const oldest = modelCache.keys().next().value;
    if (oldest === undefined) break;
    modelCache.delete(oldest);
  }
}

/** Drops the remembered read. Call it after anything that changes the model. */
export function forgetModel(workspaceId: string, modelId: string): void {
  modelCache.delete(cacheKey(workspaceId, modelId));
}

/** Always reads from Fabric. Use it before a write, so the change is planned against the current model. */
export async function loadModel(
  client: FabricClient,
  workspaceId: string,
  modelId: string,
  approved?: boolean | null,
): Promise<LoadedModel> {
  const model = await readModel(client, workspaceId, modelId, approved);
  remember(cacheKey(workspaceId, modelId), Promise.resolve(model));
  return model;
}

/**
 * For read-only work that only feeds a prompt with names and formulas (the context draft and interview).
 * Serves a read from the last few minutes, and shares one read between concurrent callers.
 */
export function loadModelCached(
  client: FabricClient,
  workspaceId: string,
  modelId: string,
  approved?: boolean | null,
): Promise<LoadedModel> {
  const key = cacheKey(workspaceId, modelId);
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.model;
  const pending = readModel(client, workspaceId, modelId, approved);
  remember(key, pending);
  pending.catch(() => {
    if (modelCache.get(key)?.model === pending) modelCache.delete(key);
  });
  return pending;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
