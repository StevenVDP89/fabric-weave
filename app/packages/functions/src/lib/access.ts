import { config, type Ctx } from './runtime.js';

/**
 * Who the caller is, and who the app administrators are.
 *
 * Everyone who can sign in is checked against Fabric itself (see permissions.ts): they see the
 * workspaces and models they can reach and can change only the ones Fabric lets them write to.
 * The people listed in the APP_ADMINS secret are the exception: they see and change everything the
 * app can reach, which suits a central team that looks after the whole estate.
 */

/** Claims that identify a person. The display name is deliberately absent: it is free text. */
const IDENTITY_CLAIMS = ['preferred_username', 'upn', 'email', 'unique_name', 'oid', 'sub'] as const;

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUID_ONLY = new RegExp(`^${GUID}$`, 'i');
/** Rayfin identifies a person with a path such as /eid1/c/pub/t/<tenant>/a/<app>/workspaces/<id>/projects/<id>/users/<object id>. */
const USER_PATH = new RegExp(`/users/(${GUID})/?$`, 'i');

export function claimsOf(ctx: Ctx): Record<string, unknown> {
  try {
    const payload = ctx.accessToken.split('.')[1];
    if (payload) return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    // An unreadable token identifies nobody.
  }
  return {};
}

/**
 * The caller's Microsoft Entra object id: the `oid` claim, or the object id at the end of Rayfin's
 * path-style subject. A plain `sub` is not used, because in Entra tokens it is not the object id.
 */
export function objectIdOf(ctx: Ctx): string | undefined {
  const claims = claimsOf(ctx);
  if (typeof claims.oid === 'string' && GUID_ONLY.test(claims.oid.trim())) return claims.oid.trim().toLowerCase();
  if (typeof claims.sub === 'string') {
    const m = USER_PATH.exec(claims.sub.trim());
    if (m?.[1]) return m[1].toLowerCase();
  }
  return undefined;
}

/** What to ask Fabric about the caller: the object id when there is one, otherwise the sign-in name. */
export function userRefOf(ctx: Ctx): string | undefined {
  const id = objectIdOf(ctx);
  if (id) return id;
  const claims = claimsOf(ctx);
  for (const key of ['preferred_username', 'upn', 'email', 'unique_name'] as const) {
    const v = claims[key];
    if (typeof v === 'string' && /^[^\s@/]+@[^\s@/]+$/.test(v.trim())) return v.trim().toLowerCase().slice(0, 200);
  }
  return undefined;
}

/** Every value the caller can be matched on, lower-cased. */
export function identitiesOf(ctx: Ctx): string[] {
  const claims = claimsOf(ctx);
  const out = new Set<string>();
  for (const key of IDENTITY_CLAIMS) {
    const v = claims[key];
    if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase().slice(0, 200));
  }
  const id = objectIdOf(ctx);
  if (id) out.add(id);
  return [...out];
}

export function parseAdmins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

export function adminsConfigured(ctx: Ctx): boolean {
  return parseAdmins(config(ctx, 'APP_ADMINS')).length > 0;
}

export function isAdmin(ctx: Ctx): boolean {
  const admins = new Set(parseAdmins(config(ctx, 'APP_ADMINS')));
  if (admins.size === 0) return false;
  return identitiesOf(ctx).some((id) => admins.has(id));
}
