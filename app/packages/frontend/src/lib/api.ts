import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppFunctionsSchema } from '@rayfin-app/functions/types';

import { getRayfinClient } from './rayfin-client';

type In<K extends keyof AppFunctionsSchema> = AppFunctionsSchema[K]['input'];
type Out<K extends keyof AppFunctionsSchema> = AppFunctionsSchema[K]['output'];

export type Workspace = Out<'listWorkspaces'>[number];
export type ModelRow = Out<'listModels'>[number];
export type Assessment = Out<'assessModel'>;
export type ProposalSet = Out<'getFixProposals'>;
export type Proposal = ProposalSet['proposals'][number];
export type ApplyResult = Out<'applyFixes'>;
export type RollbackResult = Out<'rollbackChangeSet'>;
export type Readiness = Out<'getAgentReadiness'>;
export type ContextDraft = Out<'draftBusinessContext'>;
export type InterviewStep = Out<'interviewBusinessContext'>;
export type InterviewTurn = In<'interviewBusinessContext'>['turns'][number];
export type Portfolio = Out<'getPortfolio'>;
export type PortfolioQuery = In<'getPortfolio'>['query'];
export type ServiceStatus = Out<'getServiceStatus'>;
export type WriteMode = In<'saveWorkspaceSetting'>['writeMode'];

const LONG = { timeoutMs: 240_000 };

/** One typed method per Rayfin function; every call goes through the generated schema. */
export const api = {
  async listWorkspaces() {
    return (await getRayfinClient()).functions.listWorkspaces.invoke();
  },
  async saveWorkspaceSetting(input: In<'saveWorkspaceSetting'>) {
    return (await getRayfinClient()).functions.saveWorkspaceSetting.invoke(input);
  },
  async listModels(workspaceId: string) {
    return (await getRayfinClient()).functions.listModels.invoke({ workspaceId }, LONG);
  },
  async assessModel(workspaceId: string, modelId: string, useJudge: boolean) {
    return (await getRayfinClient()).functions.assessModel.invoke({ workspaceId, modelId, useJudge }, LONG);
  },
  async getFixProposals(workspaceId: string, modelId: string, useAi: boolean) {
    return (await getRayfinClient()).functions.getFixProposals.invoke({ workspaceId, modelId, useAi }, LONG);
  },
  async applyFixes(workspaceId: string, modelId: string, proposals: Proposal[], baseDigest: string) {
    return (await getRayfinClient()).functions.applyFixes.invoke({ workspaceId, modelId, proposals, baseDigest }, LONG);
  },
  async rollbackChangeSet(changeSetId: string, discardLaterEdits = false) {
    return (await getRayfinClient()).functions.rollbackChangeSet.invoke({ changeSetId, discardLaterEdits }, LONG);
  },
  async getAgentReadiness(workspaceId: string, modelId: string) {
    return (await getRayfinClient()).functions.getAgentReadiness.invoke({ workspaceId, modelId }, LONG);
  },
  async setApprovedForCopilot(workspaceId: string, modelId: string, approved: boolean) {
    return (await getRayfinClient()).functions.setApprovedForCopilot.invoke({ workspaceId, modelId, approved });
  },
  async draftBusinessContext(workspaceId: string, modelId: string) {
    return (await getRayfinClient()).functions.draftBusinessContext.invoke({ workspaceId, modelId }, LONG);
  },
  async interviewBusinessContext(workspaceId: string, modelId: string, turns: InterviewTurn[], existing: string, finish: boolean) {
    return (await getRayfinClient()).functions.interviewBusinessContext.invoke({ workspaceId, modelId, turns, existing, finish }, LONG);
  },
  async getPortfolio(query: PortfolioQuery) {
    return (await getRayfinClient()).functions.getPortfolio.invoke({ query });
  },
  async getServiceStatus() {
    return (await getRayfinClient()).functions.getServiceStatus.invoke();
  },
};

/** Maps provider/transport failures to a short message that is safe to show. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (/timed? ?out|abort/i.test(text)) return 'The request timed out. Large models can take a few minutes; try again.';
  if (/401|unauthori[sz]ed|sign.?in/i.test(text)) return 'Your session has expired. Reload the page to sign in again.';
  if (/403|forbidden/i.test(text)) return 'You do not have access to this item.';
  return text.length > 400 ? `${text.slice(0, 400)}…` : text || 'Something went wrong.';
}

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (next: T | undefined) => void;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/** Runs `load` on mount and whenever `deps` change; drops results from superseded runs. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [seenDeps, setSeenDeps] = useState(deps);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  // A changed dependency starts a new load; flip the flags while rendering so no stale "settled" frame is painted.
  if (!sameDeps(seenDeps, deps)) {
    setSeenDeps(deps);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let current = true;
    loadRef
      .current()
      .then((value) => {
        if (!current) return;
        setData(value);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!current) return;
        setError(describeError(e));
        setLoading(false);
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setTick((t) => t + 1);
  }, []);
  return { data, error, loading, reload, setData };
}

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  busy: boolean;
  error: string | null;
  reset: () => void;
}

/** Wraps a mutation: tracks busy and error state and never throws into render. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): Action<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  });

  const run = useCallback(async (...args: A) => {
    setBusy(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(describeError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);
  return { run, busy, error, reset };
}