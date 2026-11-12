import { useCallback, useEffect, useState } from 'react';

export type ModelTab = 'overview' | 'model' | 'fix' | 'context' | 'agents';

export type Route =
  | { page: 'portfolio' }
  | { page: 'models' }
  | { page: 'workspaces' }
  | { page: 'status' }
  | { page: 'model'; workspaceId: string; modelId: string; tab: ModelTab };

const GUID = /^[0-9a-fA-F-]{32,40}$/;
const TABS: readonly ModelTab[] = ['overview', 'model', 'fix', 'context', 'agents'];

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'models':
      return { page: 'models' };
    case 'workspaces':
      return { page: 'workspaces' };
    case 'status':
      return { page: 'status' };
    case 'model': {
      const [, workspaceId, modelId, tab] = parts;
      if (workspaceId && modelId && GUID.test(workspaceId) && GUID.test(modelId)) {
        const t = TABS.find((x) => x === tab) ?? 'overview';
        return { page: 'model', workspaceId, modelId, tab: t };
      }
      return { page: 'models' };
    }
    default:
      return { page: 'portfolio' };
  }
}

export function hrefFor(route: Route): string {
  if (route.page === 'model') return `#/model/${route.workspaceId}/${route.modelId}/${route.tab}`;
  return route.page === 'portfolio' ? '#/portfolio' : `#/${route.page}`;
}

export function modelHref(workspaceId: string, modelId: string, tab: ModelTab = 'overview'): string {
  return hrefFor({ page: 'model', workspaceId, modelId, tab });
}

/** Hash routing keeps deep links working inside the Fabric portal iframe and on static hosting. */
export function useRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const go = useCallback((to: string) => {
    window.location.hash = to.replace(/^#/, '');
  }, []);

  return [route, go];
}
