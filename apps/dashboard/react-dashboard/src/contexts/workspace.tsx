import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  WORKSPACE_AFFILIATES,
  WORKSPACES,
  type Workspace,
} from '../../../src/shared/customlinkContract'

// Lifts the topnav workspace selection out of the selector so dashboard routes
// (notably Custom Link) can read it as the single source of truth for the
// affiliate preset. UI-only scope: selecting a workspace updates the visible
// brand and the customlink id/email; it does not change API headers or data
// scoping. Wiring it to request scoping is a separate, deliberate change.

export type { Workspace } from '../../../src/shared/customlinkContract'

type WorkspaceContextValue = {
  workspace: Workspace
  setWorkspace: (next: Workspace) => void
  // Affiliate preset for the current workspace (id + display-only email).
  affiliate: (typeof WORKSPACE_AFFILIATES)[Workspace]
  workspaces: typeof WORKSPACES
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspaceState] = useState<Workspace>(WORKSPACES[0])

  const setWorkspace = useCallback((next: Workspace) => {
    setWorkspaceState(next)
  }, [])

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspace,
      setWorkspace,
      affiliate: WORKSPACE_AFFILIATES[workspace],
      workspaces: WORKSPACES,
    }),
    [workspace, setWorkspace],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider')
  }
  return value
}
