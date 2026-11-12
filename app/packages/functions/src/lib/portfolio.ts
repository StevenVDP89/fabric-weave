import { tierFor } from '@rayfin-app/engine';
import type { PortfolioModel, PortfolioQuery, PortfolioView, RunStatusView } from '../contracts.js';
import { config, type Ctx } from './runtime.js';

interface RawPortfolio {
  generatedAt?: string;
  workspaces?: { id: string; name: string }[];
  models?: Partial<PortfolioModel & { quickScore: PortfolioModel['quickScore'] }>[];
}

const CACHE_MS = 5 * 60_000;
let cache: { key: string; at: number; raw: RawPortfolio } | undefined;

export const EMPTY_TOTALS: PortfolioView['totals'] = { workspaces: 0, models: 0, scored: 0, averageScore: null, tiers: {}, withUsage: 0, unusedModels: 0 };

export function portfolioConfigured(ctx: Ctx): boolean {
  return /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(config(ctx, 'PORTFOLIO_PATH') ?? '');
}

async function download(ctx: Ctx): Promise<RawPortfolio> {
  const path = config(ctx, 'PORTFOLIO_PATH');
  if (!path || !portfolioConfigured(ctx)) throw new Error('The estate scan is not installed. It is optional: inspect and fix models from the Models page.');
  if (cache && cache.key === path && Date.now() - cache.at < CACHE_MS) return cache.raw;
  const res = await fetch(`https://onelake.dfs.fabric.microsoft.com/${path}/Files/app/portfolio.json`, {
    headers: { authorization: `Bearer ${ctx.Tokens.Storage}`, 'x-ms-version': '2023-11-03' },
  });
  if (res.status === 404) throw new Error('The scan has not produced a portfolio yet. Run the PL_AI_Readiness_Refresh pipeline.');
  if (!res.ok) throw new Error(`Reading the portfolio from OneLake failed (${res.status}).`);
  const raw = (await res.json()) as RawPortfolio;
  cache = { key: path, at: Date.now(), raw };
  return raw;
}

const RUN_STATES = ['Running', 'Succeeded', 'Failed'] as const;
const RUN_CACHE_MS = 60_000;
let runCache: { key: string; at: number; value: RunStatusView | null } | undefined;

/** Turns whatever the notebooks wrote into the shape the app shows. Anything unrecognisable means "no status". */
export function parseRunStatus(raw: unknown): RunStatusView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const status = RUN_STATES.find((s) => s === r.status);
  if (!status) return null;
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    status,
    stage: text(r.stage, 20),
    startedAt: text(r.startedAt, 40),
    finishedAt: text(r.finishedAt, 40),
    error: text(r.error, 500),
    models: typeof r.models === 'number' && Number.isFinite(r.models) ? r.models : null,
  };
}

/** The outcome of the latest scan, written by the notebooks. Never throws: a missing file just means unknown. */
export async function readRunStatus(ctx: Ctx): Promise<RunStatusView | null> {
  const path = config(ctx, 'PORTFOLIO_PATH');
  if (!path || !portfolioConfigured(ctx)) return null;
  if (runCache && runCache.key === path && Date.now() - runCache.at < RUN_CACHE_MS) return runCache.value;
  try {
    const res = await fetch(`https://onelake.dfs.fabric.microsoft.com/${path}/Files/app/run_status.json`, {
      headers: { authorization: `Bearer ${ctx.Tokens.Storage}`, 'x-ms-version': '2023-11-03' },
    });
    const value = res.ok ? parseRunStatus(await res.json()) : null;
    runCache = { key: path, at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

function normalise(m: NonNullable<RawPortfolio['models']>[number]): PortfolioModel | undefined {
  if (!m.modelId || !m.workspaceId) return undefined;
  return {
    workspaceId: m.workspaceId,
    workspaceName: m.workspaceName ?? m.workspaceId,
    modelId: m.modelId,
    name: m.name ?? m.modelId,
    configuredBy: m.configuredBy ?? null,
    createdDate: m.createdDate ?? null,
    targetStorageMode: m.targetStorageMode ?? null,
    isRefreshable: m.isRefreshable ?? null,
    lastRefresh: m.lastRefresh ?? null,
    usage: m.usage ?? null,
    quickScore: m.quickScore ?? null,
    tables: m.tables ?? null,
    measures: m.measures ?? null,
    scanError: m.scanError ?? null,
    deepScore: null,
    deepAssessedAt: null,
  };
}

export async function readPortfolio(
  ctx: Ctx,
  query: PortfolioQuery,
  deep: Map<string, { score: number; assessedAt: string }>,
  /** Keeps only the models the caller may see. Totals are computed from what is kept. */
  allow?: (m: { workspaceId: string; modelId: string }) => boolean,
): Promise<PortfolioView> {
  let raw: RawPortfolio;
  const lastRun = readRunStatus(ctx);
  try {
    raw = await download(ctx);
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e), generatedAt: null, lastRun: await lastRun, totals: EMPTY_TOTALS, total: 0, models: [] };
  }
  const all = (raw.models ?? []).map(normalise).filter((m): m is PortfolioModel => !!m && (!allow || allow(m)));
  for (const m of all) {
    const d = deep.get(m.modelId);
    if (d) {
      m.deepScore = d.score;
      m.deepAssessedAt = d.assessedAt;
    }
  }
  const best = (m: PortfolioModel) => m.deepScore ?? m.quickScore?.score ?? null;
  const tierOf = (m: PortfolioModel) => (m.deepScore !== null ? tierFor(m.deepScore) : (m.quickScore?.tier ?? 'Not scored'));

  const tiers: Record<string, number> = {};
  let sum = 0;
  let scored = 0;
  let withUsage = 0;
  let unused = 0;
  for (const m of all) {
    tiers[tierOf(m)] = (tiers[tierOf(m)] ?? 0) + 1;
    const s = best(m);
    if (s !== null) {
      sum += s;
      scored += 1;
    }
    if (m.usage) {
      withUsage += 1;
      if ((m.usage.views30d ?? 0) === 0) unused += 1;
    }
  }

  const search = (query.search ?? '').trim().toLowerCase().slice(0, 100);
  let rows = all.filter((m) => {
    if (query.tier && tierOf(m) !== query.tier) return false;
    if (!search) return true;
    return m.name.toLowerCase().includes(search) || m.workspaceName.toLowerCase().includes(search) || (m.configuredBy ?? '').toLowerCase().includes(search);
  });
  const dir = query.sortDir === 'desc' ? -1 : 1;
  const sortBy = query.sortBy ?? 'score';
  const key = (m: PortfolioModel): number | string => {
    if (sortBy === 'name') return m.name.toLowerCase();
    if (sortBy === 'workspace') return m.workspaceName.toLowerCase();
    if (sortBy === 'usage') return m.usage?.views30d ?? -1;
    return best(m) ?? -1;
  };
  rows = rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -dir : ka > kb ? dir : 0;
  });
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
  return {
    available: true,
    reason: null,
    generatedAt: raw.generatedAt ?? null,
    lastRun: await lastRun,
    totals: {
      workspaces: allow ? new Set(all.map((m) => m.workspaceId)).size : (raw.workspaces?.length ?? new Set(all.map((m) => m.workspaceId)).size),
      models: all.length,
      scored,
      averageScore: scored ? Math.round((sum / scored) * 10) / 10 : null,
      tiers,
      withUsage,
      unusedModels: unused,
    },
    total: rows.length,
    models: rows.slice(offset, offset + limit),
  };
}
