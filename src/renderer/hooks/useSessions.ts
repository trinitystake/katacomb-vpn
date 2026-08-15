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

  // Main cancels sessions the user never sees a button for: the refund after a failed
  // purchase, either hop of a failed chain. Without this the row sat here for up to
  // POLL_SESSIONS_MS still looking live and still offering Connect, directly after a
  // modal said the deposit had been refunded — which reads as the refund having failed.
  useEffect(() => window.api.onSessionsChanged(() => { void refresh() }), [refresh])

  return { sessions, loading, refreshing, refresh }
}
