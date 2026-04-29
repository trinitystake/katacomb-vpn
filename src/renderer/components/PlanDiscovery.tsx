import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlans } from '../hooks/usePlans'
import { useSettings } from '../contexts/SettingsContext'
import type { PlanInfo, ProviderInfo, SentNode } from '../types'
import Spinner from './Spinner'

const UNLIMITED_BYTES_THRESHOLD = 1024 ** 5 // 1 PiB — anything larger is a pseudo-unlimited sentinel set by the provider

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
type Visibility = 'all' | 'public' | 'private'
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

function hasResolvedNodes(state: NodeListState | undefined): state is { addresses: string[] } {
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
  const { settings } = useSettings()
  const { plans, fetchedAt, allocations, discovering, progress, discover } = usePlans()
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [providers, setProviders] = useState<Record<string, ProviderState>>({})
  const [planNodes, setPlanNodes] = useState<Record<string, NodeListState>>({})
  const [nodeIndex, setNodeIndex] = useState<Map<string, SentNode> | null>(null)
  const fetchedProviderAddrs = useRef<Set<string>>(new Set())

  // Filter state
  const [visibility, setVisibility] = useState<Visibility>('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('price')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [freeOnly, setFreeOnly] = useState(false)
  const [hasNodesOnly, setHasNodesOnly] = useState(false)
  const [subscribedOnly, setSubscribedOnly] = useState(false)

  // Sidebar provider group collapse state. Absent key = collapsed.
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})

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
      const max = settings?.planDiscoveryMaxId ?? 500
      await discover(max)
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
      } catch {
        setProviders((prev) => {
          const next = { ...prev }
          for (const addr of planAddrs) next[addr] = null
          return next
        })
      }
    }
    run()
  }, [plans])

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

  function retryPlanNodes(planId: string) {
    setPlanNodes((prev) => {
      const next = { ...prev }
      delete next[planId]
      return next
    })
  }

  // Counts for the visibility pills
  const counts = useMemo(() => {
    let pub = 0
    let priv = 0
    for (const p of plans) {
      if (p.private) priv++
      else pub++
    }
    return { all: plans.length, public: pub, private: priv }
  }, [plans])

  const hasNodesKnownCount = useMemo(() => {
    let n = 0
    for (const p of plans) if (hasResolvedNodes(planNodes[p.id])) n++
    return n
  }, [plans, planNodes])

  const anyFilterActive =
    visibility !== 'all' ||
    search.trim() !== '' ||
    freeOnly ||
    hasNodesOnly ||
    subscribedOnly ||
    sortBy !== 'price' ||
    sortDir !== 'asc'

  function clearAllFilters() {
    setVisibility('all')
    setSearch('')
    setFreeOnly(false)
    setHasNodesOnly(false)
    setSubscribedOnly(false)
    setSortBy('price')
    setSortDir('asc')
  }

  // Filter
  const filtered = useMemo(() => {
    let list = plans
    if (visibility === 'public') list = list.filter((p) => !p.private)
    else if (visibility === 'private') list = list.filter((p) => p.private)
    if (subscribedOnly) list = list.filter((p) => allocByPlanId.has(p.id))
    if (freeOnly) list = list.filter((p) => priceUdvpn(p) === 0)
    if (hasNodesOnly) list = list.filter((p) => hasResolvedNodes(planNodes[p.id]))
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
        return false
      })
    }
    return list
  }, [plans, visibility, subscribedOnly, freeOnly, hasNodesOnly, planNodes, allocByPlanId, search, providers])

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
                placeholder="Search plans, providers…"
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

            <div
              role="tablist"
              aria-label="Visibility filter"
              className="flex items-center bg-bg-tertiary border border-border rounded-md overflow-hidden"
            >
              {(['all', 'public', 'private'] as const).map((v) => {
                const active = visibility === v
                return (
                  <button
                    key={v}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setVisibility(v)}
                    className={`relative px-3 py-2 text-xs capitalize transition-colors flex items-center gap-1.5 border-l border-border first:border-l-0 ${
                      active
                        ? 'bg-accent/15 text-accent after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                    }`}
                  >
                    {v}
                    <span className="font-mono text-[10px] opacity-60">{counts[v]}</span>
                  </button>
                )
              })}
            </div>

            <FilterChip
              label="Free"
              active={freeOnly}
              onClick={() => setFreeOnly((v) => !v)}
            />
            <FilterChip
              label="Has nodes"
              count={hasNodesKnownCount}
              active={hasNodesOnly}
              onClick={() => setHasNodesOnly((v) => !v)}
              title={
                hasNodesKnownCount === 0
                  ? 'Open plans to load their node counts first'
                  : undefined
              }
            />
            <FilterChip
              label="Subscribed"
              count={allocations.length}
              active={subscribedOnly}
              onClick={() => setSubscribedOnly((v) => !v)}
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
              disabled={discovering}
              className="btn btn-primary text-xs px-3 py-2 disabled:opacity-30"
              title={
                plans.length === 0
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
            </div>
          )}
          {plans.length > 0 && filtered.length === 0 && (
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
            <PlanDetail
              plan={selectedPlan}
              provider={providers[selectedPlan.provAddress]}
              nodesState={planNodes[selectedPlan.id]}
              nodeIndex={nodeIndex}
              subscribedCount={allocByPlanId.get(selectedPlan.id) || 0}
              onRetryNodes={() => retryPlanNodes(selectedPlan.id)}
            />
          )}
        </div>
      </div>

      {/* Allocations footer */}
      {allocations.length > 0 && (
        <details className="border-t border-border shrink-0 bg-bg-secondary">
          <summary className="px-5 py-2 cursor-pointer text-text-secondary text-xs font-medium uppercase tracking-wide hover:text-text-primary list-none flex items-center justify-between">
            <span>Your Plan Subscriptions ({allocations.length})</span>
            <span className="text-text-tertiary text-[10px]">▼</span>
          </summary>
          <div className="max-h-[180px] overflow-y-auto px-5 pb-3 space-y-1.5">
            {allocations.map((a) => (
              <div
                key={a.subscriptionId}
                className="border border-border bg-bg-tertiary rounded-md px-3 py-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="text-accent font-mono">sub #{a.subscriptionId}</span>
                  <span className="text-text-secondary font-mono">plan #{a.planId}</span>
                </div>
                <div className="text-text-secondary text-xs mt-1">
                  {formatBytes(a.planBytes)} · {formatDuration(a.planDurationSeconds)}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
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
  onRetryNodes: () => void
}

function PlanDetail({
  plan,
  provider,
  nodesState,
  nodeIndex,
  subscribedCount,
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
                  <a
                    href={provider.website}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline text-xs break-all inline-flex items-center gap-1"
                  >
                    {provider.website}
                    <IconExternal className="w-3 h-3 shrink-0" />
                  </a>
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
                              className={`text-[10px] font-medium ${
                                node.type === 1 ? 'text-info' : 'text-warning'
                              }`}
                            >
                              {node.type === 1 ? 'WireGuard' : 'V2Ray'}
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
        Plans pre-pay a data bundle, but each VPN session still binds to one node at a time. Go to
        the <span className="text-text-primary">Nodes</span> tab, find one of the compatible nodes
        above (search by moniker or address), click Connect, and choose{' '}
        <span className="text-text-primary">Plan Subscription</span> in the dialog.
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
