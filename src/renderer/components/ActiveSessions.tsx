import { useEffect, useMemo, useRef, useState } from 'react'
import { useConnection } from '../hooks/useConnection'
import { usePlansContext } from '../contexts/PlansContext'
import { formatBytes as formatPlanBytes, formatDuration as formatPlanDuration } from '../utils/format'
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

/** One session's row: the chain's record plus what its gauges should read. */
interface Row {
  session: SessionInfo
  usage: SessionUsage
}

/** What a session's gauges show: on-chain baseline plus this tunnel's live meter. */
interface SessionUsage {
  downloadBytes: number
  uploadBytes: number
  seconds: number
}

export default function ActiveSessions({ sessions, loading, refreshing, refresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { status, refresh: refreshConnection } = useConnection()
  const { overview: { allocations } } = usePlansContext()
  const reconnect = useReconnect()
  const vpnConnected = status.state === 'connected'
  // Refresh asks the chain, and WALLET_SESSIONS returns lastKnownSessions verbatim
  // while isVpnActive() — so while our own tunnel carries the traffic the button is a
  // silent no-op, which reads as a broken control. Proxy mode leaves routing alone, so
  // the RPC endpoint stays reachable there and the refresh still does something real.
  const chainFrozen = vpnConnected && !status.proxyMode
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
  // The highest usage already shown for each session id. Usage only ever increases
  // on chain, so flooring the display at it states no more than the truth — it is
  // the same rule the main process applies with lastSessionUsage.
  const shownUsage = useRef(new Map<string, SessionUsage>())

  // Each row's usage, floored. Two sources feed these gauges and they do NOT hand
  // over at the same instant: the live half (interface counters + connectedAt)
  // vanishes the moment the 3s status poll reports the tunnel down, while the row
  // carrying the main process's remembered figure is a chain round-trip behind it.
  // In that ~1-2s gap the card fell back to the pre-connect baseline, so the time
  // gauge visibly dropped from 8m to 3m and then jumped back to 8m. The bytes gauge
  // had the identical flicker. Both close by never letting a reading go backwards.
  const rows = ordered.map((session) => {
    // Both halves of a chain carry the SAME byte stream and the same wall-clock,
    // and both nodes meter it — which is why main scores both quotas off one
    // counter. Attributing the live meter to both rows is therefore the truth, not
    // double-counting; giving it only to the entry would show the exit frozen.
    const live = vpnConnected &&
      (status.sessionId === session.id || status.chainExit?.sessionId === session.id)
    const reading: SessionUsage = {
      downloadBytes: (parseInt(session.downloadBytes || '0', 10) || 0) + (live ? liveStats.rxBytes : 0),
      uploadBytes: (parseInt(session.uploadBytes || '0', 10) || 0) + (live ? liveStats.txBytes : 0),
      // Time is measured exactly like bytes: what the chain has already metered,
      // plus what THIS tunnel has done since it came up.
      //
      // NOT wall-clock since startAt. The chain meters `duration` from the node's
      // usage proofs, so a session you bought but never connected to accrues
      // nothing — mainnet #53647217 sat 53 minutes at `duration: 0` while this card
      // read "47m / 1h 0m, 79.4%", an entire paid hour shown as spent.
      seconds: (session.durationSeconds ?? 0) +
        (live && status.connectedAt ? Math.max(0, (Date.now() - status.connectedAt) / 1000) : 0),
    }
    const floor = shownUsage.current.get(session.id)
    const usage: SessionUsage = floor
      ? {
          downloadBytes: Math.max(reading.downloadBytes, floor.downloadBytes),
          uploadBytes: Math.max(reading.uploadBytes, floor.uploadBytes),
          seconds: Math.max(reading.seconds, floor.seconds),
        }
      : reading
    return { session, usage }
  })
  // Rebuilt from the current rows every render, so a settled session's entry leaves
  // with its row instead of accumulating. Writing the ref here rather than in an
  // effect is safe: Math.max is idempotent, so a re-invoked render produces exactly
  // the same map.
  shownUsage.current = new Map(rows.map((r) => [r.session.id, r.usage]))

  // A chain is two paid sessions carrying ONE tunnel, so it is drawn as ONE card:
  // entry on top, exit below, one pair of actions. As two cards it read as two
  // unrelated VPNs and offered "End" on each — and ending either kills the tunnel
  // and strands the other hop's deposit. The pair is joined on chainPeerSessionId,
  // and the ROLE decides the order, not the order the chain returned them in.
  const byId = new Map(rows.map((r) => [r.session.id, r]))
  const claimed = new Set<string>()
  const groups: { entry: Row; exit: Row | null }[] = []
  for (const row of rows) {
    if (claimed.has(row.session.id)) continue
    claimed.add(row.session.id)
    const peer = row.session.chainPeerSessionId ? byId.get(row.session.chainPeerSessionId) : undefined
    // A peer that has already settled off the list leaves a lone hop; it still says
    // it is part of a chain, so the card can explain why it carries no traffic.
    if (!peer || claimed.has(peer.session.id)) {
      groups.push({ entry: row, exit: null })
      continue
    }
    claimed.add(peer.session.id)
    const rowIsEntry = row.session.chainRole !== 'exit'
    groups.push({ entry: rowIsEntry ? row : peer, exit: rowIsEntry ? peer : row })
  }

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
    // A chain is two paid sessions carrying one tunnel: ending either half kills
    // it, and leaving the other half open just strands its deposit until the chain
    // reaps it. So End on a chain row ends BOTH, and says so before it does.
    const peer = session.chainPeerSessionId
      ? sessions.find((s) => s.id === session.chainPeerSessionId) ?? null
      : null
    const isThisSessionConnected = vpnConnected &&
      (status.sessionId === session.id || status.chainExit?.sessionId === session.id)
    // When ending a *different* session than the one we're on, the tunnel is only
    // torn down to reach the chain — capture the live session so we can restore it.
    const reconnectTarget = vpnConnected && !isThisSessionConnected
      ? sessions.find((s) => s.id === status.sessionId) ?? null
      : null
    const vpnWarning = reconnectTarget
      ? '\n\nNote: Your current VPN connection will be temporarily interrupted to reach the blockchain, then reconnected.'
      : ''
    const chainWarning = peer
      ? `\n\nThis is the ${session.chainRole ?? 'first'} hop of a two-hop chain, so #${peer.id} will be ended too. One hop alone carries no traffic.`
      : ''
    if (!confirm(`End session #${session.id}? This will close the session on-chain. Remaining data/time will be forfeited.${chainWarning}${vpnWarning}`)) {
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
      // Sequential, not parallel: both are txs from one account and would collide
      // on the sequence number. A failure here still leaves the first one ended.
      if (peer && peer.status === 'active') await window.api.walletEndSession(peer.id)
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
        ? `${endError}. Reconnect also failed: ${result.error}`
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
          disabled={refreshing || chainFrozen}
          className="text-text-secondary text-xs hover:text-accent transition-colors flex items-center gap-1 disabled:opacity-50"
          title={chainFrozen
            ? 'Unavailable while connected: the chain is unreachable through the tunnel, so this list is the one from before you connected. The connected session keeps updating from live traffic.'
            : 'Reload sessions from the chain'}
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
                    {/* Plan bytes are decimal on chain, so the shared plan formatter. */}
                    {formatPlanBytes(a.planBytes)} · {formatPlanDuration(a.planDurationSeconds)}
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
          {groups.map(({ entry: entryRow, exit: exitRow }) => {
            const session = entryRow.session
            const isChain = exitRow !== null
            // Both hops carry the same stream, so their meters should agree — but
            // they settle independently, and the chain ends when EITHER runs out.
            // Score the card off whichever hop is further along, which is the same
            // "worst verdict wins" rule the main process applies to the quotas.
            const usage: SessionUsage = exitRow
              ? {
                  downloadBytes: Math.max(entryRow.usage.downloadBytes, exitRow.usage.downloadBytes),
                  uploadBytes: Math.max(entryRow.usage.uploadBytes, exitRow.usage.uploadBytes),
                  seconds: Math.max(entryRow.usage.seconds, exitRow.usage.seconds),
                }
              : entryRow.usage
            const isBusy = busy === session.id
            const isConnectedSession = vpnConnected &&
              (status.sessionId === session.id || status.chainExit?.sessionId === session.id ||
                (exitRow !== null && status.chainExit?.sessionId === exitRow.session.id))
            const downloadBytes = String(Math.round(usage.downloadBytes))
            const uploadBytes = String(Math.round(usage.uploadBytes))
            const dataPct = usagePercent(downloadBytes, session.maxBytes)
            // A session is metered on data (per-GB, maxBytes>0), on time
            // (per-hour, maxDuration>0), or both (plan). Show a gauge only for a
            // cap that exists, so the bar tracks the metric that's actually billed.
            const maxBytesNum = parseInt(session.maxBytes, 10)
            const hasByteCap = !isNaN(maxBytesNum) && maxBytesNum > 0
            const hasTimeCap = session.maxDurationSeconds !== null && session.maxDurationSeconds > 0
            const meteredSeconds = usage.seconds
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
            // For a chain, EITHER hop ending finishes it: one hop alone carries no
            // traffic, so offering Connect on the survivor would sell a dead tunnel.
            const isEnded = session.status !== 'active' ||
              (exitRow !== null && exitRow.session.status !== 'active')
            // 'active' does NOT mean 'usable'. The chain keeps metering a session
            // past what it was paid for and leaves the row active until someone
            // cancels it or the EndBlocker reaps it — #53647217 read duration
            // 5673s against a paid 3600s, status 1, with Connect still offered.
            // Connecting there costs a handshake and a password prompt to bring up
            // a tunnel the quota watchdog stands down at its next 15s tick. End is
            // the action that fits, and it stays enabled.
            const quotaUsedUp = (hasTimeCap && timePct >= 100) || (hasByteCap && dataPct >= 100)
            // `inactiveAt` means two different things depending on status — both
            // measured against mainnet, where statusTimeout is 7200s:
            //   ended  (2): fixed at statusAt + 2h — when the chain settles it and
            //               this row disappears of its own accord.
            //   active (1): an idle deadline pinned at (last node proof + 2h). Each
            //               MsgUpdateSession jumps it back to two hours out; between
            //               proofs it just ticks down. #53647217 read inactiveAt
            //               06:24:52Z = its one and only proof at 04:24:52Z + 7200s,
            //               which is where the earlier "slid 74.5 min" reading came
            //               from — one jump, not a smooth slide. Since quota is
            //               proof-metered, this is the only clock on an idle session.
            // For a chain, the sooner of the two: the tunnel stops when EITHER hop
            // is reaped, so the later deadline would promise time that isn't there.
            const inactiveAtMs = [session.inactiveAt, exitRow?.session.inactiveAt]
              .filter((v): v is string => typeof v === 'string')
              .map((v) => new Date(v).getTime())
            const inactiveInSeconds = inactiveAtMs.length
              ? Math.floor((Math.min(...inactiveAtMs) - Date.now()) / 1000)
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
                    {isChain ? (
                      <span className={`text-sm font-semibold ${isConnectedSession ? 'text-success' : 'text-accent'}`}>
                        Multi-hop chain
                      </span>
                    ) : (
                      <span className={`text-sm font-semibold font-mono ${isConnectedSession ? 'text-success' : 'text-accent'}`}>
                        #{session.id}
                      </span>
                    )}
                    {isConnectedSession && (
                      <span className="text-success text-xs border border-success px-1.5 py-0.5 rounded-sm font-medium">
                        Connected
                      </span>
                    )}
                    {!isChain && session.chainPeerSessionId && (
                      <span
                        className="text-warning text-xs border border-warning px-1.5 py-0.5 rounded-sm font-medium"
                        title={`This was the ${session.chainRole ?? 'first'} hop of a chain with #${session.chainPeerSessionId}, which is no longer listed. One hop alone carries no traffic.`}
                      >
                        Chain {session.chainRole ?? 'hop'} · partner gone
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
                            disabled={isBusy || busy !== null || vpnConnected || quotaUsedUp}
                            className="btn btn-primary text-xs px-3 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={
                              quotaUsedUp
                                ? 'This session has used everything it was paid for. End it and start a new one'
                                : vpnConnected
                                  ? 'Disconnect current VPN first'
                                  : isChain
                                    ? 'Rebuilds both hops of the chain'
                                    : 'Resume this session on the same node. No new transaction.'
                            }
                          >
                            {/* Not "Connect chain" / "End both": the card is headed
                                "Multi-hop chain" and lists both hops right below, so the
                                qualifier repeated what the row already said. What the
                                labels used to carry is still carried, and more precisely
                                — the title here, and for End a confirm that names the
                                peer session it is about to close. */}
                            {isBusy ? <Spinner /> : 'Reconnect'}
                          </button>
                        )}
                        <button
                          onClick={() => handleEndSession(session)}
                          disabled={isBusy || busy !== null}
                          className="btn btn-danger text-xs px-3 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                          title={isChain ? 'Ends both hops. One hop alone carries no traffic.' : undefined}
                        >
                          {isBusy ? <Spinner /> : 'End'}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Row 2: the hop(s). Order is fixed — entry above exit — because
                    that is the order the traffic travels, and it is the only cue
                    that says which node sees the user's IP and which sees the
                    destinations. */}
                {isChain ? (
                  <div className="mb-2 space-y-1">
                    <HopLine role="entry" session={entryRow.session} usage={entryRow.usage} />
                    <div className="text-text-tertiary text-xs pl-[52px]">↓ tunnelled inside the entry hop</div>
                    <HopLine role="exit" session={exitRow!.session} usage={exitRow!.usage} />
                  </div>
                ) : (
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
                )}

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
                      {/* A chain costs the sum of its hops; showing one hop's price
                          understates what was actually spent by half. */}
                      {isChain ? 'Price (both hops): ' : 'Price: '}
                      <span className="font-mono">
                        {((parseInt(session.priceValue, 10) +
                          (exitRow ? parseInt(exitRow.session.priceValue || '0', 10) : 0)) / 1e6).toFixed(2)}
                      </span> P2P
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
                      ? isChain
                        ? `Ended. Both hops settle on chain in about ${formatDuration(inactiveInSeconds)}, then they leave this list.`
                        : `Ended. The chain settles this in about ${formatDuration(inactiveInSeconds)}, then it leaves this list.`
                      : isChain
                        ? 'Ended. Both hops are settling on chain, then they leave this list.'
                        : 'Ended. Settling on chain, then it leaves this list.'}
                  </div>
                )}

                {/* The use-it-or-lose-it clock. Quota is metered from the node's
                    proofs, so an unused session burns none of it — this deadline is
                    the only thing actually counting down on an idle session.
                    It is NOT a smooth slide: it is pinned at (last node proof +
                    statusTimeout), so every proof jumps it back to two hours out and
                    it ticks down in real time in between. That means it keeps falling
                    while you are "connected" to a tunnel the node is not seeing — the
                    wording has to hold in that case too, so it names the node's
                    reports rather than the user's intent. */}
                {!isEnded && inactiveInSeconds !== null && inactiveInSeconds > 0 && (
                  <div
                    className="text-text-tertiary text-xs mt-2"
                    title="The chain reaps a session the node stops reporting usage for. Every usage report pushes this deadline back, so it only really counts down when nothing is getting through."
                  >
                    Expires in {formatDuration(inactiveInSeconds)} unless the {isChain ? 'nodes report' : 'node reports'} usage.
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

/**
 * One hop of a chain. The role label is the point of the whole row: "entry" is the
 * node that sees the user's IP, "exit" is the one that sees where they go, and the
 * card is unreadable without knowing which is which.
 */
function HopLine({ role, session, usage }: {
  role: 'entry' | 'exit'
  session: SessionInfo
  usage: SessionUsage
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-text-tertiary text-[10px] uppercase tracking-wide w-[44px] shrink-0">
        {role}
      </span>
      <span className="text-accent font-mono text-xs shrink-0">#{session.id}</span>
      {session.nodeMoniker && (
        <span className="text-text-primary font-medium truncate">{session.nodeMoniker}</span>
      )}
      {session.nodeCountry && (
        <span className="text-text-secondary shrink-0">{session.nodeCountry}</span>
      )}
      <span
        className="text-text-tertiary truncate cursor-pointer hover:text-accent transition-colors font-mono text-xs"
        title={`Click to copy: ${session.nodeAddress}`}
        onClick={() => navigator.clipboard.writeText(session.nodeAddress)}
      >
        {session.nodeAddress.slice(0, 16)}...{session.nodeAddress.slice(-6)}
      </span>
      {/* Each hop's OWN metered figure. The card's gauge shows the worse of the two,
          which is what governs the chain — but the hops settle independently and can
          land well apart (a live chain finished on 29.1 MB against 4.5 MB), so a
          single number with no breakdown looks like an error rather than a fact. */}
      <span className="ml-auto shrink-0 text-text-tertiary font-mono text-xs">
        {formatBytes(String(Math.round(usage.downloadBytes)))}
      </span>
    </div>
  )
}
