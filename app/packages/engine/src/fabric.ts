import { decodeDefinition, encodeDefinition } from './snapshot.js';
import type { DefinitionParts } from './types.js';

export type TokenProvider = (audience: 'fabric' | 'powerbi') => Promise<string>;

export interface FabricClientOptions {
  getToken: TokenProvider;
  fetchImpl?: typeof fetch;
  fabricBase?: string;
  powerBiBase?: string;
  /** Max time to wait for a long running operation, in ms. */
  lroTimeoutMs?: number;
  /** First wait between polls of a long running operation, in ms. It grows to at most 2 s, and never past Fabric's Retry-After hint. */
  lroPollMs?: number;
}

export interface WorkspaceInfo {
  id: string;
  displayName: string;
  capacityId?: string;
  type?: string;
}

export interface CapacityInfo {
  id: string;
  displayName: string;
  sku: string;
  region?: string;
  state?: string;
}

export interface TenantSetting {
  settingName: string;
  title: string;
  enabled: boolean;
  delegateToWorkspace?: boolean;
  enabledSecurityGroups?: { graphId: string; name: string }[];
}

export interface SemanticModelItem {
  id: string;
  displayName: string;
  workspaceId: string;
  description?: string;
}

/** One semantic model a person can reach, with what Fabric says they may do. Permissions are lower-case. */
export interface UserModelAccess {
  id: string;
  displayName: string;
  permissions: string[];
}

export interface TenantModel {
  id: string;
  name: string;
  workspaceId: string;
}

export interface RoleAssignment {
  principalId: string;
  principalType: string;
  userPrincipalName?: string;
  role: string;
}

export class FabricApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`Fabric API ${status} for ${url}: ${body.slice(0, 500)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thin Fabric / Power BI REST client. The token provider is injected so it works in Functions, CLI and tests. */
export class FabricClient {
  private readonly f: typeof fetch;
  private readonly fabric: string;
  private readonly pbi: string;
  private readonly lroTimeout: number;
  private readonly lroPollMs: number;

  constructor(private readonly opts: FabricClientOptions) {
    this.f = opts.fetchImpl ?? fetch;
    this.fabric = opts.fabricBase ?? 'https://api.fabric.microsoft.com/v1';
    this.pbi = opts.powerBiBase ?? 'https://api.powerbi.com/v1.0/myorg';
    this.lroTimeout = opts.lroTimeoutMs ?? 180_000;
    this.lroPollMs = opts.lroPollMs ?? 1000;
  }

  private async request(
    audience: 'fabric' | 'powerbi',
    method: string,
    url: string,
    body?: unknown,
    retries = 4,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.opts.getToken(audience)}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok && res.status !== 202) throw new FabricApiError(res.status, await res.text(), url);
      return res;
    }
  }

  private async json<T>(audience: 'fabric' | 'powerbi', method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.request(audience, method, url, body);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Follow a 202 long running operation and return the final result body.
   * `requireResult` is for operations whose result is the point (a definition export): a missing
   * Location header or a result that cannot be fetched is then an error instead of an empty body.
   */
  private async lro<T>(res: Response, requireResult = false): Promise<T> {
    if (res.status !== 202) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    const location = res.headers.get('location');
    if (!location) {
      if (requireResult) throw new Error('Fabric accepted the request but did not say where to fetch the result.');
      return {} as T;
    }
    const start = Date.now();
    // Fabric's Retry-After for these operations is a worst-case hint (20 s), while a definition export usually
    // finishes in a few seconds. Polling the operation is cheap, so start short and back off, never past the hint.
    let backoff = this.lroPollMs;
    let hint = Math.max(1, Number(res.headers.get('retry-after')) || 2);
    for (;;) {
      await sleep(Math.min(backoff, hint * 1000));
      backoff = Math.min(backoff * 1.5, 2_000);
      if (Date.now() - start > this.lroTimeout) throw new Error(`Long running operation timed out: ${location}`);
      const poll = await this.request('fabric', 'GET', location);
      const state = (await poll.json()) as { status?: string; error?: { message?: string; errorCode?: string } };
      if (state.status === 'Succeeded') {
        const resultUrl = poll.headers.get('location') ?? `${location}/result`;
        const target = resultUrl.includes('/result') ? resultUrl : `${location}/result`;
        const result = requireResult ? await this.request('fabric', 'GET', target) : await this.request('fabric', 'GET', target).catch(() => undefined);
        if (!result) return state as unknown as T;
        const text = await result.text();
        return (text ? JSON.parse(text) : state) as T;
      }
      if (state.status === 'Failed' || state.status === 'Cancelled') {
        throw new Error(`Operation ${state.status}: ${state.error?.errorCode ?? ''} ${state.error?.message ?? ''}`.trim());
      }
      hint = Math.max(1, Number(poll.headers.get('retry-after')) || 2);
    }
  }

  private async list<T>(url: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = url;
    while (next) {
      const page: { value?: T[]; continuationUri?: string } = await this.json('fabric', 'GET', next);
      out.push(...(page.value ?? []));
      next = page.continuationUri;
    }
    return out;
  }

  /** Pages of an admin list. The next-page link is followed only when it stays on the Fabric API host. */
  private async adminPages<T>(url: string, key: string): Promise<T[]> {
    const origin = new URL(this.fabric).origin;
    const out: T[] = [];
    let next: string | undefined = url;
    for (let page = 0; next && page < 100; page++) {
      const body: Record<string, unknown> = await this.json('fabric', 'GET', next);
      out.push(...((body[key] as T[] | undefined) ?? []));
      const link = body.continuationUri;
      next = typeof link === 'string' && link.startsWith(`${origin}/`) ? link : undefined;
    }
    return out;
  }

  // ---- Who may do what ------------------------------------------------------

  /**
   * The semantic models one person can reach and what they may do with them. Fabric works this out,
   * group membership included. Fabric admin API: the calling identity must be a Fabric administrator.
   * `userRef` is the person's Entra object id or user principal name.
   */
  async listUserModelAccess(userRef: string): Promise<UserModelAccess[]> {
    const rows = await this.adminPages<{ id?: string; displayName?: string; itemAccessDetails?: { type?: string; permissions?: string[] } }>(
      `${this.fabric}/admin/users/${encodeURIComponent(userRef)}/access?type=SemanticModel`,
      'accessEntities',
    );
    return rows
      .filter((r) => r.id && (!r.itemAccessDetails?.type || r.itemAccessDetails.type === 'SemanticModel'))
      .map((r) => ({
        id: (r.id as string).toLowerCase(),
        displayName: r.displayName ?? (r.id as string),
        permissions: (r.itemAccessDetails?.permissions ?? []).map((p) => String(p).toLowerCase()),
      }));
  }

  /** Every semantic model in the tenant with its workspace. Fabric admin API. */
  async listTenantModels(): Promise<TenantModel[]> {
    const rows = await this.adminPages<{ id?: string; name?: string; workspaceId?: string }>(`${this.fabric}/admin/items?type=SemanticModel`, 'itemEntities');
    return rows.filter((r) => r.id && r.workspaceId).map((r) => ({ id: (r.id as string).toLowerCase(), name: r.name ?? (r.id as string), workspaceId: (r.workspaceId as string).toLowerCase() }));
  }

  /** Who holds a role in a workspace. Needs the Member role or higher in that workspace. Groups are listed, not expanded. */
  async listWorkspaceRoleAssignments(workspaceId: string): Promise<RoleAssignment[]> {
    const rows = await this.list<{ principal?: { id?: string; type?: string; userDetails?: { userPrincipalName?: string } }; role?: string }>(
      `${this.fabric}/workspaces/${workspaceId}/roleAssignments`,
    );
    return rows
      .filter((r) => r.principal?.id && r.role)
      .map((r) => ({
        principalId: (r.principal?.id as string).toLowerCase(),
        principalType: r.principal?.type ?? '',
        ...(r.principal?.userDetails?.userPrincipalName ? { userPrincipalName: r.principal.userDetails.userPrincipalName.toLowerCase() } : {}),
        role: r.role as string,
      }));
  }

  // ---- Discovery ---------------------------------------------------------

  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return this.list<WorkspaceInfo>(`${this.fabric}/workspaces`);
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    return this.json('fabric', 'GET', `${this.fabric}/workspaces/${workspaceId}`);
  }

  listCapacities(): Promise<CapacityInfo[]> {
    return this.list<CapacityInfo>(`${this.fabric}/capacities`);
  }

  /** Fabric admin API. Requires the calling identity to be a Fabric administrator. */
  async listTenantSettings(): Promise<TenantSetting[]> {
    const r = await this.json<{ tenantSettings?: TenantSetting[] }>('fabric', 'GET', `${this.fabric}/admin/tenantsettings`);
    return r.tenantSettings ?? [];
  }

  /** Reads one item. Throws FabricApiError 404 when the item does not exist or the caller cannot see it. */
  getItem(workspaceId: string, itemId: string): Promise<{ id: string; displayName?: string; type?: string }> {
    return this.json('fabric', 'GET', `${this.fabric}/workspaces/${workspaceId}/items/${itemId}`);
  }

  async listSemanticModels(workspaceId: string): Promise<SemanticModelItem[]> {
    const items = await this.list<Omit<SemanticModelItem, 'workspaceId'>>(`${this.fabric}/workspaces/${workspaceId}/semanticModels`);
    return items.map((i) => ({ ...i, workspaceId }));
  }

  // ---- Definition round trip ----------------------------------------------

  async getDefinition(workspaceId: string, modelId: string): Promise<DefinitionParts> {
    const res = await this.request('fabric', 'POST', `${this.fabric}/workspaces/${workspaceId}/semanticModels/${modelId}/getDefinition?format=TMDL`);
    const body = await this.lro<{ definition?: { parts?: { path: string; payload: string; payloadType?: string }[] } }>(res, true);
    const parts = body.definition?.parts;
    // An empty export must never be mistaken for an empty model: a write planned against it could wipe the real one.
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('Fabric returned no definition for this model, so nothing was read. Try again in a moment.');
    }
    return decodeDefinition({ parts });
  }

  /** Replaces the whole definition. `parts` must contain every part; `.platform` is never sent. */
  async updateDefinition(workspaceId: string, modelId: string, parts: DefinitionParts): Promise<void> {
    const res = await this.request('fabric', 'POST', `${this.fabric}/workspaces/${workspaceId}/semanticModels/${modelId}/updateDefinition`, {
      definition: { format: 'TMDL', parts: encodeDefinition(parts).filter((p) => p.path !== '.platform') },
    });
    await this.lro(res);
  }

  async createSemanticModel(workspaceId: string, displayName: string, parts: DefinitionParts, description?: string): Promise<SemanticModelItem> {
    const res = await this.request('fabric', 'POST', `${this.fabric}/workspaces/${workspaceId}/semanticModels`, {
      displayName,
      ...(description ? { description } : {}),
      definition: { format: 'TMDL', parts: encodeDefinition(parts).filter((p) => p.path !== '.platform') },
    });
    const body = await this.lro<Partial<SemanticModelItem>>(res);
    if (body.id) return { id: body.id, displayName, workspaceId };
    const found = (await this.listSemanticModels(workspaceId)).find((m) => m.displayName === displayName);
    if (!found) throw new Error(`Created semantic model "${displayName}" but could not find it afterwards.`);
    return found;
  }

  async deleteSemanticModel(workspaceId: string, modelId: string): Promise<void> {
    await this.request('fabric', 'DELETE', `${this.fabric}/workspaces/${workspaceId}/semanticModels/${modelId}`);
  }

  // ---- Power BI REST -------------------------------------------------------

  async refresh(workspaceId: string, modelId: string): Promise<void> {
    await this.request('powerbi', 'POST', `${this.pbi}/groups/${workspaceId}/datasets/${modelId}/refreshes`, { notifyOption: 'NoNotification' });
  }

  async lastRefresh(workspaceId: string, modelId: string): Promise<{ status?: string; endTime?: string } | undefined> {
    const r = await this.json<{ value?: { status?: string; endTime?: string }[] }>('powerbi', 'GET', `${this.pbi}/groups/${workspaceId}/datasets/${modelId}/refreshes?$top=1`);
    return r.value?.[0];
  }

  /** Wait until the latest refresh is no longer running. */
  async waitForRefresh(workspaceId: string, modelId: string, timeoutMs = 180_000): Promise<string> {
    const start = Date.now();
    for (;;) {
      await sleep(4000);
      const r = await this.lastRefresh(workspaceId, modelId);
      if (r?.status && r.status !== 'Unknown' && r.status !== 'InProgress') return r.status;
      if (Date.now() - start > timeoutMs) return 'Timeout';
    }
  }

  /** Dataset details; includes the endorsement-independent flags exposed by the Power BI REST API. */
  getDataset(workspaceId: string, modelId: string): Promise<Record<string, unknown>> {
    return this.json('powerbi', 'GET', `${this.pbi}/groups/${workspaceId}/datasets/${modelId}`);
  }

  async executeDax(workspaceId: string, modelId: string, query: string): Promise<unknown[]> {
    const r = await this.json<{ results?: { tables?: { rows?: unknown[] }[] }[] }>(
      'powerbi',
      'POST',
      `${this.pbi}/groups/${workspaceId}/datasets/${modelId}/executeQueries`,
      { queries: [{ query }], serializerSettings: { includeNulls: true } },
    );
    return r.results?.[0]?.tables?.[0]?.rows ?? [];
  }
}

/**
 * Refuses a definition that does not look like a whole semantic model. Writes replace the entire
 * definition, so planning one against a partial or empty read could destroy the real model.
 */
export function assertModelDefinition(parts: DefinitionParts): void {
  const paths = Object.keys(parts);
  const problems: string[] = [];
  if (!paths.includes('definition.pbism')) problems.push('definition.pbism is missing');
  if (!paths.some((p) => p === 'definition/model.tmdl' || p === 'definition/database.tmdl')) problems.push('the model definition (model.tmdl) is missing');
  if (!paths.some((p) => /^definition\/tables\/.+\.tmdl$/i.test(p))) problems.push('the model has no tables');
  if (problems.length > 0) {
    throw new Error(`Fabric returned an incomplete model definition (${problems.join('; ')}), so nothing was changed. Try again; if it persists, open the model in Fabric to check it.`);
  }
}
