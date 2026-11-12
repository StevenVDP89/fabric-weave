import type { ChangeSetRecord } from '@rayfin-app/shared';

import { CONTEXT_TEXT_MAX, composeContextText } from './context';
import { getRayfinClient } from './rayfin-client';

export interface StoredContext {
  id: string;
  /** The context description. For entries saved as structured fields it is composed from them. */
  text: string;
  /** True when the text was composed from structured fields and has not been saved in this form yet. */
  legacy: boolean;
}

export async function loadBusinessContext(modelId: string): Promise<StoredContext | null> {
  const client = await getRayfinClient();
  // Only `id` comes back unless fields are selected, so list the columns that are needed.
  const rows = await client.data.BusinessContext.select(['id', 'context_text', 'domain', 'audience', 'description', 'glossary_json', 'default_time_frame', 'fiscal_year_start', 'preferred_measures', 'notes'])
    .where({ model_id: { eq: modelId } })
    .first(1)
    .execute();
  const row = rows[0];
  if (!row) return null;
  if (row.context_text?.trim()) return { id: row.id, text: row.context_text, legacy: false };
  const text = composeContextText({
    description: row.description,
    domain: row.domain,
    audience: row.audience,
    defaultTimeFrame: row.default_time_frame,
    fiscalYearStart: row.fiscal_year_start,
    preferredMeasures: (row.preferred_measures ?? '').split('|'),
    glossary: parseGlossary(row.glossary_json),
    notes: row.notes,
  });
  return { id: row.id, text, legacy: text.length > 0 };
}

function parseGlossary(raw: string | undefined | null): { term: string; meaning: string }[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is { term: string; meaning: string } =>
        typeof x === 'object' && x !== null && typeof (x as { term?: unknown }).term === 'string' && typeof (x as { meaning?: unknown }).meaning === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Upsert keyed by model_id (unique). The text is the whole context: saving it makes the server ignore older structured columns.
 * Saving nothing removes the record, because an update cannot reliably clear a column.
 * Returns the record id, or null when the record was removed.
 */
export async function saveBusinessContext(workspaceId: string, modelId: string, existingId: string | null, text: string, actor: string): Promise<string | null> {
  const client = await getRayfinClient();
  const value = text.trim().slice(0, CONTEXT_TEXT_MAX);
  if (!value) {
    if (existingId) await client.data.BusinessContext.delete({ id: existingId });
    return null;
  }
  const values = { workspace_id: workspaceId, model_id: modelId, context_text: value, updated_at: new Date(), updated_by: actor.slice(0, 200) };
  if (existingId) {
    await client.data.BusinessContext.update({ id: existingId }, values);
    return existingId;
  }
  const created = await client.data.BusinessContext.create(values);
  return created.id;
}

export type ChangeSetItem = Pick<
  ChangeSetRecord,
  'id' | 'mode' | 'status' | 'change_count' | 'score_before10' | 'score_after10' | 'summary' | 'created_at' | 'created_by' | 'target_model_id' | 'snapshot_id'
>;

export async function loadChangeSets(modelId: string): Promise<ChangeSetItem[]> {
  const client = await getRayfinClient();
  const rows = await client.data.ChangeSet.select(['id', 'mode', 'status', 'change_count', 'score_before10', 'score_after10', 'summary', 'created_at', 'created_by', 'target_model_id', 'snapshot_id'])
    .where({ model_id: { eq: modelId } })
    .orderBy({ created_at: 'desc' })
    .first(25)
    .execute();
  return rows as ChangeSetItem[];
}
