import { useState, useEffect, useCallback, useRef } from 'react'
import type { ConnectionStatus } from '../types'

const POLL_STATUS_MS = 3_000

export function useConnection() {
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'idle' })
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const pollStatus = useCallback(async () => {
    try {
      const s = await window.api.connectionStatus()
      setStatus(s)
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    pollStatus()
    intervalRef.current = setInterval(pollStatus, POLL_STATUS_MS)

    // Listen for push events from main process for immediate updates
    const unsubscribe = window.api.onConnectionStateChange(() => {
      pollStatus()
    })

    // Listen for reconnecting events
    const unsubReconnect = window.api.onConnectionReconnecting((attempt, maxAttempts) => {
      setStatus((prev) => ({
        ...prev,
        state: 'reconnecting',
        reconnectAttempt: attempt,
        reconnectMaxAttempts: maxAttempts,
      }))
    })

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      unsubscribe()
      unsubReconnect()
    }
  }, [pollStatus])

  async function disconnect() {
    await window.api.connectionDisconnect()
    setStatus({ state: 'idle' })
  }

  return { status, disconnect, refresh: pollStatus }
}
