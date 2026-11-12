import type { ReactNode } from 'react';

import { api, useAsync } from '@/lib/api';
import { AppContext, type AppState } from '@/lib/use-app';

/** Loads the status and workspace list once for the whole shell, so pages do not each refetch them. */
export function AppProvider({ children }: { children: ReactNode }) {
  const status = useAsync(() => api.getServiceStatus(), []);
  const workspaces = useAsync(() => api.listWorkspaces(), []);

  const value: AppState = {
    status: status.data,
    statusError: status.error,
    workspaces: workspaces.data,
    workspacesError: workspaces.error,
    workspacesLoading: workspaces.loading,
    reloadStatus: status.reload,
    reloadWorkspaces: workspaces.reload,
    replaceWorkspace: (next) => workspaces.setData((workspaces.data ?? []).map((w) => (w.id === next.id ? next : w))),
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}