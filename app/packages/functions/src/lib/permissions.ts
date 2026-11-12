import { FabricApiError, type FabricClient } from '@rayfin-app/engine';
import { isAdmin, userRefOf } from './access.js';
import { actorOf, errorMessage, fabricClient, type Ctx } from './runtime.js';
import { audit } from './store.js';

/**
 * Per-person access. Rayfin gives the functions the identity of the app owner, not of the person
 * using the app, so Fabric cannot enforce a person's own permissions on these calls. The app
 * therefore asks Fabric what the signed-in person may do, and refuses anything beyond that before
 * it makes a call as the owner:
 *
 *  - fabric-admin-api: the owner is a Fabric administrator. Fabric reports every model the person
 *    can reach and whether they may write to it, with group membership and sharing already resolved.
 *  - workspace-roles: the owner is not a Fabric administrator. The person's role is read from each
 *    workspace's role assignments. Roles given through a group cannot be resolved, so those people
 *    see nothing until the owner is made a Fabric administrator.
 *
 * Anything that cannot be confirmed is refused. App administrators (APP_ADMINS) skip these checks.
 */

export type AccessSource = 'everything' | 'fabric-admin-api' | 'workspace-roles' | 'unresolved';

export interface Grants {
  source: AccessSource;
  /** Models the person can reach (fabric-admin-api). */
  models: Map<string, { workspaceId: string; write: boolean }>;
  /** Roles the person holds directly in workspaces (workspace-roles), lower-cased workspace id to role. */
  roles: Map<string, string>;
  note: string | null;
}

const GRANTS_TTL_MS = 5 * 60_000;
const GRANTS_STALE_MS = 60 * 60_000;
/** A forced refresh is ignored when the last one is newer than this, so a refused person cannot exhaust Fabric's admin API quota. */
const GRANTS_MIN_REFRESH_MS = 30_000;
const WORKSPACE_CAP = 300;
const WRITE_ROLES = new Set(['admin', 'member', 'contributor']);

const EVERYTHING: Grants = { source: 'everything', models: new Map(), roles: new Map(), note: null };

const grantCache = new Map<string, { at: number; grants: Grants }>();
const roleCache = new Map<string, { at: number; role: string | null }>();
let tenantIndex: { at: number; byId: Map<string, string> } | undefined;

/** Forgets what was learned about people's access. Used after the app creates a model, and by tests. */
export function forgetAccess(): void {
  grantCache.clear();
  roleCache.clear();
  tenantIndex = undefined;
}

const unresolved = (note: string): Grants => ({ source: 'unresolved', models: new Map(), roles: new Map(), note });

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

/** The Fabric admin API refused the app owner, which means the owner is not a Fabric administrator. */
function adminApiRefused(e: unknown): boolean {
  return e instanceof FabricApiError && [400, 401, 403, 404].includes(e.status);
}

async function tenantModelIndex(client: FabricClient): Promise<Map<string, string>> {
  if (tenantIndex && Date.now() - tenantIndex.at < GRANTS_TTL_MS) return tenantIndex.byId;
  const byId = new Map((await client.listTenantModels()).map((m) => [m.id, m.workspaceId] as const));
  tenantIndex = { at: Date.now(), byId };
  return byId;
}

function holds(a: { principalId: string; principalType: string; userPrincipalName?: string }, ref: string): boolean {
  return a.principalType.toLowerCase() === 'user' && (a.principalId === ref || a.userPrincipalName === ref);
}

/** The role the person holds directly in one workspace, or null. */
async function directRole(client: FabricClient, workspaceId: string, ref: string): Promise<string | null> {
  const mine = (await client.listWorkspaceRoleAssignments(workspaceId)).find((a) => holds(a, ref));
  return mine?.role ?? null;
}

async function cachedDirectRole(client: FabricClient, workspaceId: string, ref: string): Promise<string | null> {
  const key = `${ref}|${workspaceId}`;
  const hit = roleCache.get(key);
  if (hit && Date.now() - hit.at < GRANTS_TTL_MS) return hit.role;
  const role = await directRole(client, workspaceId, ref).catch(() => null);
  roleCache.set(key, { at: Date.now(), role });
  return role;
}

async function roleGrants(client: FabricClient, ref: string): Promise<Grants> {
  const all = (await client.listWorkspaces()).filter((w) => !w.type || w.type === 'Workspace').slice(0, WORKSPACE_CAP);
  const roles = new Map<string, string>();
  let unreadable = 0;
  let viaGroups = 0;
  await mapLimit(all, 8, async (w) => {
    try {
      const assignments = await client.listWorkspaceRoleAssignments(w.id);
      const mine = assignments.find((a) => holds(a, ref));
      if (mine) roles.set(w.id.toLowerCase(), mine.role);
      else if (assignments.some((a) => a.principalType.toLowerCase() === 'group')) viaGroups += 1;
    } catch {
      unreadable += 1;
    }
  });
  const notes = ['Your access is read from workspace role assignments, because the app owner is not a Fabric administrator.'];
  if (viaGroups > 0) notes.push(`${viaGroups} workspace${viaGroups === 1 ? '' : 's'} grant access through groups, which the app cannot resolve. Ask a Fabric administrator to make the app owner a Fabric administrator, or to add you to the workspace directly.`);
  if (unreadable > 0) notes.push(`${unreadable} workspace${unreadable === 1 ? '' : 's'} could not be checked.`);
  return { source: 'workspace-roles', models: new Map(), roles, note: notes.join(' ') };
}

async function computeGrants(ctx: Ctx, ref: string): Promise<Grants> {
  const client = fabricClient(ctx);
  try {
    const [access, index] = await Promise.all([client.listUserModelAccess(ref), tenantModelIndex(client)]);
    const models = new Map<string, { workspaceId: string; write: boolean }>();
    for (const a of access) {
      const workspaceId = index.get(a.id);
      if (!workspaceId || a.permissions.length === 0) continue;
      models.set(a.id, { workspaceId, write: a.permissions.includes('write') });
    }
    return { source: 'fabric-admin-api', models, roles: new Map(), note: null };
  } catch (e) {
    if (!adminApiRefused(e)) throw e;
  }
  return roleGrants(client, ref);
}

/** What the caller can reach. Remembered for a few minutes per person. Never throws: an unknown answer is "nothing". */
export async function grantsOf(ctx: Ctx, fresh = false): Promise<Grants> {
  if (isAdmin(ctx)) return EVERYTHING;
  const ref = userRefOf(ctx);
  if (!ref) return unresolved('The app could not tell who you are from your sign-in, so it cannot check what you may see or change.');
  const hit = grantCache.get(ref);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (age < GRANTS_TTL_MS || (fresh && age < GRANTS_MIN_REFRESH_MS))) return hit.grants;
  try {
    const grants = await computeGrants(ctx, ref);
    grantCache.set(ref, { at: Date.now(), grants });
    return grants;
  } catch (e) {
    if (hit && age < GRANTS_STALE_MS) return hit.grants;
    return unresolved(`Your access could not be checked right now: ${errorMessage(e)}`);
  }
}

export function canSeeWorkspace(g: Grants, workspaceId: string): boolean {
  if (g.source === 'everything') return true;
  const ws = workspaceId.toLowerCase();
  if (g.roles.has(ws)) return true;
  for (const m of g.models.values()) if (m.workspaceId === ws) return true;
  return false;
}

export function canRead(g: Grants, workspaceId: string, modelId: string): boolean {
  if (g.source === 'everything') return true;
  const m = g.models.get(modelId.toLowerCase());
  if (m) return m.workspaceId === workspaceId.toLowerCase();
  return g.roles.has(workspaceId.toLowerCase());
}

export function canWrite(g: Grants, workspaceId: string, modelId: string): boolean {
  if (g.source === 'everything') return true;
  const m = g.models.get(modelId.toLowerCase());
  if (m) return m.workspaceId === workspaceId.toLowerCase() && m.write;
  return WRITE_ROLES.has((g.roles.get(workspaceId.toLowerCase()) ?? '').toLowerCase());
}

export function accessCounts(g: Grants): { workspaces: number | null; models: number | null } {
  if (g.source === 'everything') return { workspaces: null, models: null };
  const workspaces = new Set<string>(g.roles.keys());
  for (const m of g.models.values()) workspaces.add(m.workspaceId);
  return { workspaces: workspaces.size, models: g.source === 'fabric-admin-api' ? g.models.size : null };
}

/** The workspaces among `ids` whose write mode the caller may change: app administrators, and workspace Admins. */
export async function editableWorkspaces(ctx: Ctx, g: Grants, ids: string[]): Promise<Set<string>> {
  if (g.source === 'everything') return new Set(ids);
  if (g.source === 'workspace-roles') return new Set(ids.filter((id) => (g.roles.get(id.toLowerCase()) ?? '').toLowerCase() === 'admin'));
  const ref = userRefOf(ctx);
  if (!ref || g.source !== 'fabric-admin-api') return new Set();
  const client = fabricClient(ctx);
  const mine = ids.filter((id) => canSeeWorkspace(g, id)).slice(0, 100);
  const roles = await mapLimit(mine, 6, (id) => cachedDirectRole(client, id, ref));
  return new Set(mine.filter((_, i) => (roles[i] ?? '').toLowerCase() === 'admin'));
}

async function deny(ctx: Ctx, action: string, workspaceId: string | undefined, modelId: string | undefined, reason: string): Promise<never> {
  await audit(ctx, { action: 'access.denied', ...(workspaceId ? { workspaceId } : {}), ...(modelId ? { modelId } : {}), details: `${action} by ${actorOf(ctx)}: ${reason}`, outcome: 'error' });
  throw new Error(reason);
}

const WHO = (ctx: Ctx) => `You are signed in as ${actorOf(ctx)}.`;

/** Throws unless the caller can see the model in Fabric. Cached, with one forced refresh before refusing. */
export async function requireModelRead(ctx: Ctx, workspaceId: string, modelId: string): Promise<Grants> {
  let g = await grantsOf(ctx);
  if (!canRead(g, workspaceId, modelId)) g = await grantsOf(ctx, true);
  if (canRead(g, workspaceId, modelId)) return g;
  return deny(
    ctx,
    'read a model',
    workspaceId,
    modelId,
    g.source === 'unresolved' ? (g.note as string) : `You do not have access to this model in Fabric, so the app will not show it. ${WHO(ctx)}`,
  );
}

/** Throws unless the caller can see the workspace in Fabric. */
export async function requireWorkspaceRead(ctx: Ctx, workspaceId: string): Promise<Grants> {
  let g = await grantsOf(ctx);
  if (!canSeeWorkspace(g, workspaceId)) g = await grantsOf(ctx, true);
  if (canSeeWorkspace(g, workspaceId)) return g;
  return deny(
    ctx,
    'read a workspace',
    workspaceId,
    undefined,
    g.source === 'unresolved' ? (g.note as string) : `You do not have access to this workspace in Fabric, so the app will not show it. ${WHO(ctx)}`,
  );
}

/**
 * Throws unless Fabric says the caller may write to the model. Never answered from memory, because
 * access can be withdrawn at any moment. Refusals are audited.
 */
export async function requireModelWrite(ctx: Ctx, workspaceId: string, modelId: string, action: string): Promise<void> {
  if (isAdmin(ctx)) return;
  const ws = workspaceId.toLowerCase();
  const mid = modelId.toLowerCase();
  const ref = userRefOf(ctx);
  if (!ref) return deny(ctx, action, ws, mid, `The app could not tell who you are from your sign-in, so it cannot confirm you may ${action}.`);
  const client = fabricClient(ctx);
  try {
    const mine = (await client.listUserModelAccess(ref)).find((a) => a.id === mid);
    if (mine?.permissions.includes('write')) return;
    return deny(ctx, action, ws, mid, `You do not have write access to this model in Fabric, so you cannot ${action}. ${WHO(ctx)} Ask the model owner for the Contributor role, or for write access to the model.`);
  } catch (e) {
    if (!adminApiRefused(e)) return deny(ctx, action, ws, mid, `Your access to this model could not be checked, so nothing was changed: ${errorMessage(e)}`);
  }
  try {
    const role = await directRole(client, ws, ref);
    if (role && WRITE_ROLES.has(role.toLowerCase())) return;
    return deny(ctx, action, ws, mid, `You do not hold the Contributor, Member or Admin role in this workspace, so you cannot ${action}. ${WHO(ctx)} Roles given through a group cannot be checked by the app: ask for a direct role, or ask an app administrator.`);
  } catch (e) {
    return deny(ctx, action, ws, mid, `Your access to this workspace could not be checked, so nothing was changed: ${errorMessage(e)}`);
  }
}

/** Throws unless the caller holds the Admin role in the workspace, directly. App administrators always pass. */
export async function requireWorkspaceAdmin(ctx: Ctx, workspaceId: string, action: string): Promise<void> {
  if (isAdmin(ctx)) return;
  const ws = workspaceId.toLowerCase();
  const ref = userRefOf(ctx);
  if (!ref) return deny(ctx, action, ws, undefined, `The app could not tell who you are from your sign-in, so it cannot confirm you may ${action}.`);
  let role: string | null;
  try {
    role = await directRole(fabricClient(ctx), ws, ref);
  } catch (e) {
    return deny(ctx, action, ws, undefined, `Your role in this workspace could not be checked, so nothing was changed: ${errorMessage(e)}`);
  }
  if ((role ?? '').toLowerCase() === 'admin') return;
  return deny(ctx, action, ws, undefined, `Only a workspace Admin can ${action}. ${WHO(ctx)} Ask a workspace Admin or an app administrator. A role given through a group cannot be checked by the app.`);
}
