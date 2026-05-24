import { useState, useEffect, useCallback } from 'react'
import type { ConnectionStatus, ConnectionState } from '../types'

// Defensive poll rates per state. State transitions are pushed from main via
// IPC.CONNECTION_STATE_CHANGE, so the poll only catches drift; tight intervals
// are only useful when the user is watching reconnect progress.
const POLL_INTERVAL_MS: Record<ConnectionState, number> = {
  idle: 15_000,
  connected: 10_000,
  reconnecting: 3_000,
}

export function useConnection() {
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'idle' })

  const pollStatus = useCallback(async () => {
    try {
      const s = await window.api.connectionStatus()
      setStatus(s)
    } catch {
      // silent
    }
  }, [])

  // Mount-only: initial fetch + push-event subscriptions.
  useEffect(() => {
    pollStatus()

    const unsubscribe = window.api.onConnectionStateChange(() => {
      pollStatus()
    })

    const unsubReconnect = window.api.onConnectionReconnecting((attempt, maxAttempts) => {
      setStatus((prev) => ({
        ...prev,
        state: 'reconnecting',
        reconnectAttempt: attempt,
        reconnectMaxAttempts: maxAttempts,
      }))
    })

    return () => {
      unsubscribe()
      unsubReconnect()
    }
  }, [pollStatus])

  // State-dependent: polling cadence adjusts when state changes.
  useEffect(() => {
    const ms = POLL_INTERVAL_MS[status.state] ?? 10_000
    const id = setInterval(pollStatus, ms)
    return () => clearInterval(id)
  }, [pollStatus, status.state])

  async function disconnect() {
    await window.api.connectionDisconnect()
    setStatus({ state: 'idle' })
  }

  return { status, disconnect, refresh: pollStatus }
}
