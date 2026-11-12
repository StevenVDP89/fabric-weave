import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BusinessContext, DefinitionParts, ScoreResult } from '@rayfin-app/engine';
import type { WriteMode } from '@rayfin-app/shared';
import { actorOf, config, errorMessage, type Ctx } from './runtime.js';
import { digestChunks, usableSigningKey, verifySetting } from './integrity.js';

const CHUNK_SIZE = 3800;
export const MAX_SNAPSHOT_CHUNKS = 400;

// ---------------------------------------------------------------------------
// Workspace settings
// ---------------------------------------------------------------------------

export interface StoredSetting {
  /** The mode that is in force. A row without a valid signature never grants more than propose-only. */
  write_mode: WriteMode;
  in_scope: boolean;
  workspace_name: string;
  /** True when the row asks for more than propose-only but was not signed by this app, so it was ignored. */
  unverified: boolean;
}

interface SettingRow {
  workspace_id: string;
  workspace_name: string;
  write_mode: WriteMode;
  in_scope: boolean;
  sig?: string | null;
}

const SETTING_FIELDS = ['workspace_id', 'workspace_name', 'write_mode', 'in_scope', 'sig'] as const;

/** Applies the signature rule: only a row this app signed can unlock writes to a model. */
export function resolveSetting(ctx: Ctx, row: SettingRow): StoredSetting {
  const key = config(ctx, 'SIGNING_KEY');
  const signed =
    usableSigningKey(key) && verifySetting(key, { workspaceId: row.workspace_id, writeMode: row.write_mode, inScope: row.in_scope }, row.sig);
  if (signed || row.write_mode === 'propose-only') {
    return { write_mode: row.write_mode, in_scope: row.in_scope, workspace_name: row.workspace_name, unverified: false };
  }
  return { write_mode: 'propose-only', in_scope: row.in_scope, workspace_name: row.workspace_name, unverified: true };
}

// The data client returns only `id` unless fields are selected. `findFirst(filter)` and `findById`
// therefore yield id-only rows, so every read that needs column values selects them explicitly.
export async function readSetting(ctx: Ctx, workspaceId: string): Promise<StoredSetting | undefined> {
  const rows = await ctx
    .getDataClient()
    .WorkspaceSetting.select([...SETTING_FIELDS])
    .where({ workspace_id: { eq: workspaceId } })
    .first(1)
    .execute();
  const row = rows[0];
  return row ? resolveSetting(ctx, row) : undefined;
}

export async function readSettings(ctx: Ctx): Promise<Map<string, StoredSetting>> {
  const rows = await ctx
    .getDataClient()
    .WorkspaceSetting.select([...SETTING_FIELDS])
    .first(2000)
    .execute();
  return new Map(rows.map((r) => [r.workspace_id, resolveSetting(ctx, r)]));
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

export function headlineScore10(score: number): number {
  return Math.round(score * 10);
}

export async function saveAssessment(
  ctx: Ctx,
  input: { workspaceId: string; workspaceName: string; modelId: string; modelName: string; score: ScoreResult; approved?: boolean | null },
): Promise<void> {
  const s = input.score;
  const topFindings = s.findings
    .slice(0, 12)
    .map((f) => ({ r: f.ruleId, p: f.objectPath.slice(0, 80), m: f.message.slice(0, 90) }));
  let top = JSON.stringify(topFindings);
  while (top.length > 3400 && topFindings.length > 1) {
    topFindings.pop();
    top = JSON.stringify(topFindings);
  }
  const record = {
    workspace_id: input.workspaceId,
    workspace_name: input.workspaceName.slice(0, 200),
    model_id: input.modelId,
    model_name: input.modelName.slice(0, 200),
    score10: headlineScore10(s.score),
    tier: s.tier,
    mode: s.mode,
    categories_json: JSON.stringify(s.categories.map((c) => ({ id: c.id, score: Math.round(c.score * 10) / 10 }))).slice(0, 1400),
    findings_count: s.findings.length,
    top_findings_json: top,
    stats_json: JSON.stringify(s.stats).slice(0, 560),
    catalog_version: s.catalogVersion,
    assessed_at: new Date(),
    assessed_by: actorOf(ctx),
    ...(typeof input.approved === 'boolean' ? { approved_for_copilot: input.approved } : {}),
  };
  const data = ctx.getDataClient();
  const existing = await readAssessmentRow(ctx, input.modelId);
  if (existing) await data.ModelAssessment.update({ id: existing.id }, record);
  else await data.ModelAssessment.create(record);
}

export async function readAssessmentRow(ctx: Ctx, modelId: string) {
  const rows = await ctx
    .getDataClient()
    .ModelAssessment.select(['id', 'model_id', 'model_name', 'approved_for_copilot'])
    .where({ model_id: { eq: modelId } })
    .first(1)
    .execute();
  return rows[0];
}

// ---------------------------------------------------------------------------
// Business context
// ---------------------------------------------------------------------------

export async function readBusinessContext(ctx: Ctx, modelId: string): Promise<BusinessContext | undefined> {
  const rows = await ctx
    .getDataClient()
    .BusinessContext.select(['domain', 'audience', 'description', 'glossary_json', 'default_time_frame', 'fiscal_year_start', 'preferred_measures', 'notes', 'context_text'])
    .where({ model_id: { eq: modelId } })
    .first(1)
    .execute();
  const r = rows[0];
  if (!r) return undefined;
  // The free text is the context. Older structured columns only apply to entries saved before it existed.
  const text = r.context_text?.trim();
  if (text) return { description: text };
  let glossary: BusinessContext['glossary'];
  if (r.glossary_json) {
    try {
      const parsed: unknown = JSON.parse(r.glossary_json);
      if (Array.isArray(parsed)) {
        glossary = parsed
          .filter((g): g is { term: string; meaning: string } => !!g && typeof g.term === 'string' && typeof g.meaning === 'string')
          .slice(0, 20);
      }
    } catch {
      glossary = undefined;
    }
  }
  return {
    domain: r.domain ?? undefined,
    audience: r.audience ?? undefined,
    glossary,
    defaultTimeFrame: r.default_time_frame ?? undefined,
    fiscalYearStart: r.fiscal_year_start ?? undefined,
    preferredMeasures: r.preferred_measures ? r.preferred_measures.split('|').map((x) => x.trim()).filter(Boolean) : undefined,
    notes: [r.description, r.notes].filter(Boolean).join('\n') || undefined,
  };
}

// ---------------------------------------------------------------------------
// Rollback snapshots
// ---------------------------------------------------------------------------

export function packParts(parts: DefinitionParts): string[] {
  const packed = gzipSync(Buffer.from(JSON.stringify(parts), 'utf8')).toString('base64');
  const chunks: string[] = [];
  for (let i = 0; i < packed.length; i += CHUNK_SIZE) chunks.push(packed.slice(i, i + CHUNK_SIZE));
  return chunks;
}

export function unpackParts(chunks: string[]): DefinitionParts {
  const json = gunzipSync(Buffer.from(chunks.join(''), 'base64')).toString('utf8');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Snapshot is corrupt.');
  const out: DefinitionParts = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error('Snapshot is corrupt.');
    out[k] = v;
  }
  return out;
}

export interface SavedSnapshot {
  snapshotId: string;
  digest: string;
}

export async function saveSnapshot(ctx: Ctx, parts: DefinitionParts): Promise<SavedSnapshot> {
  const chunks = packParts(parts);
  if (chunks.length > MAX_SNAPSHOT_CHUNKS) {
    throw new Error('This model is too large to snapshot for rollback. Use the clone or propose-only write mode for it.');
  }
  const snapshotId = randomUUID();
  const data = ctx.getDataClient();
  for (let i = 0; i < chunks.length; i += 10) {
    await Promise.all(
      chunks.slice(i, i + 10).map((chunk, j) => data.SnapshotChunk.create({ snapshot_id: snapshotId, seq: i + j, data: chunk })),
    );
  }
  return { snapshotId, digest: digestChunks(chunks) };
}

export interface LoadedSnapshot {
  /** Still packed: verify the signature over `digest` before unpacking. */
  chunks: string[];
  digest: string;
}

export async function loadSnapshot(ctx: Ctx, snapshotId: string): Promise<LoadedSnapshot> {
  const rows = await ctx
    .getDataClient()
    .SnapshotChunk.select(['seq', 'data'])
    .where({ snapshot_id: { eq: snapshotId } })
    .orderBy({ seq: 'asc' })
    .first(MAX_SNAPSHOT_CHUNKS + 10)
    .execute();
  if (rows.length === 0) throw new Error('The rollback snapshot for this change set is no longer available.');
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  sorted.forEach((r, i) => {
    if (r.seq !== i) throw new Error('The rollback snapshot is incomplete.');
  });
  const chunks = sorted.map((r) => r.data);
  return { digest: digestChunks(chunks), chunks };
}

// ---------------------------------------------------------------------------
// Audit trail (never blocks the caller)
// ---------------------------------------------------------------------------

export async function audit(
  ctx: Ctx,
  entry: { action: string; workspaceId?: string; modelId?: string; details?: string; outcome?: 'ok' | 'warning' | 'error' },
): Promise<void> {
  try {
    await ctx.getDataClient().AuditLog.create({
      at: new Date(),
      actor: actorOf(ctx),
      action: entry.action.slice(0, 60),
      ...(entry.workspaceId ? { workspace_id: entry.workspaceId } : {}),
      ...(entry.modelId ? { model_id: entry.modelId } : {}),
      ...(entry.details ? { details: entry.details.slice(0, 1800) } : {}),
      outcome: entry.outcome ?? 'ok',
    });
  } catch (e) {
    console.error('audit write failed', errorMessage(e));
  }
}
