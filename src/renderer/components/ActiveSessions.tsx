import { useState } from 'react'
import { useConnection } from '../hooks/useConnection'
import { usePlans } from '../hooks/usePlans'
import { useTrafficStats } from '../hooks/useTrafficStats'
import { useReconnect } from '../hooks/useReconnect'
import Spinner from './Spinner'
import type { SessionInfo } from '../types'

interface Props {
  sessions: SessionInfo[]
  loading: boolean
  refreshing: boolean
  refresh: () => Promise<void>
}

function formatBytes(bytes: string): string {
  const n = parseInt(bytes, 10)
  if (isNaN(n) || n === 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function timeAgo(isoString: string | null): string {
  if (!isoString) return '—'
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function usagePercent(downloaded: string, max: string): number {
  const d = parseInt(downloaded, 10)
  const m = parseInt(max, 10)
  if (isNaN(d) || isNaN(m) || m === 0) return 0
  return Math.min(100, (d / m) * 100)
}

function timePercent(elapsedSeconds: number, maxSeconds: number | null): number {
  if (!maxSeconds || maxSeconds <= 0 || elapsedSeconds <= 0) return 0
  return Math.min(100, (elapsedSeconds / maxSeconds) * 100)
}

export default function ActiveSessions({ sessions, loading, refreshing, refresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { status, refresh: refreshConnection } = useConnection()
  const { allocations } = usePlans()
  const reconnect = useReconnect()
  const vpnConnected = status.state === 'connected'
  // Live interface counter (bytes used this session). The on-chain session
  // counters are frozen while connected (RPC is unreachable through the tunnel)
  // and lag node settlement anyway, so the connected session's usage is driven
  // off this real-time meter instead.
  const liveStats = useTrafficStats(vpnConnected)

  async function handleReconnect(session: SessionInfo) {
    setBusy(session.id)
    setError(null)
    const result = await reconnect(session)
    if (!result.ok) setError(result.error || 'Reconnection failed')
    else await refreshConnection()
    setBusy(null)
  }

  async function handleEndSession(session: SessionInfo) {
    const isThisSessionConnected = vpnConnected && status.sessionId === session.id
    // When ending a *different* session than the one we're on, the tunnel is only
    // torn down to reach the chain — capture the live session so we can restore it.
    const reconnectTarget = vpnConnected && !isThisSessionConnected
      ? sessions.find((s) => s.id === status.sessionId) ?? null
      : null
    const vpnWarning = reconnectTarget
      ? '\n\nNote: Your current VPN connection will be temporarily interrupted to reach the blockchain, then reconnected.'
      : ''
    if (!confirm(`End session #${session.id}? This will close the session on-chain. Remaining data/time will be forfeited.${vpnWarning}`)) {
      return
    }

    setBusy(session.id)
    setError(null)

    let endError: string | null = null
    try {
      if (vpnConnected) {
        await window.api.connectionDisconnect()
        await refreshConnection()
        await new Promise((r) => setTimeout(r, 2000))
      }

      await window.api.walletEndSession(session.id)
      await refresh()
    } catch (err) {
      endError = err instanceof Error ? err.message : 'Failed to end session'
    }

    // Restore the tunnel we tore down only to reach the chain. Run this even if the
    // end failed — the reconnect target is unrelated to the ended session.
    if (reconnectTarget) {
      const result = await reconnect(reconnectTarget)
      if (result.ok) await refreshConnection()
      else endError = endError
        ? `${endError} — and reconnect failed: ${result.error}`
        : (result.error ?? 'Reconnection failed')
    }

    if (endError) setError(endError)
    setBusy(null)
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-text-secondary text-sm flex items-center gap-2">
          <Spinner />
          Loading sessions...
        </p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <h3 className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          Active Sessions ({sessions.length})
        </h3>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="text-text-secondary text-xs hover:text-accent transition-colors flex items-center gap-1"
        >
          {refreshing ? <Spinner className="text-accent" /> : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mx-5 mt-3 bg-danger-subtle border border-danger p-2 rounded-md shrink-0">
          <p className="text-danger text-sm">{error}</p>
        </div>
      )}

      {sessions.length === 0 && allocations.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-text-secondary text-sm">No active sessions</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {allocations.length > 0 && (
            <div className="space-y-1">
              <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide px-1">
                Plan Allocations ({allocations.length})
              </div>
              {allocations.map((a) => (
                <div
                  key={a.subscriptionId}
                  className="bg-bg-tertiary border border-border px-4 py-2 rounded-md"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-accent text-xs font-mono font-semibold">
                      sub #{a.subscriptionId}
                    </span>
                    <span className="text-text-secondary text-xs font-mono">
                      plan #{a.planId}
                    </span>
                  </div>
                  <div className="text-text-secondary text-xs mt-1">
                    {formatBytes(a.planBytes)} · {formatDuration(a.planDurationSeconds)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {sessions.length > 0 && allocations.length > 0 && (
            <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide px-1 pt-2">
              Sessions ({sessions.length})
            </div>
          )}
          {sessions.map((session) => {
            const isBusy = busy === session.id
            const isConnectedSession = vpnConnected && status.sessionId === session.id
            // For the live session, add the real-time interface counter to the
            // on-chain baseline (settled before this connect) so the gauge moves.
            const downloadBytes = isConnectedSession
              ? String(parseInt(session.downloadBytes || '0', 10) + liveStats.rxBytes)
              : session.downloadBytes
            const uploadBytes = isConnectedSession
              ? String(parseInt(session.uploadBytes || '0', 10) + liveStats.txBytes)
              : session.uploadBytes
            const dataPct = usagePercent(downloadBytes, session.maxBytes)
            // A session is metered on data (per-GB, maxBytes>0), on time
            // (per-hour, maxDuration>0), or both (plan). Show a gauge only for a
            // cap that exists, so the bar tracks the metric that's actually billed.
            const maxBytesNum = parseInt(session.maxBytes, 10)
            const hasByteCap = !isNaN(maxBytesNum) && maxBytesNum > 0
            const hasTimeCap = session.maxDurationSeconds !== null && session.maxDurationSeconds > 0
            // On-chain `duration` (elapsed) isn't settled for a live session, so
            // derive elapsed from wall-clock since startAt — the same reason bytes
            // use the live interface counter above. Recomputes each render (1s
            // while connected) so the time gauge ticks.
            const elapsedSeconds = session.startAt
              ? Math.max(0, Math.floor((Date.now() - new Date(session.startAt).getTime()) / 1000))
              : (session.durationSeconds ?? 0)
            const timePct = timePercent(elapsedSeconds, session.maxDurationSeconds)

            return (
              <div
                key={session.id}
                className={`bg-bg-tertiary border px-4 py-3 rounded-md ${
                  isConnectedSession ? 'border-success bg-success-subtle' : 'border-border'
                }`}
              >
                {/* Row 1: Session ID + Status + Actions */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-semibold font-mono ${isConnectedSession ? 'text-success' : 'text-accent'}`}>
                      #{session.id}
                    </span>
                    {isConnectedSession && (
                      <span className="text-success text-xs border border-success px-1.5 py-0.5 rounded-sm font-medium">
                        Connected
                      </span>
                    )}
                    {session.subscriptionId && (
                      <span className="text-text-secondary text-xs font-mono">
                        sub #{session.subscriptionId}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {!isConnectedSession && (
                      <button
                        onClick={() => handleReconnect(session)}
                        disabled={isBusy || busy !== null || vpnConnected}
                        className="btn btn-primary text-xs px-3 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                        title={vpnConnected ? 'Disconnect current VPN first' : undefined}
                      >
                        {isBusy ? <Spinner className="text-white" /> : 'Connect'}
                      </button>
                    )}
                    <button
                      onClick={() => handleEndSession(session)}
                      disabled={isBusy || busy !== null}
                      className="btn btn-danger text-xs px-3 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {isBusy ? <Spinner className="text-white" /> : 'End'}
                    </button>
                  </div>
                </div>

                {/* Row 2: Node info */}
                <div className="flex items-center gap-3 mb-2 text-sm">
                  {session.nodeMoniker && (
                    <span className="text-text-primary font-medium">{session.nodeMoniker}</span>
                  )}
                  {session.nodeCountry && (
                    <span className="text-text-secondary">{session.nodeCountry}</span>
                  )}
                  <span
                    className="text-text-tertiary truncate cursor-pointer hover:text-accent transition-colors font-mono text-xs"
                    title={`Click to copy: ${session.nodeAddress}`}
                    onClick={() => navigator.clipboard.writeText(session.nodeAddress)}
                  >
                    {session.nodeAddress.slice(0, 16)}...{session.nodeAddress.slice(-6)}
                  </span>
                </div>

                {/* Row 3: Data usage bar — only when the session is byte-metered (per-GB) */}
                {hasByteCap && (
                  <div className="mb-2">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text-secondary">
                        Data: {formatBytes(downloadBytes)} / {formatBytes(session.maxBytes)}
                        {isConnectedSession && <span className="text-success text-[10px] ml-1 align-middle">live</span>}
                      </span>
                      <span className={`font-mono ${dataPct > 90 ? 'text-danger' : dataPct > 70 ? 'text-warning' : 'text-text-secondary'}`}>
                        {dataPct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-bg-hover overflow-hidden rounded-full">
                      <div
                        className={`h-full transition-all rounded-full ${
                          dataPct > 90 ? 'bg-danger' : dataPct > 70 ? 'bg-warning' : 'bg-info'
                        }`}
                        style={{ width: `${dataPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Row 4: Time usage bar — only when the session is time-metered (per-hour) */}
                {hasTimeCap && (
                  <div className="mb-2">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text-secondary">
                        Time: {formatDuration(elapsedSeconds)} / {formatDuration(session.maxDurationSeconds)}
                        {isConnectedSession && <span className="text-success text-[10px] ml-1 align-middle">live</span>}
                      </span>
                      <span className={`font-mono ${timePct > 90 ? 'text-danger' : timePct > 70 ? 'text-warning' : 'text-text-secondary'}`}>
                        {timePct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-bg-hover overflow-hidden rounded-full">
                      <div
                        className={`h-full transition-all rounded-full ${
                          timePct > 90 ? 'bg-danger' : timePct > 70 ? 'bg-warning' : 'bg-info'
                        }`}
                        style={{ width: `${timePct}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Row 5: Meta info */}
                <div className="flex items-center gap-4 text-xs text-text-tertiary">
                  {session.startAt && (
                    <span>Started {timeAgo(session.startAt)}</span>
                  )}
                  {session.priceDenom && session.priceValue && (
                    <span>
                      Price: <span className="font-mono">{(parseInt(session.priceValue, 10) / 1e6).toFixed(2)}</span> P2P
                    </span>
                  )}
                  {!hasByteCap && (
                    <span>
                      Down: <span className="font-mono">{formatBytes(downloadBytes)}</span>
                    </span>
                  )}
                  <span>
                    Up: <span className="font-mono">{formatBytes(uploadBytes)}</span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
