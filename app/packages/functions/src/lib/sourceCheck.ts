import { FabricApiError, findOneLakeSources, type DefinitionParts, type FabricClient } from '@rayfin-app/engine';

const MAX_SOURCES = 10;

/**
 * Direct Lake models point at a lakehouse. Fabric checks that lakehouse on every definition update
 * and rejects the write when it is gone or the caller cannot see it, however harmless the change is.
 * Looking first lets the app say so before anything is written. Returns one sentence per problem;
 * empty means no problem was found. Errors other than "not found" and "no access" are ignored,
 * because a flaky call must not block a change that would have worked.
 */
export async function unreachableSources(client: Pick<FabricClient, 'getItem'>, parts: DefinitionParts): Promise<string[]> {
  const sources = findOneLakeSources(parts).slice(0, MAX_SOURCES);
  const problems: string[] = [];
  for (const s of sources) {
    try {
      await client.getItem(s.workspaceId, s.itemId);
    } catch (e) {
      if (e instanceof FabricApiError && (e.status === 404 || e.status === 403)) {
        problems.push(sourceProblem(s.itemId, s.workspaceId, s.expression));
      }
    }
  }
  return problems;
}

export function sourceProblem(itemId: string, workspaceId?: string, expression?: string): string {
  const where = workspaceId ? ` in workspace ${workspaceId}` : '';
  const name = expression ? `"${expression}" ` : '';
  return `The data source ${name}points to the lakehouse ${itemId}${where}, which does not exist or which this app cannot access.`;
}

export const SOURCE_FIX_HINT =
  'Fabric checks the source on every update, so this model cannot be changed until it points to a lakehouse that exists and that the app can read. ' +
  'Fix it in Fabric (open the model, Edit tables, and pick an existing lakehouse), or give the app access to that lakehouse. ' +
  'Until then use the propose-only write mode, which needs no write access to the model.';

/** Turns the raw "artifact not found" text of a rejected update into advice the user can act on. */
export function explainFabricWriteError(message: string): string {
  const m = /Fabric artifact '([0-9a-fA-F-]{36})' is not found, or you do not have permission/i.exec(message);
  if (!m) return message;
  return `${sourceProblem(m[1].toLowerCase())} ${SOURCE_FIX_HINT}`;
}
