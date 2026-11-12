import type { DefinitionParts } from './types.js';

/** A OneLake item (usually the lakehouse) that a Direct Lake model reads from. */
export interface OneLakeSource {
  workspaceId: string;
  itemId: string;
  /** Name of the shared expression that holds the source, when it can be told. */
  expression?: string;
}

const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ONELAKE = new RegExp(`onelake\\.dfs\\.fabric\\.microsoft\\.com/(${GUID})/(${GUID})`, 'gi');
const EXPRESSION_HEADER = /^expression\s+(?:'([^']+)'|"([^"]+)"|([^\s=]+))\s*=/gm;

/**
 * Finds the OneLake workspace and item ids in the model's shared expressions. Direct Lake models
 * store their source there, and Fabric re-checks that source every time the definition is updated.
 */
export function findOneLakeSources(parts: DefinitionParts): OneLakeSource[] {
  const out = new Map<string, OneLakeSource>();
  for (const [path, text] of Object.entries(parts)) {
    if (!/\.tmdl$/i.test(path) || !/onelake\.dfs\.fabric\.microsoft\.com/i.test(text)) continue;
    const headers = [...text.matchAll(EXPRESSION_HEADER)].map((m) => ({ at: m.index ?? 0, name: m[1] ?? m[2] ?? m[3] }));
    for (const m of text.matchAll(ONELAKE)) {
      const workspaceId = m[1].toLowerCase();
      const itemId = m[2].toLowerCase();
      const at = m.index ?? 0;
      const expression = [...headers].reverse().find((h) => h.at <= at)?.name;
      const key = `${workspaceId}/${itemId}`;
      if (!out.has(key)) out.set(key, { workspaceId, itemId, ...(expression ? { expression } : {}) });
    }
  }
  return [...out.values()];
}
