import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react'

export type MainTab = 'map' | 'nodes' | 'plans' | 'sessions' | 'provider'
export type SettingsTab = 'general' | 'network' | 'wallets'

interface NavigationContextValue {
  mainTab: MainTab
  setMainTab: (tab: MainTab) => void
  /** Which Settings tab is open, or null when the modal is closed. */
  settingsTab: SettingsTab | null
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
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
  // Lives here rather than in App so anything nested — the RPC status pill, a
  // connect-error panel several modals deep — can send the user to the right
  // Settings tab without a prop threaded through every parent.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)

  const openSettings = useCallback((tab: SettingsTab = 'general') => {
    setSettingsTab(tab)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsTab(null)
  }, [])

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
      settingsTab,
      openSettings,
      closeSettings,
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
      settingsTab,
      openSettings,
      closeSettings,
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
