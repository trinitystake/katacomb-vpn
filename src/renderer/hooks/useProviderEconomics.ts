import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderEconomics } from '../types'

export interface ProviderEconomicsState {
  economics: ProviderEconomics | null
  loading: boolean
  /**
   * The read didn't produce usable figures. Callers must render "unavailable"
   * rather than falling back to zeroes: a provider shown 0 burn would conclude
   * their nodes are free, and one shown 0 revenue would conclude they earn nothing.
   */
  unavailable: boolean
  refresh: () => Promise<void>
}

/**
 * The provider's money picture: lease burn, escrow, and estimated plan income.
 *
 * Not polled, for the same reason useProvider isn't — these are chain reads behind
 * deliberate, infrequent actions, and every action refreshes them itself.
 *
 * Tagged with the address it was read for so a wallet switch never shows the
 * previous provider's money, and a slow answer landing after the switch is dropped.
 */
export function useProviderEconomics(address: string | null, enabled: boolean): ProviderEconomicsState {
  const [data, setData] = useState<{ address: string; economics: ProviderEconomics } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const wanted = useRef<string | null>(address)
  wanted.current = address

  const refresh = useCallback(async () => {
    if (!address || !enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const economics = await window.api.providerEconomics()
      if (wanted.current !== address) return
      // Null is the tunnel-is-up answer, which is an absence, not a zero.
      if (economics) {
        setData({ address, economics })
        setFailed(null)
      } else {
        setFailed(address)
      }
    } catch {
      if (wanted.current !== address) return
      setFailed(address)
    } finally {
      if (wanted.current === address) setLoading(false)
    }
  }, [address, enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const current = data?.address === address ? data.economics : null
  return {
    economics: current,
    loading,
    // `Boolean(address)` guards the no-wallet case: there both `failed` and
    // `address` are null, and a bare equality would report a failure that never
    // happened.
    unavailable: Boolean(address) && !loading && !current && failed === address,
    refresh,
  }
}
