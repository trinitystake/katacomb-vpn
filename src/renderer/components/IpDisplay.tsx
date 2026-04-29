import { useState, useEffect, useCallback, useRef } from 'react'
import type { IpInfo } from '../types'
import Spinner from './Spinner'
import { useSettings } from '../contexts/SettingsContext'

interface Props {
  connected: boolean
}

export default function IpDisplay({ connected }: Props) {
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [revealed, setRevealed] = useState(false)
  const prevConnected = useRef(connected)
  const [ipStale, setIpStale] = useState(false)
  const { settings } = useSettings()
  const pollSec = settings?.pollIpSec ?? 60

  const fetchIp = useCallback(async (retries = 2, includeGeo = true) => {
    setLoading(true)
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await window.api.networkGetIp(includeGeo)
        setIpInfo((prev) => {
          // If polled refresh returned no geo but we had geo before and the IP
          // didn't change, preserve the existing geo instead of blanking it.
          if (!includeGeo && prev && prev.ip === result.ip) {
            return { ...prev, ip: result.ip }
          }
          return result
        })
        setIpStale(false)
        setLoading(false)
        return
      } catch {
        if (i < retries) {
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
    setIpStale(false)
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchIp()
  }, [fetchIp])

  useEffect(() => {
    if (connected !== prevConnected.current) {
      prevConnected.current = connected
      setRevealed(false)
      setIpStale(true)
      setLoading(true)
      const delay = connected ? 1500 : 1000
      const timer = setTimeout(() => fetchIp(2, true), delay)
      return () => clearTimeout(timer)
    }
  }, [connected, fetchIp])

  // Polled refresh — only when the window is visible and the VPN isn't
  // connected (connection-change effect above already refreshes on transitions).
  useEffect(() => {
    if (connected) return
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchIp(0, false)
      }
    }, pollSec * 1000)
    return () => clearInterval(interval)
  }, [connected, fetchIp, pollSec])

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
