import { useState, useEffect } from 'react'
import type { TrafficStats } from '../types'

const ZERO: TrafficStats = { rxBytes: 0, txBytes: 0, rxSpeed: 0, txSpeed: 0 }

/**
 * Poll the live VPN interface byte counters (1s) while connected. rxBytes/txBytes
 * are cumulative-since-connect (the main process resets the baseline on each
 * connect), i.e. "used this session". Returns zeros when not connected.
 */
export function useTrafficStats(connected: boolean): TrafficStats {
  const [stats, setStats] = useState<TrafficStats>(ZERO)

  useEffect(() => {
    if (!connected) {
      setStats(ZERO)
      return
    }
    let active = true
    const poll = async () => {
      try {
        const s = await window.api.trafficStats()
        if (active) setStats(s)
      } catch { /* silent */ }
    }
    poll()
    const id = setInterval(poll, 1000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [connected])

  return stats
}
