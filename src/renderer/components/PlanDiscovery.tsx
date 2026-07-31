import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePlans } from '../hooks/usePlans'
import { useConnection } from '../hooks/useConnection'
import { useNavigation } from '../contexts/NavigationContext'
import type { PlanInfo, PlanAllocation, ProviderInfo, SentNode, SubscriptionSummary, TunnelProtocol } from '../types'
import ConnectErrorActions from './ConnectErrorActions'
import CountryFlag from './CountryFlag'
import Spinner from './Spinner'
import ProgressSteps from './ProgressSteps'
import { protocolMeta, isProtocolSupported } from '../utils/protocols'
import { nodeStatusMeta, isNodeConnectable } from '../utils/node-status'
import { useBalance } from '../hooks/useBalance'
import { checkFunds, insufficientFundsMessage } from '../../shared/funds'
import { displayConnectError } from '../utils/connect-errors'
import InsufficientFunds from './InsufficientFunds'
import ChainUnreachable from './ChainUnreachable'
import { useRpcHealth } from '../hooks/useRpcHealth'
import { isChainUnreachable } from '../../shared/rpc-health'

const UNLIMITED_BYTES_THRESHOLD = 1024 ** 5 // 1 PiB — anything larger is a pseudo-unlimited placeholder set by the provider
const PLAN_DISCOVERY_MAX = 500

/**
 * Return a node/provider-supplied website URL only if it's a safe external scheme
 * (http/https/mailto); otherwise null so we render it as plain text. Defense-in-
 * depth behind the main-process openExternal allow-list (finding L1).
 */
function safeExternalHref(url: string): string | null {
  try {
    const scheme = new URL(url).protocol
    return scheme === 'https:' || scheme === 'http:' || scheme === 'mailto:' ? url : null
  } catch {
    return null
  }
}

function formatBytes(bytes: string): string {
  const n = Number(bytes)
  if (!isFinite(n) || n <= 0) return '0 B'
  if (n >= UNLIMITED_BYTES_THRESHOLD) return 'Unlimited'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—'
  const days = Math.floor(seconds / 86400)
  if (days > 0) return `${days}d`
  const hours = Math.floor(seconds / 3600)
  if (hours > 0) return `${hours}h`
  const mins = Math.floor(seconds / 60)
  return `${mins}m`
}

function formatTimeAgo(ts: number | null): string {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function priceUdvpn(plan: PlanInfo): number {
  const u = plan.prices.find((p) => p.denom === 'udvpn')
  return u ? parseInt(u.quoteValue, 10) : 0
}

function priceDisplay(plan: PlanInfo): string {
  const v = priceUdvpn(plan)
  if (v <= 0) return '—'
  const dvpn = v / 1e6
  const formatted = dvpn.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${formatted} P2P`
}

function pricePerGB(plan: PlanInfo): number | null {
  const price = priceUdvpn(plan)
  const bytes = Number(plan.bytes)
  if (!price || !isFinite(bytes) || bytes <= 0) return null
  if (bytes >= UNLIMITED_BYTES_THRESHOLD) return null
  const gb = bytes / 1e9
  if (gb <= 0) return null
  return price / gb / 1e6
}

function pricePerDay(plan: PlanInfo): number | null {
  const price = priceUdvpn(plan)
  const seconds = plan.durationSeconds
  if (!price || !seconds || seconds <= 0) return null
  const days = seconds / 86400
  if (days <= 0) return null
  return price / days / 1e6
}

type ProviderState = ProviderInfo | null | 'loading'
type NodeListState = { addresses: string[] } | 'loading' | 'error'
type SortBy = 'price' | 'data' | 'duration' | 'provider'
type SortDir = 'asc' | 'desc'

const SORT_LABELS: Record<SortBy, string> = {
  price: 'Price',
  data: 'Data',
  duration: 'Duration',
  provider: 'Provider',
}

function providerDisplayName(state: ProviderState | undefined, address: string): string {
  if (state && typeof state === 'object' && state !== null && state.name) return state.name
  return `${address.slice(0, 12)}…${address.slice(-6)}`
}

// "Has nodes" filter: only show plans we've confirmed have ≥1 linked node.
// Unresolved plans (undefined / loading / error) are hidden so the list grows
// from empty as the bulk fetch resolves, rather than starting full and shrinking.
function isKnownToHaveNodes(state: NodeListState | undefined): state is { addresses: string[] } {
  return !!state && state !== 'loading' && state !== 'error' && state.addresses.length > 0
}

// Icons
function IconSearch({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="m14 14 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconClose({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function IconChevron({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="m5 7 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconArrowUp({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 15V5m-4 4 4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconArrowDown({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 5v10m-4-4 4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconInfo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 9v4.5M10 6.5v.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconExternal({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M11 4h5v5M16 4 9 11M14 12v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconData({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <ellipse cx="10" cy="5" rx="6" ry="2.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 5v5c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V5M4 10v5c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3v-5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function IconClock({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v4.3l2.8 1.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconCoin({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v8M12.5 7.8c0-1-1.1-1.8-2.5-1.8s-2.5.8-2.5 1.8 1.1 1.6 2.5 1.9 2.5.9 2.5 1.9-1.1 1.8-2.5 1.8-2.5-.8-2.5-1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function IconNode({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 10h15M10 2.5c2.5 2.5 2.5 12.5 0 15M10 2.5c-2.5 2.5-2.5 12.5 0 15" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export default function PlanDiscovery() {
  const { plansNodeFilter, clearPlansNodeFilter } = useNavigation()
  const { plans, fetchedAt, allocations, discovering, progress, discover, refreshCached, refreshAllocations } = usePlans()
  // A rescan re-queries the chain over RPC, which is unreachable while OUR tunnel
  // is up (traffic routes to the dVPN node). External VPNs like Mullvad don't
  // trigger this — only this app's own tunnel does.
  const { status: connStatus } = useConnection()
  const tunnelUp = connStatus.state !== 'idle'
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [providers, setProviders] = useState<Record<string, ProviderState>>({})
  const [planNodes, setPlanNodes] = useState<Record<string, NodeListState>>({})
  const [nodeIndex, setNodeIndex] = useState<Map<string, SentNode> | null>(null)
  const fetchedProviderAddrs = useRef<Set<string>>(new Set())

  // Filter state
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('price')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [hasNodesOnly, setHasNodesOnly] = useState(true)
  const [subscribedOnly, setSubscribedOnly] = useState(false)
  const [publicOnly, setPublicOnly] = useState(true)
  const [showTests, setShowTests] = useState(false)

  // Sidebar provider group collapse state. Absent key = collapsed.
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})

  // Allocation the user is connecting through (drives the node-picker modal).
  const [connectingAllocation, setConnectingAllocation] = useState<PlanAllocation | null>(null)
  // Plan the user is subscribing to from the Plans tab (no existing allocation).
  const [subscribingPlan, setSubscribingPlan] = useState<PlanInfo | null>(null)

  // Sort dropdown
  const [sortOpen, setSortOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!sortOpen) return
    function onDocClick(e: MouseEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [sortOpen])

  // Focus search on "/"
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function handleRescan() {
    setError(null)
    try {
      await discover(PLAN_DISCOVERY_MAX)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed')
    }
  }

  const allocByPlanId = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of allocations) m.set(a.planId, (m.get(a.planId) || 0) + 1)
    return m
  }, [allocations])

  // Bulk-fetch every provider on-chain in ONE RPC call. Cache lives on disk in the main
  // process, so this is effectively instant after the first app launch. We intentionally do
  // NOT pre-mark providers as 'loading' — undefined already renders as the truncated address
  // via providerDisplayName(), so the first paint shows addresses and they flip to names the
  // moment the bulk list arrives. No flashing spinner.
  useEffect(() => {
    if (plans.length === 0) return
    const needsFetch = plans.some((p) => !fetchedProviderAddrs.current.has(p.provAddress))
    if (!needsFetch) return

    const planAddrs: string[] = []
    for (const p of plans) {
      if (!fetchedProviderAddrs.current.has(p.provAddress)) {
        fetchedProviderAddrs.current.add(p.provAddress)
        planAddrs.push(p.provAddress)
      }
    }

    async function run() {
      try {
        const all = await window.api.providerList()
        setProviders((prev) => {
          const next = { ...prev }
          const byAddr = new Map<string, ProviderInfo>()
          for (const p of all) byAddr.set(p.address, p)
          for (const addr of planAddrs) {
            next[addr] = byAddr.get(addr) ?? null
          }
          return next
        })
        // Provider cache in main is now warm — refresh plans so `isTest` is
        // recomputed against the freshly-cached provider names. No-op if
        // nothing changed; idempotent.
        refreshCached()
      } catch {
        setProviders((prev) => {
          const next = { ...prev }
          for (const addr of planAddrs) next[addr] = null
          return next
        })
      }
    }
    run()
  }, [plans, refreshCached])

  // Load node directory once when plans are available
  useEffect(() => {
    if (plans.length === 0 || nodeIndex) return
    window.api
      .nodesFetch()
      .then((nodes) => {
        const map = new Map<string, SentNode>()
        for (const n of nodes) map.set(n.address, n)
        setNodeIndex(map)
      })
      .catch(() => setNodeIndex(new Map()))
  }, [plans, nodeIndex])

  // Fetch compatible nodes for the selected plan
  useEffect(() => {
    if (!selectedId) return
    if (selectedId in planNodes) return
    setPlanNodes((prev) => ({ ...prev, [selectedId]: 'loading' }))
    window.api
      .planNodes(selectedId)
      .then((addresses) => setPlanNodes((prev) => ({ ...prev, [selectedId]: { addresses } })))
      .catch(() => setPlanNodes((prev) => ({ ...prev, [selectedId]: 'error' })))
  }, [selectedId, planNodes])

  // Bulk-fetch node lists for all plans when the "Has nodes" filter is active.
  // Throttled to keep the RPC from being thundering-herded; main-process cache
  // makes repeats free. We track started ids in a ref so the effect doesn't
  // re-cancel itself on every per-plan state update.
  const bulkStarted = useRef<Set<string>>(new Set())
  useEffect(() => {
    if ((!hasNodesOnly && !plansNodeFilter) || plans.length === 0) return
    const todo: string[] = []
    for (const p of plans) {
      if (!bulkStarted.current.has(p.id)) {
        bulkStarted.current.add(p.id)
        todo.push(p.id)
      }
    }
    if (todo.length === 0) return

    setPlanNodes((prev) => {
      const next = { ...prev }
      for (const id of todo) if (!(id in next)) next[id] = 'loading'
      return next
    })

    const CONCURRENCY = 4
    const queue = [...todo]
    async function worker() {
      while (true) {
        const id = queue.shift()
        if (!id) return
        try {
          const addresses = await window.api.planNodes(id)
          setPlanNodes((prev) => ({ ...prev, [id]: { addresses } }))
        } catch {
          setPlanNodes((prev) => ({ ...prev, [id]: 'error' }))
        }
      }
    }
    Promise.all(Array.from({ length: CONCURRENCY }, worker)).catch(() => {})
  }, [hasNodesOnly, plansNodeFilter, plans])

  // Arriving at "plans covering node X" (via the modal's "See Plans tab") shouldn't
  // hide that node's plans behind the standing chips. Once node lists have resolved,
  // relax exactly the chips that would filter a covering plan out, based on those
  // plans' own characteristics. A ref makes it fire once per node so it never fights
  // a manual chip toggle afterwards.
  const relaxedForNode = useRef<string | null>(null)
  useEffect(() => {
    if (!plansNodeFilter) {
      relaxedForNode.current = null
      return
    }
    if (relaxedForNode.current === plansNodeFilter || plans.length === 0) return
    // Any unresolved node list means "covering" is still partial — wait.
    const stillResolving = plans.some((p) => {
      const s = planNodes[p.id]
      return s === undefined || s === 'loading'
    })
    if (stillResolving) return
    const covering = plans.filter((p) => {
      const s = planNodes[p.id]
      return isKnownToHaveNodes(s) && s.addresses.includes(plansNodeFilter)
    })
    relaxedForNode.current = plansNodeFilter
    if (covering.some((p) => p.private)) setPublicOnly(false)
    if (covering.some((p) => p.isTest)) setShowTests(true)
  }, [plansNodeFilter, plans, planNodes])

  function retryPlanNodes(planId: string) {
    setPlanNodes((prev) => {
      const next = { ...prev }
      delete next[planId]
      return next
    })
  }

  // True while the "Has nodes" bulk fetch is still resolving plans. Drives the
  // loading state in the sidebar so the list doesn't appear "empty" before the
  // first plans are confirmed to have nodes.
  const hasNodesBulkLoading = useMemo(() => {
    if (!hasNodesOnly || plans.length === 0) return false
    for (const p of plans) {
      const s = planNodes[p.id]
      if (s === undefined || s === 'loading') return true
    }
    return false
  }, [hasNodesOnly, plans, planNodes])

  const anyFilterActive =
    showTests ||
    search.trim() !== '' ||
    !hasNodesOnly ||
    !publicOnly ||
    subscribedOnly ||
    plansNodeFilter !== null ||
    sortBy !== 'price' ||
    sortDir !== 'asc'

  function clearAllFilters() {
    setShowTests(false)
    setSearch('')
    setHasNodesOnly(true)
    setPublicOnly(true)
    setSubscribedOnly(false)
    setSortBy('price')
    setSortDir('asc')
    clearPlansNodeFilter()
  }

  // Filter
  const filtered = useMemo(() => {
    let list = plans
    if (!showTests) list = list.filter((p) => !p.isTest)
    if (publicOnly) list = list.filter((p) => !p.private)
    if (subscribedOnly) list = list.filter((p) => allocByPlanId.has(p.id))
    if (hasNodesOnly) list = list.filter((p) => isKnownToHaveNodes(planNodes[p.id]))
    if (plansNodeFilter) {
      list = list.filter((p) => {
        const s = planNodes[p.id]
        return isKnownToHaveNodes(s) && s.addresses.includes(plansNodeFilter)
      })
    }
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((p) => {
        if (p.id.toLowerCase().includes(q)) return true
        if (p.provAddress.toLowerCase().includes(q)) return true
        const prov = providers[p.provAddress]
        if (prov && typeof prov === 'object' && prov !== null) {
          if (prov.name && prov.name.toLowerCase().includes(q)) return true
          if (prov.identity && prov.identity.toLowerCase().includes(q)) return true
          if (prov.website && prov.website.toLowerCase().includes(q)) return true
          if (prov.description && prov.description.toLowerCase().includes(q)) return true
        }
        // Match against linked nodes (moniker or address). Only plans whose
        // node list is already resolved participate — typing a moniker before
        // the bulk fetch completes will surface plans as they resolve.
        const nodes = planNodes[p.id]
        if (isKnownToHaveNodes(nodes)) {
          for (const addr of nodes.addresses) {
            if (addr.toLowerCase().includes(q)) return true
            const moniker = nodeIndex?.get(addr)?.moniker
            if (moniker && moniker.toLowerCase().includes(q)) return true
          }
        }
        return false
      })
    }
    return list
  }, [plans, showTests, publicOnly, subscribedOnly, hasNodesOnly, planNodes, allocByPlanId, search, providers, plansNodeFilter, nodeIndex])

  // Group by provider, sort within, then sort groups
  const grouped = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const map = new Map<string, PlanInfo[]>()
    for (const p of filtered) {
      const arr = map.get(p.provAddress) || []
      arr.push(p)
      map.set(p.provAddress, arr)
    }
    const compare = (a: PlanInfo, b: PlanInfo) => {
      if (sortBy === 'price') return (priceUdvpn(a) - priceUdvpn(b)) * dir
      if (sortBy === 'data') return (parseInt(a.bytes, 10) - parseInt(b.bytes, 10)) * dir
      if (sortBy === 'duration') return ((a.durationSeconds || 0) - (b.durationSeconds || 0)) * dir
      return 0
    }
    const entries = Array.from(map.entries())
    for (const [, arr] of entries) arr.sort(compare)
    entries.sort(([aAddr, aPlans], [bAddr, bPlans]) => {
      if (sortBy === 'provider') {
        return (
          providerDisplayName(providers[aAddr], aAddr).localeCompare(
            providerDisplayName(providers[bAddr], bAddr),
          ) * dir
        )
      }
      return bPlans.length - aPlans.length
    })
    return entries
  }, [filtered, sortBy, sortDir, providers])

  // If the current selection gets filtered out, clear it rather than auto-picking
  // a new plan (which would force-expand an unrelated provider group).
  useEffect(() => {
    if (!selectedId) return
    if (!filtered.some((p) => p.id === selectedId)) {
      setSelectedId(null)
    }
  }, [filtered, selectedId])

  const pct = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0
  const selectedPlan = plans.find((p) => p.id === selectedId) || null

  return (
    <div className="h-full flex flex-col">
      {discovering && progress && (
        <div className="px-5 py-2 border-b border-border shrink-0 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-secondary capitalize">{progress.phase}</span>
            <span className="text-text-tertiary font-mono">
              {progress.done} / {progress.total}
            </span>
          </div>
          <div className="h-1.5 bg-bg-hover overflow-hidden rounded-full">
            <div
              className="h-full bg-accent transition-all rounded-full"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mx-5 mt-3 bg-danger-subtle border border-danger p-3 rounded-md shrink-0">
          <p className="text-danger text-sm">{error}</p>
        </div>
      )}

      {plansNodeFilter && (
        <div className="mx-5 mt-3 bg-accent/10 border border-accent/40 px-3 py-2 rounded-md shrink-0 flex items-center justify-between gap-3">
          <div className="text-xs text-text-primary truncate">
            Showing plans covering node{' '}
            <span className="font-medium text-accent">
              {nodeIndex?.get(plansNodeFilter)?.moniker ||
                `${plansNodeFilter.slice(0, 12)}…${plansNodeFilter.slice(-6)}`}
            </span>
          </div>
          <button
            type="button"
            onClick={clearPlansNodeFilter}
            className="text-xs text-accent hover:underline shrink-0"
          >
            Clear
          </button>
        </div>
      )}

      {/* Filter bar — two clusters: [search + filters] | [count + sort + clear] */}
      <div className="px-5 pt-3 pb-3 border-b border-border shrink-0">
        <div className="flex items-center gap-4">
          {/* LEFT cluster: search + visibility + quick filters */}
          <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
            <div className="relative w-[348px] shrink-0">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none">
                <IconSearch className="w-4 h-4" />
              </span>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search plans, providers, nodes…"
                className="w-full bg-bg-tertiary border border-border text-text-primary text-sm pl-9 pr-10 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all placeholder:text-text-tertiary"
              />
              {search ? (
                <button
                  onClick={() => {
                    setSearch('')
                    searchRef.current?.focus()
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary w-6 h-6 flex items-center justify-center rounded-sm"
                  aria-label="Clear search"
                  title="Clear"
                >
                  <IconClose className="w-3.5 h-3.5" />
                </button>
              ) : (
                <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary text-[10px] font-mono border border-border bg-bg-secondary px-1.5 py-0.5 rounded-sm pointer-events-none">
                  /
                </kbd>
              )}
            </div>

            <div className="h-7 w-px bg-border mx-1 shrink-0" aria-hidden="true" />

            <FilterChip
              label="Public only"
              active={publicOnly}
              onClick={() => setPublicOnly((v) => !v)}
              title="Hide plans flagged private on-chain. Uncheck to inspect private plans (often invite-only or test fixtures)"
            />
            <FilterChip
              label="Has nodes"
              active={hasNodesOnly}
              onClick={() => setHasNodesOnly((v) => !v)}
              title="Hide plans known to have zero compatible nodes (loading plans stay visible)"
            />
            <FilterChip
              label="Subscribed"
              count={allocations.length}
              active={subscribedOnly}
              onClick={() => setSubscribedOnly((v) => !v)}
            />
            <FilterChip
              label="Show test providers"
              active={showTests}
              onClick={() => setShowTests((v) => !v)}
              title='Include plans whose provider name contains "test", "staging", "demo", or "do not use"'
            />
          </div>

          {/* RIGHT cluster: count + sort + clear */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-xs tabular-nums">
              <span className={filtered.length !== plans.length ? 'text-accent font-semibold' : 'text-text-primary'}>
                {filtered.length}
              </span>
              <span className="text-text-tertiary"> of {plans.length}</span>
            </div>

            {/* Unified sort pill */}
            <div className="relative" ref={sortMenuRef}>
              <div className="inline-flex items-stretch rounded-md border border-border bg-bg-tertiary overflow-hidden">
                <button
                  onClick={() => setSortOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={sortOpen}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 text-text-primary hover:bg-bg-hover transition-colors"
                  title="Sort by"
                >
                  <span>{SORT_LABELS[sortBy]}</span>
                  <IconChevron className={`w-3 h-3 text-text-tertiary transition-transform ${sortOpen ? 'rotate-180' : ''}`} />
                </button>
                <button
                  onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  className="flex items-center justify-center px-2 py-2 border-l border-border text-text-secondary hover:text-accent hover:bg-bg-hover transition-colors"
                  title={`Direction: ${sortDir === 'asc' ? 'Ascending' : 'Descending'} (click to toggle)`}
                  aria-label="Toggle sort direction"
                >
                  {sortDir === 'asc' ? <IconArrowUp className="w-3.5 h-3.5" /> : <IconArrowDown className="w-3.5 h-3.5" />}
                </button>
              </div>
              {sortOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 w-44 bg-bg-secondary border border-border rounded-md shadow-lg z-20 py-1"
                >
                  {(Object.keys(SORT_LABELS) as SortBy[]).map((s) => {
                    const active = s === sortBy
                    return (
                      <button
                        key={s}
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          setSortBy(s)
                          setSortOpen(false)
                        }}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between ${
                          active
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        <span>{SORT_LABELS[s]}</span>
                        {active && (
                          <span className="text-accent text-[10px] flex items-center gap-1">
                            {sortDir === 'asc' ? '↑' : '↓'}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {anyFilterActive && (
              <button
                onClick={clearAllFilters}
                className="flex items-center text-[11px] uppercase tracking-wide text-text-tertiary hover:text-accent transition-colors px-2 py-1"
                title="Reset search, filters, and sort"
              >
                <span className="mr-1 text-sm leading-none">×</span>Clear
              </button>
            )}

            <div className="h-7 w-px bg-border mx-1 shrink-0" aria-hidden="true" />

            <button
              onClick={handleRescan}
              disabled={discovering || tunnelUp}
              className="btn btn-primary text-xs px-3 py-2 disabled:opacity-30 disabled:cursor-not-allowed"
              title={
                tunnelUp
                  ? 'Disconnect to rescan — the chain RPC is unreachable through the tunnel'
                  : plans.length === 0
                    ? 'Discover plans on-chain'
                    : `Rescan plans · last updated ${formatTimeAgo(fetchedAt)}`
              }
            >
              {discovering ? (
                <span className="flex items-center gap-2">
                  <Spinner className="text-white" /> Scanning…
                </span>
              ) : plans.length === 0 ? (
                'Discover'
              ) : (
                'Rescan'
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Body: master/detail */}
      <div className="flex-1 flex min-h-0">
        {/* Left: plans list grouped by provider */}
        <div className="w-[380px] border-r border-border overflow-y-auto shrink-0">
          {plans.length === 0 && !discovering && (
            <div className="px-5 py-12 text-center">
              <p className="text-text-secondary text-sm mb-1">No plans cached</p>
              <p className="text-text-tertiary text-xs">
                Click "Discover Plans" to scan active plans on-chain
              </p>
              <div className="mt-2">
                <ChainUnreachable what="the on-chain plan scan" />
              </div>
            </div>
          )}
          {plans.length > 0 && filtered.length === 0 && hasNodesBulkLoading && (
            <div className="px-5 py-12 text-center flex flex-col items-center gap-3">
              <Spinner className="text-accent" />
              <p className="text-text-tertiary text-xs">
                Checking which plans have linked nodes…
              </p>
            </div>
          )}
          {plans.length > 0 && filtered.length === 0 && !hasNodesBulkLoading && (
            <div className="px-5 py-12 text-center">
              <p className="text-text-tertiary text-xs">No plans match the current filter</p>
              {anyFilterActive && (
                <button
                  onClick={clearAllFilters}
                  className="mt-3 text-accent text-xs hover:underline"
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}
          {grouped.map(([provAddr, providerPlans]) => {
            const prov = providers[provAddr]
            const name = providerDisplayName(prov, provAddr)
            const containsSelected =
              selectedId != null && providerPlans.some((p) => p.id === selectedId)
            const isExpanded = containsSelected || !!expandedProviders[provAddr]

            const toggleOpen = () => {
              setExpandedProviders((prev) => {
                const wasOpen = !!prev[provAddr]
                if (wasOpen && selectedId && providerPlans.some((p) => p.id === selectedId)) {
                  setSelectedId(null)
                }
                return { ...prev, [provAddr]: !wasOpen }
              })
            }

            return (
              <div key={provAddr}>
                <button
                  type="button"
                  onClick={toggleOpen}
                  aria-expanded={isExpanded}
                  aria-controls={`plans-${provAddr}`}
                  className="sticky top-0 z-10 w-full text-left bg-bg-secondary hover:bg-bg-hover border-b border-border px-4 py-2 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-text-primary text-xs font-semibold truncate">
                          {name}
                        </div>
                        <div className="text-text-tertiary text-[10px] font-mono truncate">
                          {provAddr.slice(0, 16)}…{provAddr.slice(-6)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-text-tertiary text-[10px]">
                        {providerPlans.length} plan{providerPlans.length === 1 ? '' : 's'}
                      </div>
                      <IconChevron
                        className={`w-3 h-3 text-text-tertiary transition-transform ${
                          isExpanded ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </div>
                </button>
                {isExpanded && (
                <div id={`plans-${provAddr}`} className="divide-y divide-border">
                  {providerPlans.map((plan) => {
                    const subscribed = allocByPlanId.get(plan.id) || 0
                    const isSelected = selectedId === plan.id
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        onClick={() => setSelectedId(plan.id)}
                        className={`w-full text-left px-4 py-2.5 text-sm transition-colors border-l-2 ${
                          isSelected
                            ? 'bg-accent/10 border-l-accent'
                            : 'border-l-transparent hover:bg-bg-hover'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1 gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className={`text-xs font-mono font-semibold ${
                                isSelected ? 'text-accent' : 'text-text-primary'
                              }`}
                            >
                              #{plan.id}
                            </span>
                            <span
                              className={`text-[9px] uppercase font-medium px-1.5 py-0.5 rounded-sm border ${
                                plan.private
                                  ? 'text-warning border-warning/40 bg-warning/10'
                                  : 'text-info border-info/40 bg-info/10'
                              }`}
                            >
                              {plan.private ? 'Private' : 'Public'}
                            </span>
                            {subscribed > 0 && (
                              <span className="text-[9px] uppercase font-medium text-success border border-success/40 bg-success/10 px-1.5 py-0.5 rounded-sm">
                                ✓
                              </span>
                            )}
                          </div>
                          <span className="text-text-primary text-xs font-mono shrink-0">
                            {priceDisplay(plan)}
                          </span>
                        </div>
                        <div className="text-text-secondary text-xs">
                          {formatBytes(plan.bytes)} · {formatDuration(plan.durationSeconds)}
                        </div>
                      </button>
                    )
                  })}
                </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Right: detail panel */}
        <div className="flex-1 overflow-y-auto min-w-0">
          {!selectedPlan ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-text-tertiary text-sm">Select a plan to see details</p>
            </div>
          ) : (
            (() => {
              const existing = allocations.find(
                (a) => a.planId === selectedPlan.id && a.status === 1
              ) ?? null
              return (
                <PlanDetail
                  plan={selectedPlan}
                  provider={providers[selectedPlan.provAddress]}
                  nodesState={planNodes[selectedPlan.id]}
                  nodeIndex={nodeIndex}
                  subscribedCount={allocByPlanId.get(selectedPlan.id) || 0}
                  existingAllocation={existing}
                  onAction={() => {
                    if (existing) setConnectingAllocation(existing)
                    else setSubscribingPlan(selectedPlan)
                  }}
                  onRetryNodes={() => retryPlanNodes(selectedPlan.id)}
                />
              )
            })()
          )}
        </div>
      </div>

      {/* Allocations footer */}
      {allocations.length > 0 && (
        <details className="border-t border-border shrink-0 bg-bg-secondary" open>
          <summary className="px-5 py-2 cursor-pointer text-text-secondary text-xs font-medium uppercase tracking-wide hover:text-text-primary list-none flex items-center justify-between">
            <span>Your Plan Subscriptions ({allocations.length})</span>
            <span className="text-text-tertiary text-[10px]">▼</span>
          </summary>
          <div className="max-h-[220px] overflow-y-auto px-5 pb-3 space-y-1.5">
            {allocations.map((a) => (
              <div
                key={a.subscriptionId}
                className="border border-border bg-bg-tertiary rounded-md px-3 py-2 text-xs flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="text-accent font-mono">sub #{a.subscriptionId}</span>
                    <span className="text-text-secondary font-mono">plan #{a.planId}</span>
                  </div>
                  <div className="text-text-secondary text-xs mt-1">
                    {formatBytes(a.planBytes)} · {formatDuration(a.planDurationSeconds)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setConnectingAllocation(a)}
                  disabled={a.status !== 1}
                  className="btn btn-primary text-xs py-1.5 px-3 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                  title={a.status === 1 ? 'Connect to a node using this allocation' : 'Allocation is not active'}
                >
                  Connect
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Manage subscriptions: cancel, renew, or change the auto-renewal policy.
          Covers node (per-GB/hour) subscriptions too, which the allocations footer
          above — plan-only, and about connecting — never showed. */}
      <SubscriptionManager
        tunnelUp={tunnelUp}
        activeSessionId={connStatus.sessionId ?? null}
        onSubscriptionsChanged={refreshAllocations}
      />

      {connectingAllocation && (
        <AllocationConnectModal
          allocation={connectingAllocation}
          nodeIndex={nodeIndex}
          onClose={() => setConnectingAllocation(null)}
        />
      )}

      {subscribingPlan && (
        <PlanSubscribeModal
          plan={subscribingPlan}
          nodeIndex={nodeIndex}
          provider={providers[subscribingPlan.provAddress]}
          onClose={() => setSubscribingPlan(null)}
        />
      )}
    </div>
  )
}

// sentinel.types.v1.RenewalPricePolicy. The enum has eight comparison variants;
// these are the three that make sense to a user. 0 (UNSPECIFIED) is the hub's own
// "no renewal" marker — Subscription.RenewalAt() returns the zero time for it, and
// cancelling a subscription sets it to 0.
const RENEWAL_POLICY_OPTIONS: { value: number; label: string }[] = [
  { value: 7, label: 'Always renew' },
  { value: 2, label: 'Renew if price ≤ current' },
  { value: 0, label: "Don't renew" },
]

function renewalPolicyLabel(policy: number): string {
  return RENEWAL_POLICY_OPTIONS.find((o) => o.value === policy)?.label ?? `Policy ${policy}`
}

function subscriptionStatusLabel(status: number): string {
  if (status === 1) return 'Active'
  if (status === 2) return 'Ending'
  if (status === 3) return 'Inactive'
  return `Status ${status}`
}

/**
 * Cancel / renew / renewal-policy management for every subscription the wallet
 * owns. All three are on-chain txs, so each is confirmed first (same native-confirm
 * convention ActiveSessions uses for ending a session).
 *
 * Always rendered as an open section rather than a collapsed <details>: it is the
 * only place a subscription can be cancelled, and being tucked away at the bottom
 * of the tab made that hard to find. While the tunnel is up it stays visible but
 * read-only — RPC is unreachable through our own tunnel, so main returns [] and
 * there is nothing to act on, but silently disappearing read as "gone".
 *
 * `onSubscriptionsChanged` refreshes the OTHER views of the same data (the
 * allocations footer, ConnectionModal's reuse path). Without it they kept offering
 * a subscription this component had just cancelled, until the 120s poll caught up.
 */
function SubscriptionManager({ tunnelUp, activeSessionId, onSubscriptionsChanged }: {
  tunnelUp: boolean
  activeSessionId: string | null
  onSubscriptionsChanged: () => void
}) {
  const [subs, setSubs] = useState<SubscriptionSummary[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { state: rpcState } = useRpcHealth()

  const load = useCallback(() => {
    window.api
      .subscriptionList()
      .then(setSubs)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load subscriptions'))
  }, [])

  useEffect(() => {
    // RPC is unreachable through our own tunnel; main returns [] while connected.
    if (!tunnelUp) load()
  }, [tunnelUp, load])

  /** Reload this list AND every other view of the same subscriptions. */
  const reloadAll = useCallback(() => {
    load()
    onSubscriptionsChanged()
  }, [load, onSubscriptionsChanged])

  async function handleCancel(sub: SubscriptionSummary) {
    if (!confirm(
      `Cancel subscription #${sub.id}?\n\nIt stops renewing and ends at the close of the current period; ` +
      `any sessions running under it will end. This is an on-chain transaction and cannot be undone.`
    )) return

    setBusyId(sub.id)
    setError(null)
    try {
      await window.api.subscriptionCancel(sub.id)
      // If the live tunnel is running on a session of this subscription, it's
      // about to stop working — offer to tear it down now.
      const sessions = await window.api.walletSessions().catch(() => [])
      const activeBelongs = sessions.some((s) => s.id === activeSessionId && s.subscriptionId === sub.id)
      if (activeBelongs && confirm('Your active VPN session belongs to that subscription. Disconnect now?')) {
        await window.api.connectionDisconnect()
      }
      reloadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Buy another period on an existing plan subscription instead of creating a new
   * one. Charges the plan price again. Node (per-GB/hour) subscriptions have no
   * plan price, so main rejects them and the button isn't offered for those.
   */
  async function handleRenew(sub: SubscriptionSummary) {
    if (!confirm(
      `Renew subscription #${sub.id} for another period?\n\nThis charges the plan's current price again ` +
      `and is an on-chain transaction.`
    )) return

    setBusyId(sub.id)
    setError(null)
    try {
      await window.api.subscriptionRenew(sub.id, sub.planId, 'udvpn')
      reloadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Renew failed')
    } finally {
      setBusyId(null)
    }
  }

  async function handlePolicyChange(sub: SubscriptionSummary, policy: number) {
    if (policy === sub.renewalPricePolicy) return
    if (!confirm(`Set subscription #${sub.id} to "${renewalPolicyLabel(policy)}"?\n\nThis is an on-chain transaction.`)) {
      load() // reset the select back to the stored value
      return
    }
    setBusyId(sub.id)
    setError(null)
    try {
      await window.api.subscriptionUpdatePolicy(sub.id, policy)
      reloadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
      load()
    } finally {
      setBusyId(null)
    }
  }

  if (tunnelUp) {
    return (
      <div className="border-t border-border shrink-0 bg-bg-secondary px-5 py-2">
        <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">Manage subscriptions</span>
        <p className="text-text-tertiary text-xs mt-1">
          Disconnect to cancel, renew or re-price a subscription — the blockchain isn&apos;t reachable through your own tunnel.
        </p>
      </div>
    )
  }

  // An empty list here is ambiguous: it's also what main returns when the chain
  // couldn't be reached. Say which, instead of silently rendering nothing.
  if (!subs || subs.length === 0) {
    if (!isChainUnreachable(rpcState)) return null
    return (
      <div className="border-t border-border shrink-0 bg-bg-secondary px-5 py-2">
        <ChainUnreachable what="your subscriptions" />
      </div>
    )
  }

  return (
    <div className="border-t border-border shrink-0 bg-bg-secondary">
      <div className="px-5 py-2 text-text-secondary text-xs font-medium uppercase tracking-wide">
        Manage subscriptions ({subs.length})
      </div>
      <div className="max-h-[220px] overflow-y-auto px-5 pb-3 space-y-1.5">
        {error && <p className="text-danger text-xs">{displayConnectError(error)}</p>}
        {subs.map((sub) => (
          <div
            key={sub.id}
            className="border border-border bg-bg-tertiary rounded-md px-3 py-2 text-xs flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3">
                <span className="text-accent font-mono">sub #{sub.id}</span>
                <span className="text-text-secondary font-mono">
                  {sub.planId === '0' ? 'node' : `plan #${sub.planId}`}
                </span>
                <span className="text-text-secondary">{subscriptionStatusLabel(sub.status)}</span>
              </div>
              <div className="text-text-tertiary text-xs mt-1">
                {sub.inactiveAt ? `Ends ${new Date(sub.inactiveAt).toLocaleString()}` : 'No end date'}
                {' · '}
                {renewalPolicyLabel(sub.renewalPricePolicy)}
              </div>
            </div>
            <select
              value={sub.renewalPricePolicy}
              onChange={(e) => handlePolicyChange(sub, parseInt(e.target.value, 10))}
              disabled={sub.status !== 1 || busyId === sub.id}
              title={sub.status === 1 ? 'Auto-renewal policy' : 'Only active subscriptions can be updated'}
              className="bg-bg-secondary border border-border text-text-primary text-xs px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus shrink-0 disabled:opacity-30"
            >
              {RENEWAL_POLICY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
              {!RENEWAL_POLICY_OPTIONS.some((o) => o.value === sub.renewalPricePolicy) && (
                <option value={sub.renewalPricePolicy}>{renewalPolicyLabel(sub.renewalPricePolicy)}</option>
              )}
            </select>
            {sub.planId !== '0' && (
              <button
                type="button"
                onClick={() => handleRenew(sub)}
                disabled={sub.status !== 1 || busyId === sub.id}
                className="btn btn-secondary text-xs py-1.5 px-3 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                title={sub.status === 1 ? 'Buy another period on this plan' : 'Only active subscriptions can be renewed'}
              >
                Renew
              </button>
            )}
            <button
              type="button"
              onClick={() => handleCancel(sub)}
              disabled={sub.status !== 1 || busyId === sub.id}
              className="btn btn-danger text-xs py-1.5 px-3 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
              title={sub.status === 1 ? 'Cancel this subscription on-chain' : 'Only active subscriptions can be cancelled'}
            >
              {busyId === sub.id ? '…' : 'Cancel'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

interface FilterChipProps {
  label: string
  active: boolean
  onClick: () => void
  count?: number
  title?: string
}

function FilterChip({ label, active, onClick, count, title }: FilterChipProps) {
  const dimmed = count === 0
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`flex items-center gap-2 text-xs px-3 py-2 rounded-md border transition-all ${
        active
          ? 'bg-accent/15 text-accent border-accent/60'
          : dimmed
          ? 'bg-bg-tertiary text-text-tertiary border-border opacity-60 hover:opacity-100'
          : 'bg-bg-tertiary text-text-secondary border-border hover:text-text-primary hover:border-border-focus'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full border transition-colors ${
          active ? 'bg-accent border-accent' : 'bg-transparent border-current'
        }`}
        aria-hidden="true"
      />
      {label}
      {count !== undefined && (
        <span className={`font-mono text-[10px] ${active ? 'text-accent' : 'text-text-tertiary'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

interface PlanDetailProps {
  plan: PlanInfo
  provider: ProviderState | undefined
  nodesState: NodeListState | undefined
  nodeIndex: Map<string, SentNode> | null
  subscribedCount: number
  existingAllocation: PlanAllocation | null
  onAction: () => void
  onRetryNodes: () => void
}

function PlanDetail({
  plan,
  provider,
  nodesState,
  nodeIndex,
  subscribedCount,
  existingAllocation,
  onAction,
  onRetryNodes,
}: PlanDetailProps) {
  const [copied, setCopied] = useState(false)
  const [showInfo, setShowInfo] = useState(false)

  function copyAddr() {
    navigator.clipboard.writeText(plan.provAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function scrollToCompat() {
    const el = document.getElementById('compat-nodes-section')
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const providerLoading = provider === 'loading' || provider === undefined
  const hasProviderInfo = provider && typeof provider === 'object' && provider !== null
  const providerName = hasProviderInfo ? provider.name : ''
  const verified = hasProviderInfo && !!provider.identity

  const perGB = pricePerGB(plan)
  const perDay = pricePerDay(plan)
  const udvpnRaw = priceUdvpn(plan)

  // Nodes KPI subtext
  let nodesKpi: { value: React.ReactNode; subtext: React.ReactNode; tone: 'accent' | 'muted' | 'loading' }
  if (!nodesState || nodesState === 'loading') {
    nodesKpi = { value: <Spinner className="text-accent" />, subtext: 'querying chain', tone: 'loading' }
  } else if (nodesState === 'error') {
    nodesKpi = { value: '—', subtext: 'query failed', tone: 'muted' }
  } else if (nodesState.addresses.length === 0) {
    nodesKpi = { value: '0', subtext: 'none linked', tone: 'muted' }
  } else {
    nodesKpi = {
      value: nodesState.addresses.length.toString(),
      subtext: 'linked on-chain',
      tone: 'accent',
    }
  }

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      {/* Header — provider identity + plan badges */}
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {providerLoading ? (
              <div className="flex items-center gap-2 text-text-tertiary text-sm h-6">
                <Spinner className="text-accent" /> Loading provider…
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <div className="text-text-primary font-semibold text-base truncate">
                    {hasProviderInfo
                      ? providerName || '(No public name)'
                      : 'Unknown provider'}
                  </div>
                  {verified && (
                    <span
                      className="w-2 h-2 rounded-full bg-success shrink-0"
                      title="Verified on-chain (provider has a Keybase identity)"
                    />
                  )}
                </div>
                {hasProviderInfo && provider.website && (
                  safeExternalHref(provider.website) ? (
                    <a
                      href={safeExternalHref(provider.website)!}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent hover:underline text-xs break-all inline-flex items-center gap-1"
                    >
                      {provider.website}
                      <IconExternal className="w-3 h-3 shrink-0" />
                    </a>
                  ) : (
                    <div className="text-text-tertiary text-xs break-all">{provider.website}</div>
                  )
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 max-w-[240px]">
            <div className="text-text-tertiary font-mono text-[10px] truncate">
              {plan.provAddress.slice(0, 16)}…{plan.provAddress.slice(-6)}
            </div>
            <button
              onClick={copyAddr}
              className="text-text-tertiary hover:text-accent text-[10px] uppercase tracking-wide shrink-0"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-accent font-mono text-lg font-semibold">Plan #{plan.id}</span>
          <span
            className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-sm border ${
              plan.private
                ? 'text-warning border-warning/40 bg-warning/10'
                : 'text-info border-info/40 bg-info/10'
            }`}
          >
            {plan.private ? 'Private' : 'Public'}
          </span>
          <span className="text-[10px] uppercase font-medium text-info border-info/40 bg-info/10 border px-2 py-0.5 rounded-sm">
            {plan.status === 1 ? 'Active' : `Status ${plan.status}`}
          </span>
          {subscribedCount > 0 && (
            <span className="text-[10px] uppercase font-medium text-success border border-success/40 bg-success/10 px-2 py-0.5 rounded-sm">
              Subscribed
            </span>
          )}
        </div>

        <div className="pt-1">
          <button
            type="button"
            onClick={onAction}
            disabled={plan.status !== 1}
            className="btn btn-primary text-sm py-2 px-4 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {existingAllocation ? 'Connect via Existing Plan' : 'Subscribe & Connect'}
          </button>
          {existingAllocation && (
            <span className="ml-3 text-xs text-text-secondary">
              Reusing allocation <span className="font-mono text-accent">#{existingAllocation.subscriptionId}</span>
            </span>
          )}
        </div>

        {hasProviderInfo && provider.description && (
          <p className="text-text-secondary text-xs leading-relaxed whitespace-pre-wrap">
            {provider.description}
          </p>
        )}
        {hasProviderInfo && provider.identity && (
          <div className="text-text-tertiary text-[11px]">
            Identity: <span className="font-mono text-text-secondary">{provider.identity}</span>
          </div>
        )}
      </div>

      {/* Hero KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          icon={<IconData className="w-4 h-4" />}
          label="Data"
          value={formatBytes(plan.bytes)}
          subtext={perGB !== null ? `${perGB.toFixed(4)} P2P / GB` : '—'}
        />
        <KpiCard
          icon={<IconClock className="w-4 h-4" />}
          label="Duration"
          value={formatDuration(plan.durationSeconds)}
          subtext={perDay !== null ? `${perDay.toFixed(4)} P2P / day` : '—'}
        />
        <KpiCard
          icon={<IconCoin className="w-4 h-4" />}
          label="Price"
          value={priceDisplay(plan)}
          subtext={udvpnRaw > 0 ? <span className="font-mono">{udvpnRaw} udvpn</span> : 'free'}
        />
        <KpiCard
          icon={<IconNode className="w-4 h-4" />}
          label="Nodes"
          value={nodesKpi.value}
          subtext={nodesKpi.subtext}
          tone={nodesKpi.tone}
          onClick={scrollToCompat}
        />
      </div>

      {/* Compatible Nodes */}
      <section
        id="compat-nodes-section"
        className="border border-border bg-bg-tertiary rounded-md overflow-hidden scroll-mt-4"
      >
        <div className="px-4 py-2 border-b border-border bg-bg-secondary flex items-center justify-between">
          <div className="flex items-center gap-2 relative">
            <h4 className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">
              Compatible Nodes
            </h4>
            <button
              onClick={() => setShowInfo((v) => !v)}
              onMouseEnter={() => setShowInfo(true)}
              onMouseLeave={() => setShowInfo(false)}
              className="text-text-tertiary hover:text-accent"
              aria-label="What are compatible nodes?"
            >
              <IconInfo className="w-3.5 h-3.5" />
            </button>
            {showInfo && (
              <div className="absolute left-0 top-full mt-1 z-20 w-80 bg-bg-secondary border border-border rounded-md shadow-lg p-3 text-[11px] text-text-secondary leading-relaxed">
                Nodes the provider has linked to this plan on-chain. Sessions using this plan run only on these nodes. Providers manage this list themselves — most public plans leave it empty.
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {nodesState &&
              nodesState !== 'loading' &&
              nodesState !== 'error' && (
                <span className="text-text-tertiary text-[10px] font-mono">
                  {nodesState.addresses.length}
                </span>
              )}
            <button
              onClick={onRetryNodes}
              disabled={nodesState === 'loading'}
              className="text-text-tertiary hover:text-accent text-[10px] uppercase tracking-wide disabled:opacity-30"
              title="Refetch from chain"
            >
              Retry
            </button>
          </div>
        </div>
        <div className="p-4">
          {(() => {
            if (!nodesState || nodesState === 'loading') {
              return (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-text-tertiary">
                    <Spinner className="text-accent" /> Loading compatible nodes…
                  </div>
                  <div className="text-text-tertiary text-[10px] font-mono pl-6">
                    Querying nodesForPlan on-chain…
                  </div>
                </div>
              )
            }
            if (nodesState === 'error') {
              return (
                <div className="space-y-2">
                  <div className="text-xs text-text-secondary">
                    Could not fetch compatible nodes from the chain.
                  </div>
                  <button
                    onClick={onRetryNodes}
                    className="text-accent text-xs hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )
            }
            if (nodesState.addresses.length === 0) {
              return (
                <div className="space-y-2">
                  <div>
                    <div className="text-text-primary text-sm font-medium">No nodes linked on-chain.</div>
                    <div className="text-text-secondary text-xs mt-1 leading-relaxed">
                      Providers decide which nodes accept this plan by linking them on-chain. Most
                      public plans leave this list empty — ask the provider, or pick a plan whose
                      provider has published linked nodes.
                    </div>
                  </div>
                  <button
                    onClick={onRetryNodes}
                    className="text-text-tertiary hover:text-accent text-[10px] uppercase tracking-wide border border-border hover:border-accent px-2 py-1 rounded-sm transition-colors"
                  >
                    Retry query
                  </button>
                </div>
              )
            }

            const rows = nodesState.addresses.map((addr) => ({
              addr,
              node: nodeIndex ? nodeIndex.get(addr) || null : null,
            }))
            const knownCount = rows.filter((r) => r.node !== null).length

            return (
              <div className="space-y-2">
                <div className="text-xs text-text-secondary">
                  {rows.length} node{rows.length === 1 ? '' : 's'} on-chain
                  {nodeIndex && ` · ${knownCount} resolved via node directory`}
                </div>
                {!nodeIndex && (
                  <div className="text-[11px] text-text-tertiary italic">
                    Node directory still loading — addresses will resolve to monikers/countries once it finishes.
                  </div>
                )}
                <div className="border border-border rounded-md divide-y divide-border max-h-[360px] overflow-y-auto">
                  {rows.map(({ addr, node }) => (
                    <div
                      key={addr}
                      className="px-3 py-2 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {node && <CountryFlag country={node.country} />}
                          <span className="text-text-primary truncate font-medium">
                            {node?.moniker || (node ? '(no moniker)' : 'Unknown node')}
                          </span>
                          {node?.isHealthy && (
                            <span className="text-success text-[9px]" title="Healthy">
                              ●
                            </span>
                          )}
                          {node?.isResidential && (
                            <span
                              className="text-[9px] text-accent border border-accent/40 bg-accent/10 px-1 rounded-sm uppercase"
                              title="Residential"
                            >
                              Res
                            </span>
                          )}
                          {!node && nodeIndex && (
                            <span
                              className="text-[9px] text-text-tertiary border border-border bg-bg-secondary px-1 rounded-sm uppercase"
                              title="Not in the current node directory — refresh Nodes tab"
                            >
                              Unknown
                            </span>
                          )}
                        </div>
                        <div className="text-text-tertiary font-mono truncate">
                          {addr.slice(0, 20)}…{addr.slice(-6)}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        {node ? (
                          <>
                            <div className="text-text-secondary">
                              {node.country}
                              {node.city ? `, ${node.city}` : ''}
                            </div>
                            <div
                              className={`text-[10px] font-medium ${protocolMeta(node.type).color}`}
                            >
                              {protocolMeta(node.type).label}
                            </div>
                          </>
                        ) : (
                          <div className="text-text-tertiary text-[10px]">—</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      </section>

      {/* How to use */}
      <div className="bg-info-subtle border border-info rounded-md p-3 text-xs text-text-secondary leading-relaxed">
        <div className="text-info font-medium mb-1">How to use this plan</div>
        Plans pre-pay a data bundle. Subscribe once, then connect to any compatible node using
        that single allocation — no extra fees per node. After subscribing, your plan appears in{' '}
        <span className="text-text-primary">Your Plan Subscriptions</span> below; click{' '}
        <span className="text-text-primary">Connect</span> there to pick a node, or use the Nodes
        tab and the app will reuse this allocation automatically.
      </div>
    </div>
  )
}

interface KpiCardProps {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  subtext: React.ReactNode
  tone?: 'accent' | 'muted' | 'loading'
  onClick?: () => void
}

function KpiCard({ icon, label, value, subtext, tone = 'accent', onClick }: KpiCardProps) {
  const toneClass =
    tone === 'muted'
      ? 'text-text-tertiary'
      : tone === 'loading'
      ? 'text-accent'
      : 'text-text-primary'
  const clickable = onClick !== undefined
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left border border-border bg-bg-tertiary rounded-md p-3 transition-all ${
        clickable ? 'hover:border-accent/60 hover:bg-bg-hover cursor-pointer' : 'cursor-default'
      } disabled:cursor-default`}
    >
      <div className="flex items-center gap-1.5 text-text-tertiary text-[10px] uppercase tracking-wide font-medium mb-1.5">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <div className={`text-lg font-semibold ${toneClass} leading-tight`}>{value}</div>
      <div className="text-text-tertiary text-[10px] mt-0.5 truncate">{subtext}</div>
    </button>
  )
}

interface AllocationConnectModalProps {
  allocation: PlanAllocation
  nodeIndex: Map<string, SentNode> | null
  onClose: () => void
}

function AllocationConnectModal({ allocation, nodeIndex, onClose }: AllocationConnectModalProps) {
  const [addresses, setAddresses] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Protocol of the session we already paid for — lets a failed bring-up be
  // retried against it instead of starting a second session.
  const [paidProtocol, setPaidProtocol] = useState<TunnelProtocol | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const { udvpn, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()

  // The allocation is prepaid, so only gas is due. No balance line is shown here —
  // it would muddy the "no new charge" framing — just the warning if it's short.
  const funds = udvpn === null ? null : checkFunds(udvpn, 0)
  const cantAfford = funds !== null && !funds.ok

  useEffect(() => {
    let cancelled = false
    window.api
      .planNodes(allocation.planId)
      .then((addrs) => {
        if (!cancelled) setAddresses(addrs)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load nodes')
      })
    return () => {
      cancelled = true
    }
  }, [allocation.planId])

  useEffect(() => {
    const unsub = window.api.onConnectionProgress((step) => setCurrentStep(step))
    return unsub
  }, [])

  // Resolve nodes (the chain returns addresses; we look up moniker/country/type
  // from the node directory, which the parent already loaded).
  const candidates = useMemo(() => {
    if (!addresses) return null
    const list: { addr: string; node: SentNode | null }[] = []
    for (const addr of addresses) {
      list.push({ addr, node: nodeIndex?.get(addr) ?? null })
    }
    // Surface healthy active nodes first; unknown last.
    list.sort((a, b) => {
      const ah = a.node?.isActive && a.node?.isHealthy ? 0 : a.node ? 1 : 2
      const bh = b.node?.isActive && b.node?.isHealthy ? 0 : b.node ? 1 : 2
      return ah - bh
    })
    return list
  }, [addresses, nodeIndex])

  const selected = selectedAddr ? candidates?.find((c) => c.addr === selectedAddr) ?? null : null

  async function handleConnect() {
    if (!selected || !selected.node) return
    setConnecting(true)
    setError(null)
    setCurrentStep('1/5')
    try {
      const res = await window.api.planStartSessionFromSub({
        subscriptionId: allocation.subscriptionId,
        nodeAddress: selected.node.address,
        nodeMoniker: selected.node.moniker,
        nodeCountry: selected.node.country,
        nodeType: selected.node.type,
        apiField: selected.node.api,
      })
      setSessionId(res.sessionId)
      const tunnelProtocol = res.protocol as TunnelProtocol
      setPaidProtocol(tunnelProtocol)
      await connectTunnelOnly(tunnelProtocol)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  /** Tunnel bring-up alone — main reuses the paid session's stashed config. */
  async function connectTunnelOnly(protocol: TunnelProtocol, dnsFallback = false) {
    setCurrentStep('5/5')
    await window.api.connectionConnect({ protocol, ...(dnsFallback ? { dnsFallback: true } : {}) })
    setTunnelConnected(true)
  }

  async function handleRetryTunnel(dnsFallback = false) {
    if (!paidProtocol) return
    setConnecting(true)
    setError(null)
    try {
      await connectTunnelOnly(paidProtocol, dnsFallback)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await window.api.connectionDisconnect()
      setTunnelConnected(false)
      setSessionId(null)
      setPaidProtocol(null)
      setCurrentStep(null)
      onClose()
    } finally {
      setDisconnecting(false)
    }
  }

  const title = tunnelConnected ? 'VPN Active' : connecting ? 'Connecting…' : `Connect via Plan #${allocation.planId}`

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={connecting ? undefined : onClose}
    >
      <div
        className="bg-bg-secondary border border-border w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-text-primary text-base font-semibold">{title}</h2>
          {!connecting && (
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary text-lg transition-colors"
            >
              ×
            </button>
          )}
        </div>

        <div className="bg-accent/10 border border-accent/30 rounded-md px-3 py-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-accent font-mono">sub #{allocation.subscriptionId}</span>
            <span className="text-text-secondary font-mono">plan #{allocation.planId}</span>
          </div>
          <div className="text-text-secondary mt-1">
            Reusing this allocation — no new on-chain subscription will be created.
          </div>
        </div>

        {!tunnelConnected && !connecting && !error && (
          <>
            <div className="text-xs text-text-secondary">
              Pick a node linked to this plan:
            </div>
            {loadError ? (
              <div className="bg-danger-subtle border border-danger p-3 rounded-md text-danger text-sm">
                {loadError}
              </div>
            ) : candidates === null ? (
              <div className="border border-border bg-bg-tertiary rounded-md px-4 py-6 text-center">
                <Spinner />
                <p className="text-text-secondary text-sm mt-2">Loading linked nodes…</p>
              </div>
            ) : candidates.length === 0 ? (
              <div className="border border-border bg-bg-tertiary rounded-md px-4 py-6 text-center text-text-secondary text-sm">
                No nodes are currently linked to this plan.
              </div>
            ) : (
              <div className="border border-border bg-bg-tertiary rounded-md max-h-[260px] overflow-y-auto divide-y divide-border">
                {candidates.map(({ addr, node }) => {
                  const active = selectedAddr === addr
                  const status = node ? nodeStatusMeta(node) : null
                  return (
                    <button
                      key={addr}
                      type="button"
                      onClick={() => node && setSelectedAddr(addr)}
                      disabled={!node}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                        active
                          ? 'bg-accent/10'
                          : node
                          ? 'hover:bg-bg-hover'
                          : 'opacity-40 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`flex items-center gap-1.5 min-w-0 font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
                          {node && <CountryFlag country={node.country} />}
                          <span className="truncate">
                            {node?.moniker || `${addr.slice(0, 16)}…${addr.slice(-6)}`}
                          </span>
                        </span>
                        {node && (
                          <span className={`text-[10px] font-medium ${protocolMeta(node.type).color}`}>
                            {protocolMeta(node.type).label}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-xs text-text-secondary mt-0.5">
                        <span>
                          {node ? (
                            <>
                              {node.country}
                              {node.city ? `, ${node.city}` : ''}
                            </>
                          ) : (
                            'Not in node directory — refresh Nodes tab'
                          )}
                        </span>
                        {status && (
                          <span className={status.textClass} title={status.detail}>
                            {status.label}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {cantAfford && (
              <InsufficientFunds
                message={insufficientFundsMessage(funds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}

            <button
              onClick={handleConnect}
              disabled={!selected || !selected.node || !isNodeConnectable(selected.node) || !isProtocolSupported(selected.node.type) || cantAfford}
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Connect via Existing Plan
            </button>
            {selected?.node && !isProtocolSupported(selected.node.type) && (
              <div className="text-xs text-warning text-center pt-2">
                {protocolMeta(selected.node.type).label} isn't supported by this client yet — pick a node running a supported protocol.
              </div>
            )}
          </>
        )}

        {connecting && <ProgressSteps currentStep={currentStep} error={error} />}

        {error && !connecting && (
          <ConnectErrorActions
            error={error}
            paidSessionId={paidProtocol ? sessionId : null}
            onRetryTunnel={() => handleRetryTunnel()}
            onRetryWithoutDns={paidProtocol ? () => handleRetryTunnel(true) : undefined}
            onStartOver={() => {
              setError(null)
              setCurrentStep(null)
              setSessionId(null)
              setPaidProtocol(null)
            }}
          />
        )}

        {tunnelConnected && sessionId && selected?.node && (
          <div className="space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">Session ID</span>
                <span className="text-success font-mono">{sessionId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Node</span>
                <span className="text-text-primary">{selected.node.moniker}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="status-dot status-dot-active" />
              <span className="text-success font-medium">VPN tunnel active</span>
            </div>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="btn btn-danger w-full flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {disconnecting ? (
                <>
                  <Spinner className="text-white" /> Disconnecting…
                </>
              ) : (
                'Disconnect'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

interface PlanSubscribeModalProps {
  plan: PlanInfo
  nodeIndex: Map<string, SentNode> | null
  provider: ProviderState | undefined
  onClose: () => void
}

function PlanSubscribeModal({ plan, nodeIndex, provider, onClose }: PlanSubscribeModalProps) {
  const [addresses, setAddresses] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null)
  const { udvpn, display: balance, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Protocol of the session we already paid for — lets a failed bring-up be
  // retried against it instead of subscribing (and paying) a second time.
  const [paidProtocol, setPaidProtocol] = useState<TunnelProtocol | null>(null)
  // Auto-renewal policy for the subscription this creates. 7 (always) is what the
  // app used to hardcode, so it stays the default.
  const [renewalPolicy, setRenewalPolicy] = useState(7)
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .planNodes(plan.id)
      .then((addrs) => {
        if (!cancelled) setAddresses(addrs)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load nodes')
      })
    return () => {
      cancelled = true
    }
  }, [plan.id])

  useEffect(() => {
    const unsub = window.api.onConnectionProgress((step) => setCurrentStep(step))
    return unsub
  }, [])

  // null while the balance is unknown — an unreadable balance must never grey out
  // the pay button; main re-checks against a fresh one before broadcasting.
  const funds = udvpn === null ? null : checkFunds(udvpn, priceUdvpn(plan))
  const cantAfford = funds !== null && !funds.ok

  const candidates = useMemo(() => {
    if (!addresses) return null
    const list: { addr: string; node: SentNode | null }[] = []
    for (const addr of addresses) {
      list.push({ addr, node: nodeIndex?.get(addr) ?? null })
    }
    list.sort((a, b) => {
      const ah = a.node?.isActive && a.node?.isHealthy ? 0 : a.node ? 1 : 2
      const bh = b.node?.isActive && b.node?.isHealthy ? 0 : b.node ? 1 : 2
      return ah - bh
    })
    return list
  }, [addresses, nodeIndex])

  const selected = selectedAddr ? candidates?.find((c) => c.addr === selectedAddr) ?? null : null
  const priceLabel = priceDisplay(plan)
  const providerName =
    provider && typeof provider === 'object' && provider !== null && provider.name
      ? provider.name
      : `${plan.provAddress.slice(0, 12)}…${plan.provAddress.slice(-6)}`

  async function handleConnect() {
    if (!selected || !selected.node) return
    setConnecting(true)
    setError(null)
    setCurrentStep('1/5')
    try {
      const res = await window.api.planSubscribe({
        planId: plan.id,
        denom: 'udvpn',
        renewalPolicy,
        nodeAddress: selected.node.address,
        nodeMoniker: selected.node.moniker,
        nodeCountry: selected.node.country,
        nodeType: selected.node.type,
        apiField: selected.node.api,
      })
      setSessionId(res.sessionId)
      const tunnelProtocol = res.protocol as TunnelProtocol
      setPaidProtocol(tunnelProtocol)
      await connectTunnelOnly(tunnelProtocol)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  /** Tunnel bring-up alone — main reuses the paid session's stashed config. */
  async function connectTunnelOnly(protocol: TunnelProtocol, dnsFallback = false) {
    setCurrentStep('5/5')
    await window.api.connectionConnect({ protocol, ...(dnsFallback ? { dnsFallback: true } : {}) })
    setTunnelConnected(true)
  }

  async function handleRetryTunnel(dnsFallback = false) {
    if (!paidProtocol) return
    setConnecting(true)
    setError(null)
    try {
      await connectTunnelOnly(paidProtocol, dnsFallback)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await window.api.connectionDisconnect()
      setTunnelConnected(false)
      setSessionId(null)
      setPaidProtocol(null)
      setCurrentStep(null)
      onClose()
    } finally {
      setDisconnecting(false)
    }
  }

  const title = tunnelConnected ? 'VPN Active' : connecting ? 'Connecting…' : `Subscribe to Plan #${plan.id}`

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={connecting ? undefined : onClose}
    >
      <div
        className="bg-bg-secondary border border-border w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-text-primary text-base font-semibold">{title}</h2>
          {!connecting && (
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary text-lg transition-colors"
            >
              ×
            </button>
          )}
        </div>

        <div className="space-y-2 text-sm border-b border-border pb-4">
          <div className="flex justify-between">
            <span className="text-text-secondary">Provider</span>
            <span className="text-text-primary truncate ml-4">{providerName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Data</span>
            <span className="text-text-primary">{formatBytes(plan.bytes)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Duration</span>
            <span className="text-text-primary">{formatDuration(plan.durationSeconds)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Price</span>
            <span className="text-accent font-mono font-semibold">{priceLabel}</span>
          </div>
          {balance !== null && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Wallet balance</span>
              <span className="text-success font-mono">{balance} P2P</span>
            </div>
          )}
        </div>

        {!tunnelConnected && !connecting && !error && (
          <>
            <div className="text-xs text-text-secondary">Pick a node to connect to:</div>
            {loadError ? (
              <div className="bg-danger-subtle border border-danger p-3 rounded-md text-danger text-sm">
                {loadError}
              </div>
            ) : candidates === null ? (
              <div className="border border-border bg-bg-tertiary rounded-md px-4 py-6 text-center">
                <Spinner />
                <p className="text-text-secondary text-sm mt-2">Loading linked nodes…</p>
              </div>
            ) : candidates.length === 0 ? (
              <div className="border border-border bg-bg-tertiary rounded-md px-4 py-6 text-center text-text-secondary text-sm">
                No nodes are currently linked to this plan.
              </div>
            ) : (
              <div className="border border-border bg-bg-tertiary rounded-md max-h-[260px] overflow-y-auto divide-y divide-border">
                {candidates.map(({ addr, node }) => {
                  const active = selectedAddr === addr
                  const status = node ? nodeStatusMeta(node) : null
                  return (
                    <button
                      key={addr}
                      type="button"
                      onClick={() => node && setSelectedAddr(addr)}
                      disabled={!node}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                        active
                          ? 'bg-accent/10'
                          : node
                          ? 'hover:bg-bg-hover'
                          : 'opacity-40 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`flex items-center gap-1.5 min-w-0 font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
                          {node && <CountryFlag country={node.country} />}
                          <span className="truncate">
                            {node?.moniker || `${addr.slice(0, 16)}…${addr.slice(-6)}`}
                          </span>
                        </span>
                        {node && (
                          <span className={`text-[10px] font-medium ${protocolMeta(node.type).color}`}>
                            {protocolMeta(node.type).label}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-xs text-text-secondary mt-0.5">
                        <span>
                          {node ? (
                            <>
                              {node.country}
                              {node.city ? `, ${node.city}` : ''}
                            </>
                          ) : (
                            'Not in node directory — refresh Nodes tab'
                          )}
                        </span>
                        {status && (
                          <span className={status.textClass} title={status.detail}>
                            {status.label}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            <label className="flex items-center justify-between gap-3 text-xs text-text-secondary">
              <span>When this subscription expires</span>
              <select
                value={renewalPolicy}
                onChange={(e) => setRenewalPolicy(parseInt(e.target.value, 10))}
                className="bg-bg-tertiary border border-border text-text-primary text-xs px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus"
              >
                {RENEWAL_POLICY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>

            {cantAfford && (
              <InsufficientFunds
                message={insufficientFundsMessage(funds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}

            <button
              onClick={handleConnect}
              disabled={!selected || !selected.node || !isNodeConnectable(selected.node) || !isProtocolSupported(selected.node.type) || cantAfford}
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Subscribe & Connect
            </button>
            {selected?.node && !isProtocolSupported(selected.node.type) && (
              <div className="text-xs text-warning text-center pt-2">
                {protocolMeta(selected.node.type).label} isn't supported by this client yet — pick a node running a supported protocol.
              </div>
            )}
          </>
        )}

        {connecting && <ProgressSteps currentStep={currentStep} error={error} />}

        {error && !connecting && (
          <ConnectErrorActions
            error={error}
            paidSessionId={paidProtocol ? sessionId : null}
            onRetryTunnel={() => handleRetryTunnel()}
            onRetryWithoutDns={paidProtocol ? () => handleRetryTunnel(true) : undefined}
            onStartOver={() => {
              setError(null)
              setCurrentStep(null)
              setSessionId(null)
              setPaidProtocol(null)
            }}
          />
        )}

        {tunnelConnected && sessionId && selected?.node && (
          <div className="space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">Session ID</span>
                <span className="text-success font-mono">{sessionId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Node</span>
                <span className="text-text-primary">{selected.node.moniker}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="status-dot status-dot-active" />
              <span className="text-success font-medium">VPN tunnel active</span>
            </div>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="btn btn-danger w-full flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {disconnecting ? (
                <>
                  <Spinner className="text-white" /> Disconnecting…
                </>
              ) : (
                'Disconnect'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
