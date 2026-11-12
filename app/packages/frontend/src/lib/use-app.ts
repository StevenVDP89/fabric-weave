import { createContext, useContext } from 'react';

import type { ServiceStatus, Workspace } from '@/lib/api';

export interface AppState {
  status: ServiceStatus | undefined;
  statusError: string | null;
  workspaces: Workspace[] | undefined;
  workspacesError: string | null;
  workspacesLoading: boolean;
  reloadStatus: () => void;
  reloadWorkspaces: () => void;
  replaceWorkspace: (next: Workspace) => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}