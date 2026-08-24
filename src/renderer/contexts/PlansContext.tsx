import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import type { PlanOverview, DiscoverProgress } from '../types'

// One slow backstop; the real refresh triggers are pushes (onSessionsChanged)
// and explicit actions. While the tunnel is up main answers from memory with
// stale: true, so the poll costs nothing there.
const BACKSTOP_POLL_MS = 300_000
// A catalog older than this triggers one automatic rescan on mount.
const AUTO_DISCOVER_STALE_MS = 6 * 3600_000
const DISCOVER_MAX = 500

const EMPTY_OVERVIEW: PlanOverview = {
  plans: [],
  fetchedAt: null,
  subscriptions: [],
  allocations: [],
  stale: false,
}

interface PlansContextValue {
  /** The last PLAN_OVERVIEW answer; `stale` means its chain half is a memory. */
  overview: PlanOverview
  /** True until the first overview answer lands. */
  loading: boolean
  discovering: boolean
  progress: DiscoverProgress | null
  /** Why the last user-initiated rescan failed, or null. */
  discoverError: string | null
  refreshOverview: () => Promise<void>
  /** Full on-chain rescan of the plan catalog. */
  discover: () => Promise<void>
}

const PlansContext = createContext<PlansContextValue | null>(null)

/**
 * App-level plan state, the NodesContext pattern: mounted above the tab so a
 * tab switch doesn't destroy it, push-driven rather than stacked polls (the
 * retired usePlans hook ran two independent 120s allocation polls). A wallet
 * switch reloads the window (Settings.onWalletSwitch), which remounts this
 * provider, and main clears its own overview memory on WALLET_SWITCH.
 */
export function PlansProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<PlanOverview>(EMPTY_OVERVIEW)
  const [loading, setLoading] = useState(true)
  const [discovering, setDiscovering] = useState(false)
  const [progress, setProgress] = useState<DiscoverProgress | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const autoDiscovered = useRef(false)

  const refreshOverview = useCallback(async () => {
    try {
      const res = await window.api.planOverview()
      setOverview(res)
    } catch {
      // Unreachable by design (the handler degrades to its cache), but an IPC
      // failure must not blank the tab: keep what is shown, mark it stale.
      setOverview((prev) => ({ ...prev, stale: true }))
    } finally {
      setLoading(false)
    }
  }, [])

  const discover = useCallback(async () => {
    setDiscovering(true)
    setDiscoverError(null)
    setProgress({ done: 0, total: 0, phase: 'connecting' })
    try {
      await window.api.planDiscover(DISCOVER_MAX)
      await refreshOverview()
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : 'Plan scan failed')
    } finally {
      setDiscovering(false)
      setProgress(null)
    }
  }, [refreshOverview])

  // Mount: one overview, then at most one automatic catalog rescan when the
  // disk cache is empty or old, and only when the chain half answered live
  // (stale means our own tunnel is up and a rescan would return the cache).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await window.api.planOverview()
        if (cancelled) return
        setOverview(res)
        setLoading(false)
        const catalogOld = res.fetchedAt === null || Date.now() - res.fetchedAt > AUTO_DISCOVER_STALE_MS
        if (!res.stale && catalogOld && !autoDiscovered.current) {
          autoDiscovered.current = true
          await discover()
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [discover])

  // Sessions changing on chain (a purchase, a refund, an End, settlement) is
  // exactly when subscriptions and allocations move.
  useEffect(() => {
    return window.api.onSessionsChanged(() => {
      void refreshOverview()
    })
  }, [refreshOverview])

  useEffect(() => {
    const id = setInterval(() => {
      void refreshOverview()
    }, BACKSTOP_POLL_MS)
    return () => clearInterval(id)
  }, [refreshOverview])

  useEffect(() => {
    return window.api.onPlanDiscoverProgress((p) => setProgress(p))
  }, [])

  const value = useMemo(
    () => ({ overview, loading, discovering, progress, discoverError, refreshOverview, discover }),
    [overview, loading, discovering, progress, discoverError, refreshOverview, discover],
  )

  return <PlansContext.Provider value={value}>{children}</PlansContext.Provider>
}

export function usePlansContext(): PlansContextValue {
  const ctx = useContext(PlansContext)
  if (!ctx) {
    throw new Error('usePlansContext must be used within a PlansProvider')
  }
  return ctx
}
