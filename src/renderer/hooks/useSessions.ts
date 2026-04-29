import { useState, useEffect, useCallback } from 'react'
import type { SessionInfo } from '../types'
import { useConnection } from './useConnection'
import { useSettings } from '../contexts/SettingsContext'

export function useSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const { status } = useConnection()
  const { settings } = useSettings()
  const pollSec = settings?.pollAllocationSec ?? 60
  const vpnConnected = status.state === 'connected'

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const result = await window.api.walletSessions()
      setSessions(result)
    } catch {
      // silent
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [vpnConnected, refresh])

  useEffect(() => {
    const interval = setInterval(refresh, pollSec * 1000)
    return () => clearInterval(interval)
  }, [refresh, pollSec])

  return { sessions, loading, refreshing, refresh }
}
