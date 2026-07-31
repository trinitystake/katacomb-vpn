import { useCallback, useEffect, useRef, useState } from 'react'
import { formatP2p, udvpnOf } from '../../shared/funds'

const POLL_MS = 30_000

/**
 * The one wallet-balance reader in the renderer.
 *
 * `udvpn` is null while the balance is UNKNOWN — the first fetch hasn't landed,
 * or main couldn't read one (it returns null rather than an empty balance, so an
 * unreachable RPC doesn't read as zero). Callers doing an affordability check
 * must treat null as "don't block the user": a false "insufficient funds" that
 * greys out the pay button is worse than letting main — which re-checks against a
 * fresh balance before broadcasting — decide.
 *
 * Note main returns its cached value while a tunnel is up, since the chain is
 * unreachable through it — so `udvpn` can be stale, never a hard gate.
 */
export function useBalance() {
  const [udvpn, setUdvpn] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const balances = await window.api.walletGetBalance()
      setUdvpn(balances === null ? null : udvpnOf(balances))
    } catch {
      setUdvpn(null)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    intervalRef.current = setInterval(refresh, POLL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [refresh])

  return {
    udvpn,
    /** '1.20', or null while unknown — render a placeholder, not '0.00'. */
    display: udvpn === null ? null : formatP2p(udvpn),
    refreshing,
    refresh,
  }
}
