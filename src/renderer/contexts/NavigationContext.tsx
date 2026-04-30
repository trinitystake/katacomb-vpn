import { createContext, useCallback, useContext, useState, ReactNode } from 'react'

export type MainTab = 'nodes' | 'plans' | 'sessions'

interface NavigationContextValue {
  mainTab: MainTab
  setMainTab: (tab: MainTab) => void
  plansNodeFilter: string | null
  goToPlansForNode: (nodeAddress: string) => void
  clearPlansNodeFilter: () => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [mainTab, setMainTab] = useState<MainTab>('nodes')
  const [plansNodeFilter, setPlansNodeFilter] = useState<string | null>(null)

  const goToPlansForNode = useCallback((nodeAddress: string) => {
    setPlansNodeFilter(nodeAddress)
    setMainTab('plans')
  }, [])

  const clearPlansNodeFilter = useCallback(() => {
    setPlansNodeFilter(null)
  }, [])

  return (
    <NavigationContext.Provider
      value={{ mainTab, setMainTab, plansNodeFilter, goToPlansForNode, clearPlansNodeFilter }}
    >
      {children}
    </NavigationContext.Provider>
  )
}

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext)
  if (!ctx) {
    throw new Error('useNavigation must be used within a NavigationProvider')
  }
  return ctx
}
