import { useCallback, useEffect, useRef, useState } from 'react'
import type { LeaseSummary, MyPlan, MyProvider, ProviderEconomics, ProviderOverview } from '../types'

/** What the fetch produced, tagged with the wallet it belongs to. */
interface ProviderData {
  address: string
  /**
   * null = main had nothing safe to show (tunnel up, no cache for this wallet).
   * Recorded rather than ignored so `loading` can settle: the console renders
   * its own "disconnect to manage" pane for it.
   */
  overview: ProviderOverview | null
}

export interface ProviderState {
  provider: MyProvider | null
  plans: MyPlan[]
  leases: LeaseSummary[]
  economics: ProviderEconomics | null
  /** True when the data is main's memory of the last good read (chain unreachable). */
  stale: boolean
  /** When the data was actually read from the chain. null before the first answer. */
  fetchedAt: number | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  visible: boolean
}

/**
 * The provider console's data: one PROVIDER_OVERVIEW round-trip (provider record,
 * plans, leases, economics, staleness). Deliberately NOT polled: provider actions
 * are rare and deliberate, and each one calls `refresh()` itself — a background
 * poll would only burn RPC calls. It IS re-read whenever the wallet changes (a
 * different seed is a different provider) and when the tunnel state flips: on
 * connect the re-read swaps to main's cached answer marked `stale` (the tab goes
 * read-only rather than blank), on disconnect it swaps back to a live read.
 *
 * A `null` overview never clobbers data already shown — main only answers null
 * when it has no cache for this wallet, so there is nothing newer to replace it
 * with, and the tab must not vanish mid-session.
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
 */
export function useProvider(
  address: string | null,
  tunnelUp: boolean,
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
    if (!address) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const overview = await window.api.providerOverview()
      if (wanted.current !== address) return
      setData((prev) => {
        // Keep what is on screen when main has nothing newer: a null answer only
        // happens with the tunnel up and no cache, never after a good read.
        if (!overview && prev?.address === address && prev.overview) return prev
        return { address, overview }
      })
      setFailure(null)
    } catch (e) {
      if (wanted.current !== address) return
      setFailure({ address, message: e instanceof Error ? e.message : 'Failed to load provider state' })
    } finally {
      if (wanted.current === address) setLoading(false)
    }
    // tunnelUp is a real dependency: its flip is what swaps the tab between the
    // live answer and main's stale cache.
  }, [address, tunnelUp])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const current = data?.address === address ? data : null
  const overview = current?.overview ?? null
  const provider = overview?.provider ?? null
  const error = failure?.address === address ? failure.message : null
  // Between the render that brings a new address and the effect that fetches for
  // it there is neither data nor an error — report that as loading, or the console
  // flashes its "could not read your provider" branch on every wallet switch.
  const pending = Boolean(address) && !current && !error

  return {
    provider,
    plans: overview?.plans ?? [],
    leases: overview?.leases ?? [],
    economics: overview?.economics ?? null,
    stale: overview?.stale ?? false,
    fetchedAt: overview?.fetchedAt ?? null,
    loading: loading || pending,
    error,
    refresh,
    visible: providerMode ?? Boolean(provider?.registered),
  }
}
