import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react'

export type MainTab = 'map' | 'nodes' | 'plans' | 'sessions'

interface NavigationContextValue {
  mainTab: MainTab
  setMainTab: (tab: MainTab) => void
  plansNodeFilter: string | null
  goToPlansForNode: (nodeAddress: string) => void
  clearPlansNodeFilter: () => void
  nodesCountryFilter: string | null
  goToNodesForCountry: (country: string) => void
  clearNodesCountryFilter: () => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [mainTab, setMainTab] = useState<MainTab>('map')
  const [plansNodeFilter, setPlansNodeFilter] = useState<string | null>(null)
  const [nodesCountryFilter, setNodesCountryFilter] = useState<string | null>(null)

  const goToPlansForNode = useCallback((nodeAddress: string) => {
    setPlansNodeFilter(nodeAddress)
    setMainTab('plans')
  }, [])

  const clearPlansNodeFilter = useCallback(() => {
    setPlansNodeFilter(null)
  }, [])

  const goToNodesForCountry = useCallback((country: string) => {
    setNodesCountryFilter(country)
    setMainTab('nodes')
  }, [])

  const clearNodesCountryFilter = useCallback(() => {
    setNodesCountryFilter(null)
  }, [])

  const value = useMemo(
    () => ({
      mainTab,
      setMainTab,
      plansNodeFilter,
      goToPlansForNode,
      clearPlansNodeFilter,
      nodesCountryFilter,
      goToNodesForCountry,
      clearNodesCountryFilter,
    }),
    [
      mainTab,
      setMainTab,
      plansNodeFilter,
      goToPlansForNode,
      clearPlansNodeFilter,
      nodesCountryFilter,
      goToNodesForCountry,
      clearNodesCountryFilter,
    ],
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext)
  if (!ctx) {
    throw new Error('useNavigation must be used within a NavigationProvider')
  }
  return ctx
}
