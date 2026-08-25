import { useState, useEffect, useCallback, useRef } from 'react'
import type { IpInfo } from '../types'
import Spinner from './Spinner'

const POLL_IP_MS = 60_000

interface Props {
  connected: boolean
  /** Active session id, so a session-to-session change refreshes too. */
  sessionId?: string | null
}

export default function IpDisplay({ connected, sessionId }: Props) {
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [revealed, setRevealed] = useState(false)
  // The connection's identity, not just its existence: switching sessions without
  // this component seeing `connected` go false (the status poll can miss a fast
  // disconnect-connect) must still refetch, or the previous tunnel's exit IP stays
  // on screen in the green connected style. Ignore the id while disconnected, so
  // idle session-list churn doesn't refetch anything.
  const connKey = connected ? `up:${sessionId ?? ''}` : 'idle'
  const prevKey = useRef(connKey)
  const [ipStale, setIpStale] = useState(false)

  // Two stages so the IP is on screen as fast as the network allows. Stage 1 is
  // the IP itself (icanhazip, ~100ms, unmetered) — retried, rendered the moment
  // it lands, and the thing whose total failure means "unreachable". Stage 2 is
  // the geo enrichment (ipapi.co), best-effort and never retried: its free tier
  // meters the SOURCE address, which through a tunnel is the exit node's shared
  // IP, so on a busy node it answers 429 more often than not. Blocking the IP on
  // it was most of why the refresh felt slow.
  //
  // `clearOnFailure` is set only by the connect/disconnect effect below. Keeping
  // the previous answer there would leave the IP from BEFORE the transition on
  // screen — i.e. the user's real IP, in the green "connected" style, which reads
  // as proof the tunnel is up when it is in fact the proof it is not. A transient
  // blip on the idle poll or a manual refresh still keeps the last good value.
  const fetchIp = useCallback(async (retries = 2, includeGeo = true, clearOnFailure = false) => {
    setLoading(true)
    let ip = ''
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await window.api.networkGetIp(false)
        // Main reports an unreachable lookup as an empty ip rather than throwing
        // (it is not a fault worth a stack trace) — retry it like any other miss.
        if (!result.ip) throw new Error('no ip')
        ip = result.ip
        setIpInfo((prev) => {
          // Same IP as before: keep the geo already on screen. A different IP
          // makes the old geo wrong, so it blanks until stage 2 refills it.
          if (prev && prev.ip === ip) return { ...prev, ip }
          return { ip, country: '', city: '', asn: '', org: '' }
        })
        setIpStale(false)
        setLoading(false)
        break
      } catch {
        if (i < retries) {
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
    if (!ip) {
      if (clearOnFailure) setIpInfo(null)
      setIpStale(false)
      setLoading(false)
      return
    }
    if (includeGeo) {
      const geo = await window.api.networkGetIp(true).catch(() => null)
      // Apply only while the shown IP is still the one it describes — a
      // transition mid-lookup would otherwise pin the wrong location on it.
      if (geo?.ip) setIpInfo((prev) => (prev && prev.ip === geo.ip ? geo : prev))
    }
  }, [])

  useEffect(() => {
    fetchIp()
  }, [fetchIp])

  useEffect(() => {
    if (connKey !== prevKey.current) {
      prevKey.current = connKey
      setRevealed(false)
      setIpStale(true)
      setLoading(true)
      // No settle delay: `connected` flips at interface-up at the earliest,
      // when the tunnel is already routing traffic (usually later, at the
      // verified push), and the retry ladder above absorbs whatever the
      // transition still has in flight — a fixed pause only added latency.
      fetchIp(2, true, true)
    }
  }, [connKey, fetchIp])

  // Polled refresh — only when the window is visible and the VPN isn't
  // connected (connection-change effect above already refreshes on transitions).
  useEffect(() => {
    if (connected) return
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchIp(0, false)
      }
    }, POLL_IP_MS)
    return () => clearInterval(interval)
  }, [connected, fetchIp])

  const shouldBlur = !connected && !revealed
  const ip = ipInfo?.ip
  const geoLabel = ipInfo?.country ? `${ipInfo.country}${ipInfo.city ? `, ${ipInfo.city}` : ''}` : ''

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-text-secondary">IP:</span>
      {loading || ipStale ? (
        <span className="flex items-center gap-1 text-text-secondary">
          <Spinner /> checking...
        </span>
      ) : connected && !ip ? (
        // Connected, and three attempts could not reach the IP service through
        // the tunnel. That is the signature of a tunnel that is up but carrying
        // nothing, so say so rather than showing a reassuring blank.
        <span className="text-danger" title="Could not reach the internet through the tunnel. It may be up but not passing traffic.">
          unreachable
        </span>
      ) : (
        <span
          className={`font-mono ${connected ? 'text-success' : 'text-text-primary'} ${shouldBlur ? 'blur-sm select-none' : ''}`}
          title={ipInfo?.org ? `${ipInfo.org} (${ipInfo.asn})` : undefined}
        >
          {ip || '—'}
          {geoLabel && !shouldBlur && (
            <span className="text-text-secondary ml-1 font-sans">({geoLabel})</span>
          )}
        </span>
      )}
      {!connected && !loading && ip && (
        <button
          onClick={() => setRevealed((v) => !v)}
          className="text-text-secondary hover:text-accent transition-colors"
          title={revealed ? 'Hide IP' : 'Reveal IP'}
        >
          {revealed ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 2l12 12" />
              <path d="M4.5 4.5C3.1 5.5 2 7 2 8s2 4 6 4c1.3 0 2.4-.4 3.3-1" />
              <path d="M9.5 6.5a2 2 0 0 1-3 3" />
              <path d="M14 8c0-1-2-4-6-4-.7 0-1.3.1-1.9.3" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
          )}
        </button>
      )}
      <button
        onClick={() => fetchIp(0)}
        disabled={loading}
        className="text-text-secondary hover:text-accent transition-colors disabled:opacity-30"
        title="Refresh IP"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M1 1v5h5" />
          <path d="M3.5 10a5.5 5.5 0 1 0 1-7.5L1 6" />
        </svg>
      </button>
    </div>
  )
}
