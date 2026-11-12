import type { CapacityInfo, FabricClient, TenantSetting } from './fabric.js';
import type { ModelSnapshot } from './types.js';

/**
 * "Is this model reachable by AI agents?" - the checks that sit around the model itself:
 * tenant switches, workspace capacity and the per-model flags that decide whether Copilot,
 * the Power BI MCP server and Fabric data agents can use it.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';
export type CheckLevel = 'tenant' | 'workspace' | 'model';

export interface AvailabilityCheck {
  id: string;
  level: CheckLevel;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do when the check is not green. */
  action?: string;
  /** Who can act: the app can fix model content, everything else is an admin / owner task. */
  owner: 'app' | 'model-owner' | 'workspace-admin' | 'tenant-admin';
  link?: string;
  /** Agent surfaces this check gates. */
  surfaces: AgentSurface[];
}

export type AgentSurface = 'copilot' | 'mcp' | 'data-agent';

export interface SurfaceStatus {
  surface: AgentSurface;
  label: string;
  status: CheckStatus;
  blockers: string[];
}

export interface AgentAvailability {
  checks: AvailabilityCheck[];
  surfaces: SurfaceStatus[];
  tenantSettingsReadable: boolean;
  evaluatedAt: string;
}

export interface AvailabilityInput {
  workspaceId: string;
  modelId: string;
  snapshot: ModelSnapshot;
  /** undefined = the caller could not read tenant settings (not a Fabric admin). */
  tenantSettings?: TenantSetting[];
  /** undefined = capacity could not be resolved. */
  capacity?: CapacityInfo | null;
  workspaceHasCapacity?: boolean;
  /** Attested by a person in the app, since Microsoft exposes no API for this flag. */
  approvedForCopilotAttested?: boolean | null;
  lastRefreshStatus?: string | null;
  now?: Date;
}

const SURFACE_LABEL: Record<AgentSurface, string> = {
  copilot: 'Power BI Copilot',
  mcp: 'Power BI MCP server',
  'data-agent': 'Fabric data agent',
};

/** F2+ and P1+ are Copilot-eligible; trial, PPU and shared capacity are not. */
export function isCopilotEligibleSku(sku: string | undefined): boolean {
  if (!sku) return false;
  const s = sku.toUpperCase();
  if (/^FT/.test(s)) return false;
  const f = /^F(\d+)$/.exec(s);
  if (f) return Number(f[1]) >= 2;
  return /^P[1-9]$/.test(s);
}

export function modelSettingsLink(workspaceId: string, modelId: string): string {
  return `https://app.fabric.microsoft.com/groups/${workspaceId}/datasets/${modelId}/details?experience=power-bi`;
}

const ADMIN_PORTAL = 'https://app.fabric.microsoft.com/admin-portal/tenantSettings';

function tenantCheck(
  settings: TenantSetting[] | undefined,
  name: string,
  spec: {
    id: string;
    title: string;
    surfaces: AgentSurface[];
    wantEnabled: boolean;
    onPass: string;
    onFail: string;
    action: string;
    failStatus?: CheckStatus;
  },
): AvailabilityCheck {
  const base = { id: spec.id, level: 'tenant' as const, title: spec.title, owner: 'tenant-admin' as const, link: ADMIN_PORTAL, surfaces: spec.surfaces };
  if (!settings) {
    return { ...base, status: 'unknown', detail: 'Tenant settings can only be read by a Fabric administrator. Ask your tenant admin to confirm this switch.', action: spec.action };
  }
  const s = settings.find((x) => x.settingName === name);
  if (!s) return { ...base, status: 'unknown', detail: `Setting "${name}" is not exposed in this tenant.`, action: spec.action };
  const scoped = (s.enabledSecurityGroups?.length ?? 0) > 0;
  const ok = s.enabled === spec.wantEnabled;
  if (ok) {
    return {
      ...base,
      status: scoped ? 'warn' : 'pass',
      detail: scoped ? `${spec.onPass} It is limited to specific security groups, so confirm your audience is included.` : spec.onPass,
      action: scoped ? 'Confirm that the people who will chat with this model are in the allowed security groups.' : undefined,
    };
  }
  return { ...base, status: spec.failStatus ?? 'fail', detail: spec.onFail, action: spec.action };
}

export function evaluateAgentAvailability(input: AvailabilityInput): AgentAvailability {
  const { snapshot, tenantSettings } = input;
  const checks: AvailabilityCheck[] = [];
  const link = modelSettingsLink(input.workspaceId, input.modelId);

  // ---- Tenant -----------------------------------------------------------
  checks.push(
    tenantCheck(tenantSettings, 'EnableAOAI', {
      id: 'TEN-001',
      title: 'Copilot and AI experiences are enabled for the tenant',
      surfaces: ['copilot', 'data-agent'],
      wantEnabled: true,
      onPass: 'Copilot and AI agents powered by Azure OpenAI are enabled.',
      onFail: 'The "Users can use Copilot and other features powered by Azure OpenAI" switch is off, so no AI agent can use any model.',
      action: 'Fabric admin portal > Tenant settings > Copilot and Azure OpenAI Service: enable it.',
    }),
    tenantCheck(tenantSettings, 'ImmersiveTenantAdminSwitch', {
      id: 'TEN-002',
      title: 'Standalone Power BI Copilot (chat with your data) is enabled',
      surfaces: ['copilot'],
      wantEnabled: true,
      onPass: 'Users can open the standalone, cross-item Copilot experience.',
      onFail: 'The standalone Copilot experience is off, so users cannot chat across models.',
      action: 'Fabric admin portal > Tenant settings: enable "Users can access a standalone, cross-item Power BI Copilot experience".',
    }),
    tenantCheck(tenantSettings, 'PowerBIMCP', {
      id: 'TEN-003',
      title: 'Power BI MCP server endpoints are enabled',
      surfaces: ['mcp'],
      wantEnabled: true,
      onPass: 'The Power BI Model Context Protocol server endpoints are enabled.',
      onFail: 'The Power BI MCP server is off, so external agents (VS Code, Claude, Foundry) cannot query models.',
      action: 'Fabric admin portal > Tenant settings: enable "Users can use the Power BI Model Context Protocol server endpoints".',
    }),
  );

  const approvedOnly = tenantSettings?.find((s) => s.settingName === 'PreppedForCopilotContentDiscovery');
  if (approvedOnly?.enabled) {
    const attested = input.approvedForCopilotAttested;
    checks.push({
      id: 'TEN-004',
      level: 'tenant',
      title: 'Standalone Copilot only shows approved models',
      status: attested ? 'pass' : 'fail',
      detail: attested
        ? 'The tenant only surfaces approved models, and this model is marked Approved for Copilot.'
        : 'The tenant only surfaces models that are Approved for Copilot, and this model is not marked approved.',
      action: attested ? undefined : 'Open the model settings and tick "Approved for Copilot" (needs the model owner), then confirm it here.',
      owner: 'model-owner',
      link,
      surfaces: ['copilot'],
    });
  }

  const crossGeo = tenantSettings?.find((s) => s.settingName === 'AllowSendAOAIDataToOtherRegions');
  if (crossGeo && !crossGeo.enabled) {
    checks.push({
      id: 'TEN-005',
      level: 'tenant',
      title: 'Cross-region processing of AI data is disabled',
      status: 'warn',
      detail: 'Copilot only works for capacities in regions that host Azure OpenAI; capacities elsewhere stay blocked while this is off.',
      action: 'Verify the capacity region has Azure OpenAI, or enable cross-region processing if policy allows.',
      owner: 'tenant-admin',
      link: ADMIN_PORTAL,
      surfaces: ['copilot', 'data-agent'],
    });
  }

  // ---- Workspace --------------------------------------------------------
  if (input.workspaceHasCapacity === false) {
    checks.push({
      id: 'WSP-001',
      level: 'workspace',
      title: 'Workspace is on a capacity',
      status: 'fail',
      detail: 'The workspace is not assigned to a Fabric or Premium capacity. AI experiences need a paid capacity.',
      action: 'Assign the workspace to an F2+ (or P1+) capacity in the workspace settings.',
      owner: 'workspace-admin',
      surfaces: ['copilot', 'mcp', 'data-agent'],
    });
  } else if (input.capacity === undefined) {
    checks.push({
      id: 'WSP-001',
      level: 'workspace',
      title: 'Workspace capacity is Copilot-eligible (F2+ / P1+)',
      status: 'unknown',
      detail: 'The capacity SKU could not be read with the current permissions.',
      action: 'Check the workspace settings > License info.',
      owner: 'workspace-admin',
      surfaces: ['copilot', 'mcp', 'data-agent'],
    });
  } else if (input.capacity) {
    const eligible = isCopilotEligibleSku(input.capacity.sku);
    const paused = input.capacity.state && input.capacity.state !== 'Active';
    checks.push({
      id: 'WSP-001',
      level: 'workspace',
      title: 'Workspace capacity is Copilot-eligible (F2+ / P1+)',
      status: !eligible ? 'fail' : paused ? 'warn' : 'pass',
      detail: !eligible
        ? `Capacity ${input.capacity.displayName} (${input.capacity.sku}) is not Copilot-eligible. Trial, PPU and shared capacities do not support Copilot.`
        : paused
          ? `Capacity ${input.capacity.displayName} (${input.capacity.sku}) is ${input.capacity.state}. Resume it before users chat with the model.`
          : `Capacity ${input.capacity.displayName} (${input.capacity.sku}) is Copilot-eligible and active.`,
      action: !eligible ? 'Move the workspace to an F2+ or P1+ capacity.' : paused ? 'Resume the capacity.' : undefined,
      owner: 'workspace-admin',
      surfaces: ['copilot', 'mcp', 'data-agent'],
    });
  }

  // ---- Model ------------------------------------------------------------
  const copilot = snapshot.copilot;
  checks.push(
    {
      id: 'MOD-001',
      level: 'model',
      title: 'AI data schema scopes what Copilot may use',
      status: copilot.hasSchema ? 'pass' : 'warn',
      detail: copilot.hasSchema
        ? 'The model has a prepared AI data schema, so Copilot only sees curated tables and fields.'
        : 'No AI data schema: Copilot considers every visible object, which hurts accuracy on larger models.',
      action: copilot.hasSchema ? undefined : 'Apply the "scope the AI data schema" fix in the Fix workbench.',
      owner: 'app',
      surfaces: ['copilot', 'data-agent'],
    },
    {
      id: 'MOD-002',
      level: 'model',
      title: 'AI instructions give the model business context',
      status: copilot.instructions && copilot.instructions.trim().length >= 80 ? 'pass' : 'warn',
      detail: copilot.instructions ? `Instructions present (${copilot.instructions.trim().length} characters).` : 'No AI instructions are set on the model.',
      action: copilot.instructions ? undefined : 'Apply the "write AI instructions" fix in the Fix workbench.',
      owner: 'app',
      surfaces: ['copilot', 'mcp', 'data-agent'],
    },
    {
      id: 'MOD-003',
      level: 'model',
      title: 'Verified answers anchor common questions',
      status: copilot.verifiedAnswerCount > 0 ? 'pass' : 'warn',
      detail: copilot.verifiedAnswerCount > 0 ? `${copilot.verifiedAnswerCount} verified answer(s) configured.` : 'No verified answers. They need a report visual, so they are authored in Power BI Desktop or the service.',
      action: copilot.verifiedAnswerCount > 0 ? undefined : 'Create verified answers from a report visual in the Copilot settings of the model.',
      owner: 'model-owner',
      link,
      surfaces: ['copilot'],
    },
    {
      id: 'MOD-004',
      level: 'model',
      title: 'Approved for Copilot',
      status: input.approvedForCopilotAttested ? 'pass' : 'unknown',
      detail: input.approvedForCopilotAttested
        ? 'A person confirmed this model is marked Approved for Copilot.'
        : 'Microsoft exposes no API to read or set this flag. It decides whether the model is prioritised in standalone Copilot.',
      action: input.approvedForCopilotAttested ? undefined : 'Open the model settings > Copilot and tick "Approved for Copilot", then confirm it in Fabric Weave.',
      owner: 'model-owner',
      link,
      surfaces: ['copilot'],
    },
    {
      id: 'MOD-005',
      level: 'model',
      title: 'Consumers have Build permission on the model',
      status: 'unknown',
      detail: 'The Power BI MCP server and Fabric data agents run as the asking user, who needs Build permission on the model. This cannot be read in bulk.',
      action: 'Grant Build permission to the audience (security group) that should chat with the model.',
      owner: 'model-owner',
      link,
      surfaces: ['mcp', 'data-agent'],
    },
  );

  const refresh = input.lastRefreshStatus ?? snapshot.governance.lastRefreshSucceeded;
  if (refresh !== undefined && refresh !== null) {
    const ok = refresh === true || refresh === 'Completed';
    checks.push({
      id: 'MOD-006',
      level: 'model',
      title: 'Latest refresh succeeded',
      status: ok ? 'pass' : 'warn',
      detail: ok ? 'The last refresh completed.' : `The last refresh did not complete (${String(refresh)}). Agents answer from stale or missing data.`,
      action: ok ? undefined : 'Fix the failing refresh in the model settings.',
      owner: 'model-owner',
      link,
      surfaces: ['copilot', 'mcp', 'data-agent'],
    });
  }

  const surfaces: SurfaceStatus[] = (['copilot', 'mcp', 'data-agent'] as AgentSurface[]).map((surface) => {
    const relevant = checks.filter((c) => c.surfaces.includes(surface));
    const hard = relevant.filter((c) => c.status === 'fail');
    const soft = relevant.filter((c) => c.status === 'warn' || c.status === 'unknown');
    return {
      surface,
      label: SURFACE_LABEL[surface],
      status: hard.length ? 'fail' : soft.length ? 'warn' : 'pass',
      blockers: hard.map((c) => c.title),
    };
  });

  return {
    checks,
    surfaces,
    tenantSettingsReadable: tenantSettings !== undefined,
    evaluatedAt: (input.now ?? new Date()).toISOString(),
  };
}

export interface GatherOptions {
  snapshot: ModelSnapshot;
  approvedForCopilotAttested?: boolean | null;
}

/** Collects what can be read live, then evaluates. Every lookup degrades to "unknown" instead of failing. */
export async function gatherAgentAvailability(
  client: FabricClient,
  workspaceId: string,
  modelId: string,
  opts: GatherOptions,
): Promise<AgentAvailability> {
  const [tenantSettings, workspace, refresh] = await Promise.all([
    client.listTenantSettings().catch(() => undefined),
    client.getWorkspace(workspaceId).catch(() => undefined),
    client.lastRefresh(workspaceId, modelId).catch(() => undefined),
  ]);
  let capacity: CapacityInfo | null | undefined;
  let workspaceHasCapacity: boolean | undefined;
  if (workspace) {
    if (!workspace.capacityId) {
      workspaceHasCapacity = false;
      capacity = null;
    } else {
      const list = await client.listCapacities().catch(() => undefined);
      capacity = list ? (list.find((c) => c.id.toLowerCase() === workspace.capacityId!.toLowerCase()) ?? undefined) : undefined;
    }
  }
  return evaluateAgentAvailability({
    workspaceId,
    modelId,
    snapshot: opts.snapshot,
    tenantSettings,
    capacity,
    workspaceHasCapacity,
    approvedForCopilotAttested: opts.approvedForCopilotAttested,
    lastRefreshStatus: refresh?.status ?? null,
  });
}
