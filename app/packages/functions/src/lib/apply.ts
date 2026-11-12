import {
  FabricClient,
  applyProposals,
  buildSnapshot,
  diffParts,
  scoreModel,
  validateProposals,
  type Change,
  type DefinitionParts,
  type ModelSnapshot,
} from '@rayfin-app/engine';
import type { ApplyResultView, DefinitionDiff, RollbackResultView } from '../contracts.js';
import { forgetAccess, requireModelWrite } from './permissions.js';
import { definitionDigest, disallowedPartPaths, signSnapshot, usableSigningKey, verifySnapshot } from './integrity.js';
import { assertGuid, iso } from './ops.js';
import { actorOf, config, errorMessage, fabricClient, type Ctx } from './runtime.js';
import { SOURCE_FIX_HINT, explainFabricWriteError, unreachableSources } from './sourceCheck.js';
import { audit, headlineScore10, loadSnapshot, readAssessmentRow, readSetting, saveAssessment, saveSnapshot, unpackParts } from './store.js';
import { forgetModel, headline, loadModel, snapshotOf } from './views.js';

const MAX_DIFF_PARTS = 40;
const MAX_DIFF_CHARS = 60_000;
const KEEP_SNAPSHOTS = 5;
/** The re-read score may differ slightly from the projection (rounding of rules that depend on refresh timing). */
const VERIFY_TOLERANCE = 0.6;

/** Structure the apply step must never change. Returns problems; empty means the change is additive only. */
export function integrityProblems(before: ModelSnapshot, after: ModelSnapshot, applied: Change[], beforeParts: DefinitionParts, afterParts: DefinitionParts): string[] {
  const problems: string[] = [];
  const names = (s: ModelSnapshot) => s.tables.map((t) => t.name).sort();
  if (names(before).join('\u0000') !== names(after).join('\u0000')) problems.push('The set of tables changed.');
  const afterTables = new Map(after.tables.map((t) => [t.name, t]));
  const added = new Map<string, Set<string>>();
  for (const c of applied) {
    if (c.op === 'addMeasure') {
      const set = added.get(c.table) ?? new Set<string>();
      set.add(c.name);
      added.set(c.table, set);
    }
  }
  for (const t of before.tables) {
    const a = afterTables.get(t.name);
    if (!a) continue;
    const cols = (x: typeof t) => x.columns.map((c) => c.name).sort().join('\u0000');
    if (cols(t) !== cols(a)) problems.push(`Columns of table "${t.name}" changed.`);
    const expected = [...t.measures.map((m) => m.name), ...(added.get(t.name) ?? [])].sort().join('\u0000');
    if (expected !== a.measures.map((m) => m.name).sort().join('\u0000')) problems.push(`Measures of table "${t.name}" are not what the change set implies.`);
  }
  for (const t of after.tables) {
    const keys = t.columns.filter((c) => c.isKey).map((c) => c.name);
    if (keys.length > 1) problems.push(`Table "${t.name}" would have more than one key column (${keys.join(', ')}); the service rejects that.`);
  }
  const rel = (s: ModelSnapshot) => s.relationships.map((r) => `${r.fromTable}.${r.fromColumn}>${r.toTable}.${r.toColumn}|${r.isActive}|${r.crossFilter}`).sort().join('\u0000');
  if (rel(before) !== rel(after)) problems.push('Relationships changed.');
  for (const p of Object.keys(beforeParts)) {
    if (afterParts[p] === undefined) problems.push(`Definition part "${p}" would be removed.`);
  }
  return problems;
}

function capDiffs(before: DefinitionParts, after: DefinitionParts): DefinitionDiff[] {
  const out: DefinitionDiff[] = [];
  let chars = 0;
  for (const d of diffParts(before, after)) {
    if (out.length >= MAX_DIFF_PARTS) break;
    const size = (d.before?.length ?? 0) + (d.after?.length ?? 0);
    if (chars + size > MAX_DIFF_CHARS && out.length > 0) break;
    chars += size;
    out.push(d);
  }
  return out;
}

/** The runtime may hand a list of objects over as JSON text; accept both. */
function parseProposals(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error('The change set was rejected: it is not valid JSON.');
  }
}

/** Labels a failure with the step it happened in, because the platform only shows the message. */
async function stage<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Error(`${label}: ${explainFabricWriteError(errorMessage(e))}`);
  }
}

/** Writes a definition to Fabric. The remembered read of that model is dropped whether or not the write succeeded. */
async function writeDefinition(client: FabricClient, ws: string, mid: string, parts: DefinitionParts): Promise<void> {
  try {
    await client.updateDefinition(ws, mid, parts);
  } finally {
    forgetModel(ws, mid);
  }
}

/** Refuses to write when a Direct Lake source is gone, because Fabric would reject the update anyway. */
async function assertSourcesReachable(ctx: Ctx, client: FabricClient, ws: string, mid: string, parts: DefinitionParts): Promise<void> {
  const problems = await unreachableSources(client, parts);
  if (problems.length === 0) return;
  await audit(ctx, { action: 'model.apply', workspaceId: ws, modelId: mid, outcome: 'error', details: `refused: ${problems.join(' ')}` });
  throw new Error(`The model was not changed. ${problems.join(' ')} ${SOURCE_FIX_HINT}`);
}

async function recordChangeSet(
  ctx: Ctx,
  v: {
    workspaceId: string;
    modelId: string;
    modelName: string;
    mode: 'in-place' | 'propose-only' | 'clone';
    status: 'applied' | 'proposed' | 'failed';
    proposalIds: string[];
    changeCount: number;
    scoreBefore: number;
    scoreAfter: number;
    summary: string;
    snapshotId?: string;
    snapshotSig?: string;
    resultDigest?: string;
    targetModelId?: string;
  },
): Promise<string> {
  const row = await ctx.getDataClient().ChangeSet.create({
    workspace_id: v.workspaceId,
    model_id: v.modelId,
    model_name: v.modelName.slice(0, 200),
    mode: v.mode,
    status: v.status,
    proposal_ids: v.proposalIds.join(',').slice(0, 1000),
    change_count: v.changeCount,
    score_before10: headlineScore10(v.scoreBefore),
    score_after10: headlineScore10(v.scoreAfter),
    summary: v.summary.slice(0, 1000),
    ...(v.snapshotId ? { snapshot_id: v.snapshotId } : {}),
    ...(v.snapshotSig ? { snapshot_sig: v.snapshotSig } : {}),
    ...(v.resultDigest ? { result_digest: v.resultDigest } : {}),
    ...(v.targetModelId ? { target_model_id: v.targetModelId } : {}),
    created_at: new Date(),
    created_by: actorOf(ctx),
  });
  return row.id;
}

export async function applyFixes(ctx: Ctx, workspaceId: string, modelId: string, proposals: unknown, baseDigest: unknown): Promise<ApplyResultView> {
  const ws = assertGuid(workspaceId, 'workspaceId');
  const mid = assertGuid(modelId, 'modelId');
  await requireModelWrite(ctx, ws, mid, 'apply fixes to this model');
  if (typeof baseDigest !== 'string' || !/^[0-9a-f]{64}$/.test(baseDigest)) {
    throw new Error('The request did not say which version of the model the fixes were built from. Reload the page and run the analysis again.');
  }

  const checked = validateProposals(parseProposals(proposals));
  if (!checked.ok) throw new Error(`The change set was rejected: ${checked.errors.join(' ')}`);

  const setting = await stage('Reading the workspace settings failed', () => readSetting(ctx, ws));
  if (setting?.unverified) {
    throw new Error('The write mode stored for this workspace was not saved by the app, so it is ignored. An administrator must open Settings and save the workspace again.');
  }
  if (!setting || !setting.in_scope) {
    throw new Error('This workspace is not enabled for changes. Open Settings, choose a write mode for the workspace and enable it first.');
  }

  const client = fabricClient(ctx);
  const loaded = await stage('Reading the model from Fabric failed', async () => {
    const row = await readAssessmentRow(ctx, mid);
    return loadModel(client, ws, mid, row?.approved_for_copilot ?? null);
  });
  if (definitionDigest(loaded.parts) !== baseDigest) {
    await audit(ctx, { action: 'model.apply', workspaceId: ws, modelId: mid, outcome: 'error', details: 'refused: the model changed in Fabric after the proposals were generated' });
    throw new Error('The model changed in Fabric after these fixes were generated, so nothing was written. Run the analysis again to get fixes for the current model.');
  }
  const input = { parts: loaded.parts, name: loaded.modelName, governance: loaded.governance };
  const snapBefore = snapshotOf(loaded);
  const scoreBefore = scoreModel(snapBefore);
  const result = applyProposals(input, checked.proposals);

  const problems = integrityProblems(snapBefore, result.snapshot, result.applied, loaded.parts, result.parts);
  if (problems.length > 0) {
    await audit(ctx, { action: 'model.apply', workspaceId: ws, modelId: mid, outcome: 'error', details: `integrity check failed: ${problems.join(' ')}` });
    throw new Error(`Safety check failed, nothing was written: ${problems.join(' ')}`);
  }

  const skipped = result.skipped.map((s) => ({ op: s.change.op, reason: s.reason }));
  const changedParts = capDiffs(loaded.parts, result.parts);
  const base = {
    mode: setting.write_mode,
    applied: result.applied.length,
    skipped,
    before: headline(scoreBefore),
    changedParts,
  };
  const proposalIds = checked.proposals.map((p) => p.id);

  if (result.applied.length === 0) {
    return { ...base, changeSetId: '', status: 'failed', after: headline(scoreBefore), verified: false, message: 'None of the selected changes could be applied to this model.', targetModelId: null };
  }

  if (setting.write_mode === 'propose-only') {
    const id = await recordChangeSet(ctx, {
      workspaceId: ws,
      modelId: mid,
      modelName: loaded.modelName,
      mode: 'propose-only',
      status: 'proposed',
      proposalIds,
      changeCount: result.applied.length,
      scoreBefore: scoreBefore.score,
      scoreAfter: result.score.score,
      summary: `Proposed ${result.applied.length} changes; the model was not modified.`,
    });
    await audit(ctx, { action: 'model.propose-only', workspaceId: ws, modelId: mid, details: `changeSet=${id} changes=${result.applied.length}` });
    return {
      ...base,
      changeSetId: id,
      status: 'proposed',
      after: headline(result.score),
      verified: false,
      message: 'Nothing was written to Fabric. Review the changed definition parts below and commit them through your Git or deployment-pipeline process.',
      targetModelId: null,
    };
  }

  if (setting.write_mode === 'clone') {
    await assertSourcesReachable(ctx, client, ws, mid, loaded.parts);
    const cloneName = `${loaded.modelName} (AI-ready)`.slice(0, 256);
    const targetId = await stage('Writing the AI-ready copy failed', async () => {
      const existing = (await client.listSemanticModels(ws)).find((m) => m.displayName === cloneName);
      if (existing) {
        await writeDefinition(client, ws, existing.id, result.parts);
        return existing.id;
      }
      return (await client.createSemanticModel(ws, cloneName, result.parts, 'AI-ready copy created by Fabric Weave')).id;
    });
    forgetAccess();
    const reread = scoreModel(
      buildSnapshot(await stage('Reading the AI-ready copy back failed', () => client.getDefinition(ws, targetId)), { name: cloneName, governance: loaded.governance }),
    );
    const verified = Math.abs(reread.score - result.score.score) <= VERIFY_TOLERANCE;
    const id = await recordChangeSet(ctx, {
      workspaceId: ws,
      modelId: mid,
      modelName: loaded.modelName,
      mode: 'clone',
      status: 'applied',
      proposalIds,
      changeCount: result.applied.length,
      scoreBefore: scoreBefore.score,
      scoreAfter: reread.score,
      summary: `Created or updated "${cloneName}" with ${result.applied.length} changes; the original is untouched.`,
      targetModelId: targetId,
    });
    await audit(ctx, { action: 'model.apply-clone', workspaceId: ws, modelId: mid, details: `changeSet=${id} clone=${targetId} verified=${verified}` });
    return {
      ...base,
      changeSetId: id,
      status: 'applied',
      after: headline(reread),
      verified,
      message: `Wrote the AI-ready copy "${cloneName}". Set data source credentials and refresh it in Fabric before pointing reports at it. The original model is untouched.`,
      targetModelId: targetId,
    };
  }

  // In-place: snapshot first so the change can always be undone. The snapshot is signed so it
  // cannot be swapped for attacker-controlled content before a rollback restores it.
  const signingKey = config(ctx, 'SIGNING_KEY');
  if (!usableSigningKey(signingKey)) {
    await audit(ctx, { action: 'model.apply', workspaceId: ws, modelId: mid, outcome: 'error', details: 'refused: SIGNING_KEY is not configured' });
    throw new Error('In-place changes are disabled until the SIGNING_KEY secret is set (at least 32 characters). See the Status page. Use the clone or propose-only write mode in the meantime.');
  }
  await assertSourcesReachable(ctx, client, ws, mid, loaded.parts);
  const saved = await stage('Saving the rollback snapshot failed, the model was not changed', () => saveSnapshot(ctx, loaded.parts));
  const snapshotId = saved.snapshotId;
  const snapshotSig = signSnapshot(signingKey, { workspaceId: ws, modelId: mid, snapshotId, digest: saved.digest });
  try {
    await writeDefinition(client, ws, mid, result.parts);
  } catch (e) {
    const message = explainFabricWriteError(errorMessage(e));
    await recordChangeSet(ctx, {
      workspaceId: ws,
      modelId: mid,
      modelName: loaded.modelName,
      mode: 'in-place',
      status: 'failed',
      proposalIds,
      changeCount: 0,
      scoreBefore: scoreBefore.score,
      scoreAfter: scoreBefore.score,
      summary: `Update failed: ${message}`,
      snapshotId,
    }).catch(() => undefined);
    await audit(ctx, { action: 'model.apply', workspaceId: ws, modelId: mid, outcome: 'error', details: message });
    throw new Error(`Fabric rejected the update, the model was not changed: ${message}`);
  }

  // The model is changed from here on. Anything that fails afterwards is reported as a warning
  // instead of an error, so a model that was written is never presented as a failed apply.
  const warnings: string[] = [];
  let rereadScore = result.score;
  let verified = false;
  let resultDigest: string | undefined;
  try {
    const reread = await client.getDefinition(ws, mid);
    resultDigest = definitionDigest(reread);
    rereadScore = scoreModel(buildSnapshot(reread, { name: loaded.modelName, governance: loaded.governance }));
    verified = Math.abs(rereadScore.score - result.score.score) <= VERIFY_TOLERANCE;
  } catch (e) {
    warnings.push(`The changes were written, but reading the model back failed (${errorMessage(e)}), so the score shown is a projection.`);
  }
  let id = '';
  try {
    id = await recordChangeSet(ctx, {
      workspaceId: ws,
      modelId: mid,
      modelName: loaded.modelName,
      mode: 'in-place',
      status: 'applied',
      proposalIds,
      changeCount: result.applied.length,
      scoreBefore: scoreBefore.score,
      scoreAfter: rereadScore.score,
      summary: `Applied ${result.applied.length} changes in place${verified ? '' : ' (read-back score differs from the projection)'}.`,
      snapshotId,
      snapshotSig,
      ...(resultDigest ? { resultDigest } : {}),
    });
  } catch (e) {
    warnings.push(`The change set could not be recorded (${errorMessage(e)}), so it cannot be rolled back from the app. The rollback snapshot id is ${snapshotId}.`);
  }
  await saveAssessment(ctx, { workspaceId: ws, workspaceName: loaded.workspaceName, modelId: mid, modelName: loaded.modelName, score: rereadScore }).catch((e: unknown) => {
    console.error('saving the assessment failed', errorMessage(e));
  });
  await audit(ctx, {
    action: 'model.apply',
    workspaceId: ws,
    modelId: mid,
    outcome: verified && warnings.length === 0 ? 'ok' : 'warning',
    details: `changeSet=${id || 'none'} snapshot=${snapshotId} changes=${result.applied.length} before=${scoreBefore.score.toFixed(1)} after=${rereadScore.score.toFixed(1)}${warnings.length ? ` warnings=${warnings.join(' ')}` : ''}`,
  });
  await pruneSnapshots(ctx, mid);
  const message =
    warnings.length > 0
      ? warnings.join(' ')
      : verified
        ? 'Changes were written to the model and verified by reading it back from Fabric.'
        : 'Changes were written, but the score read back from Fabric differs from the projection. Review the model before relying on it.';
  return {
    ...base,
    changeSetId: id,
    status: 'applied',
    after: headline(rereadScore),
    verified,
    message,
    targetModelId: mid,
  };
}

/** Keeps the newest snapshots per model; older ones are removed so storage stays bounded. Best effort. */
async function pruneSnapshots(ctx: Ctx, modelId: string): Promise<void> {
  try {
    const data = ctx.getDataClient();
    const sets = await data.ChangeSet.select(['id', 'snapshot_id', 'created_at'])
      .where({ model_id: { eq: modelId }, mode: { eq: 'in-place' } })
      .first(500)
      .execute();
    const withSnapshot = sets
      .filter((s) => s.snapshot_id)
      .sort((a, b) => iso(b.created_at).localeCompare(iso(a.created_at)));
    for (const old of withSnapshot.slice(KEEP_SNAPSHOTS)) {
      const chunks = await data.SnapshotChunk.select(['id']).where({ snapshot_id: { eq: old.snapshot_id as string } }).first(500).execute();
      for (const c of chunks) await data.SnapshotChunk.delete({ id: c.id });
    }
  } catch (e) {
    console.error('snapshot pruning failed', errorMessage(e));
  }
}

export async function rollbackChangeSet(ctx: Ctx, changeSetId: string, discardLaterEdits = false): Promise<RollbackResultView> {
  const id = assertGuid(changeSetId, 'changeSetId');
  const data = ctx.getDataClient();
  const found = await data.ChangeSet.select(['id', 'workspace_id', 'model_id', 'mode', 'status', 'snapshot_id', 'snapshot_sig', 'result_digest', 'created_at'])
    .where({ id: { eq: id } })
    .first(1)
    .execute();
  const cs = found[0];
  if (!cs) throw new Error('Change set not found.');
  await requireModelWrite(ctx, cs.workspace_id, cs.model_id, 'roll back this change set');
  if (cs.mode !== 'in-place' || cs.status !== 'applied' || !cs.snapshot_id) {
    throw new Error('Only applied in-place change sets with a stored snapshot can be rolled back.');
  }
  const setting = await readSetting(ctx, cs.workspace_id);
  if (setting?.unverified) {
    throw new Error('The write mode stored for this workspace was not saved by the app, so it is ignored. An administrator must open Settings and save the workspace again.');
  }
  if (!setting || !setting.in_scope) throw new Error('This workspace is not enabled for changes.');

  const newer = await data.ChangeSet.select(['id', 'created_at'])
    .where({ model_id: { eq: cs.model_id }, status: { eq: 'applied' }, mode: { eq: 'in-place' } })
    .first(500)
    .execute();
  if (newer.some((n) => n.id !== cs.id && iso(n.created_at) > iso(cs.created_at))) {
    throw new Error('A newer change set exists for this model. Roll that one back first.');
  }

  const signingKey = config(ctx, 'SIGNING_KEY');
  if (!usableSigningKey(signingKey)) {
    await audit(ctx, { action: 'model.rollback', workspaceId: cs.workspace_id, modelId: cs.model_id, outcome: 'error', details: 'refused: SIGNING_KEY is not configured' });
    throw new Error('Rollback is disabled until the SIGNING_KEY secret is set (at least 32 characters). See the Status page.');
  }
  const stored = await stage('Reading the rollback snapshot failed', () => loadSnapshot(ctx, cs.snapshot_id as string));
  const trusted = verifySnapshot(signingKey, { workspaceId: cs.workspace_id, modelId: cs.model_id, snapshotId: cs.snapshot_id, digest: stored.digest }, cs.snapshot_sig);
  if (!trusted) {
    await audit(ctx, { action: 'model.rollback', workspaceId: cs.workspace_id, modelId: cs.model_id, outcome: 'error', details: `refused: snapshot signature check failed for changeSet=${cs.id}` });
    throw new Error('The rollback snapshot failed its integrity check (it was modified, or was saved without a valid signature). Nothing was written.');
  }
  const parts = unpackParts(stored.chunks);
  const forbidden = disallowedPartPaths(Object.keys(parts));
  if (forbidden.length > 0) {
    await audit(ctx, { action: 'model.rollback', workspaceId: cs.workspace_id, modelId: cs.model_id, outcome: 'error', details: `refused: unexpected parts ${forbidden.slice(0, 5).join(', ')}` });
    throw new Error('The rollback snapshot contains parts that are not part of a semantic model definition. Nothing was written.');
  }

  const client: FabricClient = fabricClient(ctx);
  const current = await stage('Reading the model from Fabric failed', async () => {
    const row = await readAssessmentRow(ctx, cs.model_id);
    return loadModel(client, cs.workspace_id, cs.model_id, row?.approved_for_copilot ?? null);
  });
  const scoreNow = scoreModel(snapshotOf(current));
  if (!discardLaterEdits) {
    const nowDigest = definitionDigest(current.parts);
    if (!cs.result_digest) {
      throw new Error('This change set has no fingerprint of the model as it was left after the apply, so the app cannot tell whether the model was edited since. Roll back only if you accept discarding later edits.');
    }
    if (cs.result_digest !== nowDigest) {
      throw new Error('The model was edited after this change set was applied. Restoring the snapshot would discard those later edits. Confirm that you want to discard later edits to continue.');
    }
  }
  await stage('Fabric rejected the restore, the model was not changed', () => writeDefinition(client, cs.workspace_id, cs.model_id, parts));

  // The model is restored from here on; bookkeeping problems are reported as warnings.
  const warnings: string[] = [];
  let scoreRestored = scoreNow;
  try {
    const restored = await client.getDefinition(cs.workspace_id, cs.model_id);
    scoreRestored = scoreModel(buildSnapshot(restored, { name: current.modelName, governance: current.governance }));
  } catch (e) {
    warnings.push(`The model was restored, but reading it back failed (${errorMessage(e)}).`);
  }
  try {
    await data.ChangeSet.update({ id: cs.id }, { status: 'rolled-back' });
  } catch (e) {
    warnings.push(`The change set could not be marked as rolled back (${errorMessage(e)}).`);
  }
  await saveAssessment(ctx, { workspaceId: cs.workspace_id, workspaceName: current.workspaceName, modelId: cs.model_id, modelName: current.modelName, score: scoreRestored }).catch((e: unknown) => {
    console.error('saving the assessment failed', errorMessage(e));
  });
  await audit(ctx, {
    action: 'model.rollback',
    workspaceId: cs.workspace_id,
    modelId: cs.model_id,
    outcome: warnings.length === 0 ? 'ok' : 'warning',
    details: `changeSet=${cs.id} before=${scoreNow.score.toFixed(1)} after=${scoreRestored.score.toFixed(1)}${discardLaterEdits ? ' discardLaterEdits=true' : ''}${warnings.length ? ` warnings=${warnings.join(' ')}` : ''}`,
  });
  return {
    changeSetId: cs.id,
    status: 'rolled-back',
    restoredParts: Object.keys(parts).length,
    before: headline(scoreNow),
    after: headline(scoreRestored),
    message: ['The model definition was restored from the snapshot taken before the change set was applied.', ...warnings].join(' '),
  };
}
