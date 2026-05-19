import { useState, useEffect, useCallback } from 'react'
import type { SessionInfo } from '../types'
import { useConnection } from './useConnection'

const POLL_SESSIONS_MS = 120_000

export function useSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const { status } = useConnection()
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
    const interval = setInterval(refresh, POLL_SESSIONS_MS)
    return () => clearInterval(interval)
  }, [refresh])

  return { sessions, loading, refreshing, refresh }
}
