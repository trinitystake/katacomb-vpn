import { useCallback, useEffect, useRef, useState } from 'react'
import type { TunnelProtocol } from '../types'

/**
 * The connect-flow state machine every paid connect shares: purchase, then the
 * separate CONNECTION_CONNECT tunnel bring-up, with the paid session kept
 * around so a failed bring-up retries WITHOUT buying again (main holds the
 * session config until disconnect). This existed three times, copy-pasted,
 * before it was a hook (ConnectionModal + the two retired plan modals).
 */
export function useConnectFlow() {
  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [stepDetail, setStepDetail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Protocol of the session already paid for; a failed bring-up retries against
  // that session instead of buying a second one.
  const [paidProtocol, setPaidProtocol] = useState<TunnelProtocol | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  // The mode the flow was STARTED with, so a retry keeps it.
  const modeRef = useRef<'tunnel' | 'proxy'>('tunnel')

  useEffect(() => {
    const unsub = window.api.onConnectionProgress((step, detail) => {
      setCurrentStep(step)
      setStepDetail(detail ?? null)
    })
    return unsub
  }, [])

  const connectTunnelOnly = useCallback(async (protocol: TunnelProtocol, dnsFallback: boolean) => {
    setCurrentStep('5/5')
    await window.api.connectionConnect({
      protocol,
      ...(modeRef.current === 'proxy' ? { mode: 'proxy' as const } : {}),
      ...(dnsFallback ? { dnsFallback: true } : {}),
    })
    setTunnelConnected(true)
  }, [])

  /**
   * Run a purchase (any IPC that returns a paid session), then bring the tunnel
   * up. The purchase callback is the caller's: node subscribe, plan subscribe,
   * session-from-subscription or smart connect all fit.
   */
  const start = useCallback(async (
    purchase: () => Promise<{ sessionId: string; protocol: string }>,
    opts?: { mode?: 'tunnel' | 'proxy' },
  ) => {
    modeRef.current = opts?.mode ?? 'tunnel'
    setConnecting(true)
    setError(null)
    setCurrentStep('1/5')
    try {
      const res = await purchase()
      setSessionId(res.sessionId)
      const protocol = res.protocol as TunnelProtocol
      setPaidProtocol(protocol)
      await connectTunnelOnly(protocol, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }, [connectTunnelOnly])

  /** Error-state retry when the payment succeeded but the tunnel didn't come up. */
  const retryTunnel = useCallback(async (dnsFallback = false) => {
    if (!paidProtocol) return
    setConnecting(true)
    setError(null)
    try {
      await connectTunnelOnly(paidProtocol, dnsFallback)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }, [paidProtocol, connectTunnelOnly])

  /**
   * Disconnect with the error surfaced instead of swallowed (the audited
   * catch-less handleDisconnect bug). Returns whether it succeeded, so the
   * caller only closes its modal on true.
   */
  const disconnect = useCallback(async (): Promise<boolean> => {
    setDisconnecting(true)
    try {
      await window.api.connectionDisconnect()
      setTunnelConnected(false)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed')
      return false
    } finally {
      setDisconnecting(false)
    }
  }, [])

  /** Drop the paid-session context: the "start over" action after an error. */
  const reset = useCallback(() => {
    setError(null)
    setCurrentStep(null)
    setStepDetail(null)
    setSessionId(null)
    setPaidProtocol(null)
    setTunnelConnected(false)
  }, [])

  return {
    connecting,
    currentStep,
    stepDetail,
    error,
    tunnelConnected,
    sessionId,
    paidProtocol,
    disconnecting,
    start,
    retryTunnel,
    disconnect,
    reset,
  }
}
