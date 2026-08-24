import { useEffect, useMemo, useState } from 'react'
import type { PlanInfo, ProviderInfo, TokenPrice } from '../../types'
import { usePlansContext } from '../../contexts/PlansContext'
import { useNavigation } from '../../contexts/NavigationContext'
import { formatBytes, formatDuration, planPriceDisplay, pricePerGb, formatPerGb } from '../../utils/format'
import PlanDetailPane from './PlanDetailPane'

type SortBy = 'per-gb' | 'price' | 'data' | 'duration'

const SORT_LABELS: Record<SortBy, string> = {
  'per-gb': 'Price per GB',
  price: 'Price',
  data: 'Data',
  duration: 'Duration',
}

/**
 * Sort keys. Plans without a udvpn price sort AFTER every priced plan on the
 * price keys (they used to read as free and sort first).
 */
function sortValue(plan: PlanInfo, by: SortBy): number {
  switch (by) {
    case 'per-gb': {
      const v = pricePerGb(plan)
      return v === null ? Number.MAX_VALUE : v
    }
    case 'price': {
      const { udvpn } = planPriceDisplay(plan.prices)
      return udvpn === null ? Number.MAX_VALUE : udvpn
    }
    case 'data':
      return -Number(plan.bytes)
    case 'duration':
      return -(plan.durationSeconds ?? 0)
  }
}

/**
 * Browse the catalog: search, sort, select. Every cached plan lists
 * immediately; node availability is checked on selection (the detail pane)
 * and inside smart connect, never as a bulk scan on load (the old tab's
 * default filter started the list empty and grew it over hundreds of
 * requests).
 */
export default function PlanCatalog() {
  const { overview } = usePlansContext()
  const { plansNodeFilter, clearPlansNodeFilter } = useNavigation()
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('per-gb')
  // Hide plans whose availability scan counted ZERO nodes (nothing to connect
  // to, so nothing to buy). On by default; plans never counted (null) stay
  // visible either way, and the count line below says what is hidden.
  const [readyOnly, setReadyOnly] = useState(true)
  const [showTests, setShowTests] = useState(false)
  const [showPrivate, setShowPrivate] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [tokenPrice, setTokenPrice] = useState<TokenPrice | null>(null)
  // Plan ids containing the node the user arrived from (ConnectionModal's
  // "See Plans tab"). null = no filter or still resolving.
  const [nodeFilterPlanIds, setNodeFilterPlanIds] = useState<Set<string> | null>(null)

  useEffect(() => {
    window.api.providerList().then(setProviders).catch(() => setProviders([]))
    window.api.priceToken().then(setTokenPrice).catch(() => setTokenPrice(null))
  }, [])

  useEffect(() => {
    if (!plansNodeFilter) {
      setNodeFilterPlanIds(null)
      return
    }
    let cancelled = false
    window.api.planListForNode(plansNodeFilter)
      .then((plans) => { if (!cancelled) setNodeFilterPlanIds(new Set(plans.map((p) => p.id))) })
      .catch(() => { if (!cancelled) setNodeFilterPlanIds(new Set()) })
    return () => { cancelled = true }
  }, [plansNodeFilter])

  const providerByAddr = useMemo(() => new Map(providers.map((p) => [p.address, p])), [providers])
  const activeSubByPlan = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of overview.allocations) {
      if (a.status === 1) m.set(a.planId, a.subscriptionId)
    }
    return m
  }, [overview.allocations])

  const { filtered, hiddenNodeless } = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = overview.plans.filter((p) => p.status === 1)
    if (!showTests) list = list.filter((p) => !p.isTest)
    if (!showPrivate) list = list.filter((p) => !p.private)
    if (nodeFilterPlanIds) list = list.filter((p) => nodeFilterPlanIds.has(p.id))
    if (q) {
      list = list.filter((p) => {
        const prov = providerByAddr.get(p.provAddress)
        return p.id.includes(q) ||
          p.provAddress.toLowerCase().includes(q) ||
          (prov && (prov.name.toLowerCase().includes(q) || prov.description.toLowerCase().includes(q)))
      })
    }
    // Only a COUNTED zero hides a plan; nodeCount null (never scanned) stays.
    let hiddenNodeless = 0
    if (readyOnly) {
      const before = list.length
      list = list.filter((p) => p.nodeCount !== 0)
      hiddenNodeless = before - list.length
    }
    const sorted = [...list].sort((a, b) =>
      sortValue(a, sortBy) - sortValue(b, sortBy) || Number(a.id) - Number(b.id))
    return { filtered: sorted, hiddenNodeless }
  }, [overview.plans, search, sortBy, readyOnly, showTests, showPrivate, nodeFilterPlanIds, providerByAddr])

  const selected = selectedId ? filtered.find((p) => p.id === selectedId) ?? null : null

  return (
    <div className="flex-1 flex min-h-0">
      {/* Catalog list */}
      <div className="w-[46%] min-w-[320px] border-r border-border flex flex-col min-h-0">
        <div className="p-4 space-y-2.5 border-b border-border shrink-0">
          {plansNodeFilter && (
            <div className="bg-accent/10 border border-accent/40 rounded-md px-3 py-1.5 text-xs text-text-secondary flex items-center gap-2">
              <span className="flex-1">
                Showing plans that include node <span className="font-mono text-text-primary">{plansNodeFilter.slice(0, 14)}...</span>
              </span>
              <button onClick={clearPlansNodeFilter} className="text-accent hover:underline shrink-0">
                Show all
              </button>
            </div>
          )}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plans and providers"
            className="w-full bg-bg-tertiary border border-border text-text-primary text-sm px-3 py-1.5 rounded-sm focus:outline-none focus:border-border-focus placeholder:text-text-tertiary"
          />
          <div className="flex items-center gap-3 text-xs">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="bg-bg-tertiary border border-border text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus"
            >
              {(Object.keys(SORT_LABELS) as SortBy[]).map((k) => (
                <option key={k} value={k}>Sort: {SORT_LABELS[k]}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 cursor-pointer text-text-secondary">
              <input type="checkbox" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} className="accent-accent" />
              Ready to connect
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-text-secondary">
              <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} className="accent-accent" />
              Test plans
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-text-secondary">
              <input type="checkbox" checked={showPrivate} onChange={(e) => setShowPrivate(e.target.checked)} className="accent-accent" />
              Private
            </label>
          </div>
          {hiddenNodeless > 0 && (
            <p className="text-text-tertiary text-xs">
              {hiddenNodeless} plan{hiddenNodeless === 1 ? '' : 's'} with no linked nodes hidden.{' '}
              <button type="button" onClick={() => setReadyOnly(false)} className="text-accent hover:underline">
                Show all
              </button>
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {filtered.length === 0 ? (
            <p className="text-text-secondary text-sm p-4">
              {overview.plans.length === 0
                ? 'No plans in the catalog yet. Rescan to load them from the chain.'
                : 'No plans match these filters.'}
            </p>
          ) : (
            filtered.map((plan) => {
              const price = planPriceDisplay(plan.prices)
              const perGb = pricePerGb(plan)
              const prov = providerByAddr.get(plan.provAddress)
              const subscribed = activeSubByPlan.has(plan.id)
              return (
                <button
                  key={plan.id}
                  onClick={() => setSelectedId(plan.id)}
                  className={`w-full text-left px-4 py-2.5 border-b border-border transition-colors ${
                    selectedId === plan.id ? 'bg-accent/10' : 'hover:bg-bg-tertiary'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-accent font-semibold">{formatBytes(plan.bytes)}</span>
                    <span className="text-text-secondary">{formatDuration(plan.durationSeconds)}</span>
                    {subscribed && (
                      <span className="text-[10px] font-mono uppercase bg-success/15 text-success px-1.5 py-0.5 rounded-sm">subscribed</span>
                    )}
                    {plan.isTest && (
                      <span className="text-[10px] font-mono uppercase bg-warning-subtle text-warning px-1.5 py-0.5 rounded-sm">test</span>
                    )}
                    <span className="ml-auto text-text-primary font-mono text-xs">
                      {price.amount ? `${price.amount} ${price.denomLabel}` : 'no price'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5">
                    <span className="truncate min-w-0">
                      {prov?.name || `${plan.provAddress.slice(0, 14)}...`}
                    </span>
                    <span className="font-mono shrink-0">#{plan.id}</span>
                    {plan.nodeCount !== null && plan.nodeCount > 0 && (
                      <span className="text-success shrink-0">
                        {plan.nodeCount} node{plan.nodeCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {plan.nodeCount === 0 && <span className="text-warning shrink-0">no nodes</span>}
                    {perGb !== null && <span className="ml-auto shrink-0">{formatPerGb(perGb)} P2P/GB</span>}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* Detail pane */}
      {selected ? (
        <PlanDetailPane
          key={selected.id}
          plan={selected}
          provider={providerByAddr.get(selected.provAddress) ?? null}
          tokenPrice={tokenPrice}
          activeSubscriptionId={activeSubByPlan.get(selected.id) ?? null}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
          Select a plan to see its details
        </div>
      )}
    </div>
  )
}
