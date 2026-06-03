import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react'
import type { AppSettings } from '../types'

interface SettingsContextValue {
  settings: AppSettings | null
  updateSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  reload: () => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)

  const reload = useCallback(async () => {
    const s = await window.api.settingsGet()
    setSettings(s)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const updated = await window.api.settingsSet(partial)
    setSettings(updated)
    return updated
  }, [])

  const value = useMemo(
    () => ({ settings, updateSettings, reload }),
    [settings, updateSettings, reload],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return ctx
}
