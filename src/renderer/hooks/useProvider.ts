import { useCallback, useEffect, useRef, useState } from 'react'
import type { LeaseSummary, MyPlan, MyProvider } from '../types'

/** What the fetch produced, tagged with the wallet it belongs to. */
interface ProviderData {
  address: string
  provider: MyProvider | null
  plans: MyPlan[]
  leases: LeaseSummary[]
}

export interface ProviderState {
  provider: MyProvider | null
  plans: MyPlan[]
  leases: LeaseSummary[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  visible: boolean
}

/**
 * The provider console's data. Deliberately NOT polled: every field is read
 * straight from the chain, provider actions are rare and deliberate, and each one
 * calls `refresh()` itself — a background poll would only burn RPC calls. It IS
 * re-read whenever the wallet changes (a different seed is a different provider)
 * and when the tunnel drops.
 *
 * `visible` drives whether the Provider tab exists at all, and `providerMode` is
 * deliberately TRI-STATE for it. Undefined means the user has never touched the
 * setting, and then a provider registered on chain reveals the tab by itself, so
 * someone who registered elsewhere or restored a seed never has to go looking for
 * the switch. An explicit true or false is the user's decision and wins outright.
 *
 * It used to be `providerMode || registered`, which made the Settings toggle a
 * silent no-op the moment you registered: it saved, and the tab stayed anyway.
 * Discovering a provider is a good default; refusing to let it be hidden again is
 * not, so the fallback only applies while no choice has been recorded.
 *
 * The value comes from the wallet entry rather than app settings — as a global
 * setting it followed the user onto every seed imported after they first switched
 * it on.
 *
 * Everything is tagged with the address it was read for, so a wallet switch shows
 * nothing rather than the previous wallet's provider, and a slow response that
 * lands after the switch is discarded instead of overwriting the new wallet's.
 *
 * `enabled` is false while the tunnel is up — the chain isn't reachable through it
 * and the main-process reads answer `null`/`[]` by design. Skipping the read (and
 * keeping the last answer) is what stops the tab from vanishing mid-session.
 */
export function useProvider(
  address: string | null,
  enabled: boolean,
  /** undefined = never set, so the chain decides. true/false = the user decided. */
  providerMode: boolean | undefined,
): ProviderState {
  const [data, setData] = useState<ProviderData | null>(null)
  const [failure, setFailure] = useState<{ address: string; message: string } | null>(null)
  const [loading, setLoading] = useState(true)
  // The main process resolves the wallet at call time, so a read that started
  // before a switch answers for the NEW wallet under the old address. Drop any
  // result that comes back after the address moved — the switch fired its own.
  const wanted = useRef<string | null>(address)
  wanted.current = address

  const refresh = useCallback(async () => {
    if (!address || !enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const me = await window.api.providerMe()
      const [plans, leases] = me?.registered
        ? await Promise.all([window.api.providerPlans(), window.api.leaseList()])
        : [[], []]
      if (wanted.current !== address) return
      setData({ address, provider: me, plans, leases })
      setFailure(null)
    } catch (e) {
      if (wanted.current !== address) return
      setFailure({ address, message: e instanceof Error ? e.message : 'Failed to load provider state' })
    } finally {
      if (wanted.current === address) setLoading(false)
    }
  }, [address, enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const current = data?.address === address ? data : null
  const provider = current?.provider ?? null
  const error = failure?.address === address ? failure.message : null
  // Between the render that brings a new address and the effect that fetches for
  // it there is neither data nor an error — report that as loading, or the console
  // flashes its "could not read your provider" branch on every wallet switch.
  const pending = Boolean(address) && enabled && !current && !error

  return {
    provider,
    plans: current?.plans ?? [],
    leases: current?.leases ?? [],
    loading: loading || pending,
    error,
    refresh,
    visible: providerMode ?? Boolean(provider?.registered),
  }
}
