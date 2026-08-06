import { useEffect, useMemo, useState } from 'react'
import { useConnection } from '../hooks/useConnection'
import { usePlans } from '../hooks/usePlans'
import { useTrafficStats } from '../hooks/useTrafficStats'
import { useReconnect } from '../hooks/useReconnect'
import Spinner from './Spinner'
import { displayConnectError } from '../utils/connect-errors'
import ChainUnreachable from './ChainUnreachable'
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
  // 0 renders as "0m", not "—": an unused session has genuinely used zero time,
  // and that is exactly the number the time gauge has to be able to show.
  if (seconds === null || seconds < 0) return '—'
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

  // Active first, then newest first. Sorting by startAt ALONE would not do what it
  // looks like it does: a session that just expired is newer than one still running,
  // so it would float to the top. Status has to be the primary key.
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => {
      const rank = (s: SessionInfo) => (s.status === 'active' ? 0 : 1)
      return rank(a) - rank(b) ||
        new Date(b.startAt || 0).getTime() - new Date(a.startAt || 0).getTime()
    }),
    [sessions],
  )
  // Counts the live ones. An ended row is still shown (it is settling on chain) but
  // it is not an active session, and counting it as one is what produced
  // "Active Sessions (2)" over a single running session.
  const activeCount = sessions.filter((s) => s.status === 'active').length
  // "ending" read as still-in-progress to the one person who has used this screen:
  // the session is over, what remains is the chain settling it. Match the row's own
  // "Ended" badge rather than inventing a second tense for the same state.
  const endedCount = sessions.length - activeCount
  const sessionCountLabel = `${activeCount} active${endedCount > 0 ? ` · ${endedCount} ended` : ''}`

  // Drop an ended row as soon as the chain settles it, rather than leaving it up to
  // two minutes (the useSessions poll) after it has ceased to exist. One timer for
  // the soonest deadline; the poll still covers everything else.
  const nextSettleMs = useMemo(() => {
    const times = sessions
      .filter((s) => s.status !== 'active' && s.inactiveAt)
      .map((s) => new Date(s.inactiveAt!).getTime())
    return times.length ? Math.min(...times) : null
  }, [sessions])

  useEffect(() => {
    if (nextSettleMs === null) return
    // +5s of slack so the EndBlocker has actually run by the time we re-read.
    const delay = Math.max(1000, nextSettleMs + 5000 - Date.now())
    const id = setTimeout(() => { void refresh() }, delay)
    return () => clearTimeout(id)
  }, [nextSettleMs, refresh])

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
          Sessions ({sessionCountLabel})
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
          <p className="text-danger text-sm">{displayConnectError(error)}</p>
        </div>
      )}

      {sessions.length === 0 && allocations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <p className="text-text-secondary text-sm">No active sessions</p>
          <ChainUnreachable what="this list" />
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
              Sessions ({sessionCountLabel})
            </div>
          )}
          {ordered.map((session) => {
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
            // Time is measured exactly like bytes above: what the chain has already
            // metered, plus what THIS tunnel has done since it came up.
            //
            // NOT wall-clock since startAt. The chain meters `duration` from the
            // node's usage proofs, so a session you bought but never connected to
            // accrues nothing — mainnet #53647217 sat 53 minutes at `duration: 0`
            // while this card read "47m / 1h 0m, 79.4%", an entire paid hour shown
            // as spent.
            const meteredSeconds = (session.durationSeconds ?? 0) +
              (isConnectedSession && status.connectedAt
                ? Math.max(0, (Date.now() - status.connectedAt) / 1000)
                : 0)
            // A node can meter slightly past the cap (#53634305 recorded 3618s of
            // 3600s), so clamp the READOUT to what was paid for.
            const elapsedSeconds = hasTimeCap
              ? Math.min(meteredSeconds, session.maxDurationSeconds!)
              : meteredSeconds
            const timePct = timePercent(meteredSeconds, session.maxDurationSeconds)
            // Anything but 'active' means the chain has already closed this session
            // (it ran out, or someone cancelled it) and it is settling. It can no
            // longer be cancelled or connected to — only watched until it drops off
            // the list.
            const isEnded = session.status !== 'active'
            // `inactiveAt` means two different things depending on status — both
            // measured against mainnet, where statusTimeout is 7200s:
            //   ended  (2): fixed at statusAt + 2h — when the chain settles it and
            //               this row disappears of its own accord.
            //   active (1): a SLIDING idle deadline that rolls forward as the node
            //               reports (observed moving 74.5 min on #53647217, ending
            //               up at startAt + 3.24h). Stop using the session and it is
            //               reaped 2h later. Since quota is proof-metered, this is
            //               the only clock running on an idle session.
            const inactiveInSeconds = session.inactiveAt
              ? Math.floor((new Date(session.inactiveAt).getTime() - Date.now()) / 1000)
              : null

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
                    {isEnded ? (
                      <span className="text-text-secondary text-xs border border-border px-1.5 py-0.5 rounded-sm font-medium">
                        Ended
                      </span>
                    ) : (
                      <>
                        {!isConnectedSession && (
                          <button
                            onClick={() => handleReconnect(session)}
                            disabled={isBusy || busy !== null || vpnConnected}
                            className="btn btn-primary text-xs px-3 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={vpnConnected ? 'Disconnect current VPN first' : undefined}
                          >
                            {isBusy ? <Spinner /> : 'Connect'}
                          </button>
                        )}
                        <button
                          onClick={() => handleEndSession(session)}
                          disabled={isBusy || busy !== null}
                          className="btn btn-danger text-xs px-3 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {isBusy ? <Spinner /> : 'End'}
                        </button>
                      </>
                    )}
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
                        Data used: {formatBytes(downloadBytes)} of {formatBytes(session.maxBytes)}
                        {isConnectedSession && <span className="text-success text-[10px] ml-1 align-middle">live</span>}
                      </span>
                      <span className={`font-mono ${dataPct > 90 ? 'text-danger' : dataPct > 70 ? 'text-warning' : 'text-text-secondary'}`}>
                        {dataPct >= 100 ? 'Used up' : `${dataPct.toFixed(1)}%`}
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
                      {/* "Time" alone read as wall-clock since purchase, which made a
                          correct 1m-of-1h look broken on a session bought an hour
                          earlier. Name what is actually metered, and explain it. */}
                      <span
                        className="text-text-secondary"
                        title={'Time spent connected to the node, not time since you paid.\n' +
                          'The chain meters it from the node\'s usage reports, so a session you leave idle stays where it is.'}
                      >
                        Time used: {formatDuration(elapsedSeconds)} of {formatDuration(session.maxDurationSeconds)}
                        {isConnectedSession && <span className="text-success text-[10px] ml-1 align-middle">live</span>}
                      </span>
                      <span className={`font-mono ${timePct > 90 ? 'text-danger' : timePct > 70 ? 'text-warning' : 'text-text-secondary'}`}>
                        {timePct >= 100 ? 'Used up' : `${timePct.toFixed(1)}%`}
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

                {/* Deliberately makes NO refund promise. Settlement pays the node for
                    what was actually used and returns only the remainder — and a
                    session that expired used its whole quota by definition, so there
                    is usually nothing to come back. */}
                {isEnded && (
                  <div className="text-text-tertiary text-xs mt-2">
                    {inactiveInSeconds !== null && inactiveInSeconds > 60
                      ? `Ended. The chain settles this in about ${formatDuration(inactiveInSeconds)}, then it leaves this list.`
                      : 'Ended. Settling on chain, then it leaves this list.'}
                  </div>
                )}

                {/* The use-it-or-lose-it clock. Quota is metered from the node's
                    proofs, so an unused session burns none of it — this deadline is
                    the only thing actually counting down on an idle session. It
                    slides forward while the session IS being used, hence "if unused":
                    it is a countdown that only really runs when you stop. */}
                {!isEnded && inactiveInSeconds !== null && inactiveInSeconds > 0 && (
                  <div className="text-text-tertiary text-xs mt-2">
                    Expires in {formatDuration(inactiveInSeconds)} if unused.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
