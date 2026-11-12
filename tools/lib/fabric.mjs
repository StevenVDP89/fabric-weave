// Thin Fabric REST client for the packaging tools (preflight, teardown). Uses the Azure CLI identity.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { TokenCache, azCommandLine, withTimeout } from './common.mjs';

export const FABRIC = 'https://api.fabric.microsoft.com';
export const POWERBI = 'https://analysis.windows.net/powerbi/api';

// One command string (not an args array) so `shell: true` works the same on Windows, macOS and Linux.
export function az(args) {
  const cmd = azCommandLine(args, { exists: existsSync });
  const res = spawnSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 });
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim(), missing: res.status === 127 || /not recognized|not found/i.test(res.stderr ?? '') };
}

export function azAccount() {
  const res = az(['account', 'show', '--query', '{user:user.name,type:user.type,tenant:tenantId}', '-o', 'json']);
  if (!res.ok) return { ok: false, missing: res.missing, detail: res.missing ? 'Azure CLI (az) is not installed' : 'az is not signed in. Run `az login`' };
  const { user, type, tenant } = JSON.parse(res.stdout);
  return { ok: true, user, type, tenant, detail: `${user} (tenant ${tenant})` };
}

// The Entra object id of the person signed in to the Azure CLI, or undefined when it cannot be read (best effort).
export function azObjectId() {
  const res = az(['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']);
  return res.ok && /^[0-9a-f-]{36}$/i.test(res.stdout) ? res.stdout.toLowerCase() : undefined;
}

export function azToken(resource = FABRIC) {
  const res = az(['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv']);
  if (!res.ok || !res.stdout) throw new Error(`Could not get an Azure token for ${resource}. Run \`az login\`.`);
  return res.stdout;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FabricClient {
  constructor({ tokenFn = azToken, fetchFn = fetch, sleepFn = defaultSleep, timeoutMs } = {}) {
    this.tokenFn = tokenFn;
    this.fetchFn = withTimeout(fetchFn, timeoutMs);
    this.sleep = sleepFn;
    // Tokens are re-acquired once they are ten minutes old or about to expire, so a long run never uses a stale one.
    this.tokens = new TokenCache((resource) => this.tokenFn(resource));
  }

  token(resource = FABRIC) {
    return this.tokens.get(resource);
  }

  // Returns { status, json }. Never throws for HTTP errors; the caller decides what a status means.
  async request(url, { method = 'GET', body, resource = FABRIC, retries = 4 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${this.token(resource)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        await this.sleep((Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000);
        continue;
      }
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, json, text };
    }
  }

  getWorkspace(id) {
    return this.request(`${FABRIC}/v1/workspaces/${id}`);
  }

  async listWorkspaces() {
    const workspaces = [];
    let next = `${FABRIC}/v1/workspaces`;
    while (next) {
      const page = await this.request(next);
      if (page.status !== 200) throw new Error(`HTTP ${page.status}: ${page.text.slice(0, 300)}`);
      workspaces.push(...(page.json?.value ?? []));
      next = page.json?.continuationUri;
    }
    return workspaces;
  }

  // Creates a workspace on a capacity. No retries: a retried POST could create the workspace twice.
  async createWorkspace(displayName, capacityId) {
    const res = await this.request(`${FABRIC}/v1/workspaces`, { method: 'POST', body: { displayName, ...(capacityId ? { capacityId } : {}) }, retries: 0 });
    return { ok: res.status === 201 || res.status === 200, status: res.status, id: res.json?.id, detail: res.json?.message ?? res.text.slice(0, 300) };
  }

  async listItems(workspaceId) {
    const items = [];
    let next = `${FABRIC}/v1/workspaces/${workspaceId}/items`;
    while (next) {
      const page = await this.request(next);
      if (page.status !== 200) throw new Error(`Listing workspace items failed (HTTP ${page.status}): ${page.text.slice(0, 300)}`);
      items.push(...(page.json?.value ?? []));
      next = page.json?.continuationUri;
    }
    return items;
  }

  async getCapacity(capacityId) {
    const res = await this.request(`${FABRIC}/v1/capacities`);
    if (res.status !== 200) return { status: res.status };
    return { status: 200, capacity: (res.json?.value ?? []).find((c) => c.id?.toLowerCase() === capacityId?.toLowerCase()) };
  }

  getRoleAssignments(workspaceId) {
    return this.request(`${FABRIC}/v1/workspaces/${workspaceId}/roleAssignments`);
  }

  // Power BI admin API: answers 200 only for Fabric administrators.
  probeFabricAdmin() {
    return this.request('https://api.powerbi.com/v1.0/myorg/admin/groups?$top=1', { resource: POWERBI, retries: 0 });
  }

  // Deletes an item and waits for long-running deletes. 404 counts as already gone.
  async deleteItem(workspaceId, itemId) {
    const res = await this.request(`${FABRIC}/v1/workspaces/${workspaceId}/items/${itemId}`, { method: 'DELETE' });
    if (res.status === 200 || res.status === 204 || res.status === 404) return { ok: true, status: res.status };
    return { ok: false, status: res.status, detail: res.json?.message ?? res.text.slice(0, 300) };
  }

  // Sets the description of an item (used for the "managed by Fabric Weave" marker). Never throws.
  async setDescription(workspaceId, itemId, description) {
    try {
      const res = await this.request(`${FABRIC}/v1/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', body: { description }, retries: 1 });
      return { ok: res.status === 200, status: res.status, detail: res.json?.message ?? res.text.slice(0, 300) };
    } catch (e) {
      return { ok: false, status: 0, detail: e.message };
    }
  }
}
