import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNodes } from '../../hooks/useNodes'
import { useConnection } from '../../hooks/useConnection'
import { useNodeTest } from '../../hooks/useNodeTest'
import { useNodesContext } from '../../contexts/NodesContext'
import { useChainDraft } from '../../contexts/ChainDraftContext'
import {
  chainRowRank,
  chainRowState,
  isChainable,
  isCheckable,
  isVerifiedFor,
  udvpnPrice,
  type BillingType,
  type ChainRole,
} from '../../utils/chain-node'
import { formatP2p } from '../../../shared/funds'
import { COUNTRY_CODES } from '../../utils/country-codes'
import { nodeStatusMeta } from '../../utils/node-status'
import { protocolMeta } from '../../utils/protocols'
import NodeFilters from '../NodeFilters'
import ChainReviewModal from './ChainReviewModal'
import InfoTip from '../InfoTip'
import Spinner from '../Spinner'
import type { SentNode } from '../../types'

/**
 * How long the filter must hold still before its nodes are graded. Long enough that
 * typing a city name is one sweep rather than one per letter, short enough that
 * choosing a country feels immediate.
 */
const PROBE_SETTLE_MS = 250

/**
 * How many rows off the front of the sorted list are graded first. Every node in the
 * filtered set is graded (see `checkable`), this only decides the order, so that the
 * part of the list the user is looking at settles in the first chunk or two instead
 * of after every node in the country they didn't pick.
 *
 * A fixed count rather than "what is on screen": the list is virtualized, so the
 * visible set changes on every scroll and would restart the sweep continuously.
 */
const PROBE_HEAD = 50

/** Only v2ray and xray can be chained, so the protocol filter offers only those. */
const CHAIN_PROTOCOL_OPTIONS = [
  { value: 2, label: 'V2Ray' },
  { value: 4, label: 'XRAY' },
] as const

const CACHE_TTL = 10 * 60 * 1000

type SortKey = 'country' | 'city' | 'moniker' | 'type' | 'priceGb' | 'priceHr' | 'latency' | 'status' | 'eligibility'

/**
 * The Nodes tab's columns minus Peers (a chain hop is picked on eligibility, not on
 * how busy the node is) plus the eligibility grade, which is the column this whole page
 * turns on.
 *
 * Every one of them is sortable, and that is also what keeps the casing consistent: the
 * header row carries `uppercase`, but a <button> does not inherit it. While eligibility
 * was the one unsortable column it was the one plain <div>, so it alone rendered
 * "ELIG." among "Country" and "Latency". Don't make a header a non-button again.
 */
const COLUMNS: { key: SortKey; label: string; width: string }[] = [
  { key: 'country', label: 'Country', width: 'w-[160px]' },
  { key: 'city', label: 'City', width: 'w-[120px]' },
  { key: 'moniker', label: 'Moniker', width: 'flex-1 min-w-[140px]' },
  { key: 'type', label: 'Type', width: 'w-[80px]' },
  { key: 'eligibility', label: 'Eligibility', width: 'w-[110px]' },
  { key: 'priceGb', label: 'P2P/GB', width: 'w-[80px]' },
  { key: 'priceHr', label: 'P2P/Hr', width: 'w-[80px]' },
  { key: 'latency', label: 'Latency', width: 'w-[70px] justify-center' },
  { key: 'status', label: 'Status', width: 'w-[60px] justify-center' },
]

const TONE_CLASS = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-text-tertiary',
}

/**
 * Choose the two nodes of a chain: this host -> entry -> exit -> internet.
 *
 * A tab rather than a modal, and deliberately the same shape as the Nodes tab — a page
 * to choose on, a modal to commit in. Picking two nodes out of hundreds, each graded by
 * a probe that streams in over seconds, is a page-scale task, and it runs on the same
 * node data, the same filter bar and the same latency testing as a single hop rather
 * than a weaker copy of them.
 */
export default function MultihopView() {
  const { status, disconnect } = useConnection()
  const { results: testResults, testing: testingNodes, batchProgress, testBatch, cancelBatch, testNode } = useNodeTest()
  const { entry, exit, activeSlot, setActiveSlot, setSlot, clear, eligibility } = useChainDraft()

  const [verifiedOnly, setVerifiedOnly] = useState(false)
  // The pair under review, captured when Review is pressed rather than read live off
  // the draft. That is what lets the draft be cleared the moment the chain comes up:
  // rendered off the draft, clearing it would unmount the modal mid-success and take
  // the two session ids with it.
  const [reviewing, setReviewing] = useState<{ entry: SentNode; exit: SentNode } | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const latencyMap = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const [addr, result] of testResults) {
      map.set(addr, result.reachable ? result.latencyMs : null)
    }
    return map
  }, [testResults])

  // Scored here rather than in useNodes because the grade depends on which hop is
  // being chosen. Rebuilt as grades land, which is what makes an eligibility sort fill
  // in live; the probe key is address-sorted, so the reordering never restarts a sweep.
  const { allNodes } = useNodesContext()
  const eligibilityRank = useMemo(() => {
    const map = new Map<string, number>()
    for (const n of allNodes) {
      if (isChainable(n)) {
        map.set(n.address, chainRowRank(n, eligibility.results.get(n.address), activeSlot))
      }
    }
    return map
  }, [allNodes, eligibility.results, activeSlot])

  const {
    nodes: matches,
    totalCount,
    filter,
    updateFilter,
    sortKey,
    sortDir,
    toggleSort,
    loading,
    lastFetched,
    error,
    countries,
    cities,
    refresh,
    bookmarks,
    toggleBookmark,
  } = useNodes(latencyMap, isChainable, eligibilityRank)

  // Display only. The grading below deliberately runs on `matches`, not on this:
  // "Verified only" filters ON the grades, so probing what it leaves would freeze the
  // list at whatever happened to be graded when it was ticked and silently hide every
  // verified node outside that.
  const rows = useMemo(
    () => (verifiedOnly
      ? matches.filter((n) => isVerifiedFor(eligibility.results.get(n.address), activeSlot))
      : matches),
    [matches, verifiedOnly, eligibility.results, activeSlot],
  )

  // Grade every CHECKABLE node in the filtered set, head of the list first. Pre-9.0.0
  // nodes are skipped rather than probed and reported unknown: they publish no inbound
  // list, so the request can only fail. That is most of the network, so skipping them
  // is also what keeps this affordable.
  const checkable = useMemo(() => {
    const head = matches.slice(0, PROBE_HEAD).filter(isCheckable)
    const inHead = new Set(head.map((n) => n.address))
    return [...head, ...matches.filter((n) => isCheckable(n) && !inHead.has(n.address))]
  }, [matches])
  // Sorted, because grades arriving change the list ORDER and an order-sensitive key
  // would retrigger the sweep on every one of them.
  const probeKey = useMemo(() => checkable.map((n) => n.address).sort().join(','), [checkable])

  const { probe } = eligibility
  // Settle before probing. The search box filters on every keystroke, and each new set
  // abandons the sweep in flight and starts one for the new one — so typing "toronto"
  // unthrottled would fire a chunk of 30 requests per letter. Each probe is an HTTPS
  // request from the user's own address, so a page opened and abandoned must not
  // announce itself to hundreds of operators. probe's identity is stable (it reads
  // results from a ref), so this timer is only reset by a real change of role or filter.
  useEffect(() => {
    // Called even when there is NOTHING to grade, which is what abandons the sweep in
    // flight. Abandonment happens inside probe() (it owns the run key), so an
    // `if (checkable.length === 0) return` here skipped it precisely when the user had
    // narrowed hardest: measured 2026-08-16, a search matching no rows left the previous
    // run to completion, 211 further nodes probed over 26 s, every one of them excluded
    // by the filter the user had just typed, with "Checking n/m" still counting up
    // against the old total. probe() handles an empty list by standing the sweep down.
    // The key tells probe() whether this is the set it is already working or a new one
    // to switch to. Role is in it because the two ends are graded against different rules.
    const timer = setTimeout(() => { void probe(checkable, `${activeSlot}:${probeKey}`) }, PROBE_SETTLE_MS)
    return () => clearTimeout(timer)
    // probeKey stands in for `checkable`, which is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot, probeKey, probe])

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 20,
  })

  const alreadyConnected = status.state === 'connected' || status.state === 'reconnecting'
  // `chainExit` is set only while a two-hop chain is up, so it is what tells this
  // page's own product apart from any other tunnel.
  const chainActive = alreadyConnected && status.chainExit !== undefined
  // What the pair costs in BOTH units. Which one you are billed in is chosen in the
  // review modal, so quoting only one here reads as the price and is wrong half the
  // time. Either can be absent: a node need not quote udvpn for both.
  const pairPrice = (t: BillingType): number | null => {
    if (!entry || !exit) return null
    const a = udvpnPrice(entry, t)
    const b = udvpnPrice(exit, t)
    return a === null || b === null ? null : a + b
  }
  const perGb = pairPrice('gigabytes')
  const perHour = pairPrice('hours')

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border bg-bg-secondary px-4 py-3 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="text-sm">
            <p className="text-text-primary">Two hops: your device → entry → exit → the internet.</p>
            {/* "on its own" is load-bearing. The claim is about what ONE node can see,
                which is exactly what the two hops split. Two operators comparing notes
                still defeat it, and the review modal says so before any money moves. */}
            <p className="text-text-tertiary text-xs mt-0.5">
              Neither node on its own sees both who you are and where you go.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-text-secondary text-sm">{totalCount} chainable</span>
            <InfoTip label="Why both hops need TLS or Reality">
              Both hops of a chain must be wrapped in TLS or Reality, which is stricter than an
              ordinary connection. A VMess hop without TLS is still encrypted, but it is
              recognisable as a proxy to anyone watching the wire, and that is the thing a chain is
              bought to avoid. Nodes older than 9.0.0 publish nothing to check against that rule, so
              they are listed for context but cannot be picked.
            </InfoTip>
          </div>
        </div>

        {/* Two different facts, and reporting them the same way was alarming: the
            moment a chain came up, the page behind the success modal warned that a
            tunnel was in the way, about the chain the user had just paid for. A chain
            of our own is reported as the good news it is; anything else keeps the
            warning, because it really does have to go first. */}
        {alreadyConnected && (
          <div className={`border p-3 rounded-md flex items-center justify-between gap-4 ${
            chainActive ? 'bg-success-subtle border-success' : 'bg-warning-subtle border-warning'
          }`}>
            <div>
              {chainActive ? (
                <>
                  <p className="text-success text-sm flex items-center gap-2">
                    <span className="status-dot status-dot-active" />
                    Your chain is connected.
                  </p>
                  <p className="text-text-secondary text-xs">
                    {status.nodeMoniker || status.nodeCountry} → {status.chainExit?.moniker || status.chainExit?.country}
                    . Both hops are in the Sessions tab. Building another chain replaces this one.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-warning text-sm">A tunnel is already up.</p>
                  <p className="text-text-secondary text-xs">
                    Building a chain replaces it. Disconnect first. The current session stays paid and
                    can be reconnected from the Sessions tab.
                  </p>
                </>
              )}
            </div>
            <button
              onClick={async () => {
                setDisconnecting(true)
                try {
                  await disconnect()
                } finally {
                  setDisconnecting(false)
                }
              }}
              disabled={disconnecting}
              className="btn btn-danger text-xs px-3 py-1 disabled:opacity-50 shrink-0"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        )}

        {/* The hop rail. It holds what the wizard's step rail held — which hop you are
            on, and what is picked — but stays beside the list you pick from instead of
            replacing it. */}
        <div className="flex items-stretch gap-2">
          <HopSlot
            role="entry"
            node={entry}
            active={activeSlot === 'entry'}
            onActivate={() => setActiveSlot('entry')}
            onClear={() => setSlot('entry', null)}
          />
          <div className="flex items-center text-text-tertiary text-sm">→</div>
          <HopSlot
            role="exit"
            node={exit}
            active={activeSlot === 'exit'}
            onActivate={() => setActiveSlot('exit')}
            onClear={() => setSlot('exit', null)}
          />
          <div className="w-[190px] shrink-0 border border-border rounded-sm px-3 py-2 flex flex-col justify-between gap-1">
            <div className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-text-secondary">Both hops</span>
                {/* Empties the whole draft. The per-slot ✕ replaces one hop; this is the
                    way out of a pair you no longer want, and it is what takes the count
                    off the tab. */}
                {(entry || exit) && (
                  <button
                    onClick={clear}
                    className="text-text-tertiary hover:text-danger transition-colors"
                    title="Clear both hops"
                  >
                    Clear
                  </button>
                )}
              </div>
              {perGb === null && perHour === null ? (
                <span className="block text-text-tertiary">
                  {entry && exit ? 'No P2P price quoted.' : 'Pick two nodes.'}
                </span>
              ) : (
                <span className="block font-mono text-text-primary leading-tight">
                  {perGb !== null && <span className="block">{formatP2p(perGb)} P2P/GB</span>}
                  {perHour !== null && <span className="block">{formatP2p(perHour)} P2P/hr</span>}
                </span>
              )}
            </div>
            <button
              onClick={() => { if (entry && exit) setReviewing({ entry, exit }) }}
              disabled={!entry || !exit}
              className="btn btn-primary text-xs px-3 py-1 w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Review
            </button>
          </div>
        </div>
      </div>

      <NodeFilters
        filter={filter}
        updateFilter={updateFilter}
        countries={countries}
        cities={cities}
        totalCount={totalCount}
        filteredCount={rows.length}
        loading={loading}
        onRefresh={refresh}
        batchProgress={batchProgress}
        onTestBatch={() => {
          testBatch(rows.map((n) => ({ nodeAddress: n.address, remoteUrl: n.api })))
        }}
        onCancelBatch={cancelBatch}
        protocolOptions={CHAIN_PROTOCOL_OPTIONS}
      />

      <div className="border-b border-border px-4 py-2 flex items-center justify-between gap-4 text-xs">
        <div className="flex items-center gap-2 text-text-secondary">
          <span className="text-text-primary">
            Choosing the {activeSlot} node
          </span>
          <span className="text-text-tertiary">
            {activeSlot === 'entry'
              ? 'Your device dials it directly, so it sees your IP and not where you go.'
              : 'Reached only through the entry, setup included, so sites see its location instead of yours.'}
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {eligibility.progress && (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <Spinner className="text-accent" />
              Checking {eligibility.progress.done}/{eligibility.progress.total}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Verified {activeSlot === 'exit' ? 'exits' : 'entries'} only
          </label>
        </div>
      </div>

      {/* With a list in hand a failed refresh only makes it stale — the filter bar's
          timestamp already says so, and blanking the table would be worse. */}
      {!lastFetched ? (
        error ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="max-w-sm text-center flex flex-col items-center gap-3">
              <div className="text-text-primary text-sm">Couldn't load the node directory</div>
              <div className="text-text-secondary text-xs break-words">{error}</div>
              <button onClick={refresh} disabled={loading} className="btn btn-secondary text-xs px-3 py-1.5 disabled:opacity-50 flex items-center gap-1.5">
                {loading && <Spinner />}
                Retry
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-text-secondary text-sm flex items-center gap-2">
              <Spinner />
              Loading nodes...
            </div>
          </div>
        )
      ) : (
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div className="sticky top-0 z-10 flex items-center px-4 py-2 border-b border-border bg-bg-secondary text-text-secondary text-xs font-medium uppercase tracking-wide select-none">
          <div className="w-[28px] shrink-0" />
          {COLUMNS.map((col) => (
            <button
              key={col.key}
              onClick={() => toggleSort(col.key)}
              className={`${col.width} text-left hover:text-accent transition-colors flex items-center gap-1 shrink-0`}
              title={col.key === 'eligibility' ? 'Sort by eligibility for this hop, pickable first' : undefined}
            >
              {col.label}
              {sortKey === col.key && (
                <span className="text-accent">{sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
            </button>
          ))}
        </div>

        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const node = rows[virtualRow.index]
            if (!node) return null
            const code = COUNTRY_CODES[node.country] || ''
            const nodeStatus = nodeStatusMeta(node)
            const otherHop = activeSlot === 'entry' ? exit : entry
            const takenByOtherHop = otherHop?.address === node.address
            const picked = (activeSlot === 'entry' ? entry : exit)?.address === node.address
            const state = chainRowState(node, eligibility.results.get(node.address), activeSlot)
            const selectable = state.selectable && !takenByOtherHop

            return (
              <div
                key={node.address}
                onClick={() => { if (selectable) setSlot(activeSlot, node) }}
                className={`absolute left-0 w-full flex items-center px-4 text-sm border-b transition-colors ${
                  picked
                    ? 'bg-success-subtle border-success'
                    : 'border-border'
                } ${
                  selectable ? 'cursor-pointer hover:bg-bg-hover' : 'opacity-40 cursor-not-allowed'
                }`}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); toggleBookmark(node.address) }}
                  className={`w-[28px] shrink-0 text-center transition-colors ${
                    bookmarks.has(node.address) ? 'text-warning' : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                  title={bookmarks.has(node.address) ? 'Remove bookmark' : 'Bookmark node'}
                >
                  {bookmarks.has(node.address) ? '★' : '☆'}
                </button>
                <div className="w-[160px] shrink-0 flex items-center gap-2 truncate">
                  {code && <span className={`fi fi-${code}`} style={{ fontSize: '12px', lineHeight: 1 }} />}
                  <span className="truncate">{node.country || '—'}</span>
                </div>
                <div className="w-[120px] shrink-0 truncate text-text-secondary">
                  {node.city || '—'}
                </div>
                <div className="flex-1 min-w-[140px] truncate text-text-primary">
                  {node.moniker || '—'}
                </div>
                <div className="w-[80px] shrink-0">
                  <span className={protocolMeta(node.type).color}>{protocolMeta(node.type).short}</span>
                </div>
                <div className={`w-[110px] shrink-0 truncate text-xs ${
                  takenByOtherHop ? 'text-text-tertiary' : TONE_CLASS[state.tone]
                }`} title={takenByOtherHop ? undefined : state.title}>
                  {takenByOtherHop
                    ? `picked as the ${activeSlot === 'entry' ? 'exit' : 'entry'}`
                    : state.badge}
                </div>
                <div className="w-[80px] shrink-0 text-text-secondary font-mono text-xs">
                  {formatPrice(node.gigabytePrices)}
                </div>
                <div className="w-[80px] shrink-0 text-text-secondary font-mono text-xs">
                  {formatPrice(node.hourlyPrices)}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); testNode(node.address, node.api) }}
                  disabled={testingNodes.has(node.address)}
                  className="w-[70px] shrink-0 text-center font-mono text-xs transition-colors hover:text-accent disabled:pointer-events-none"
                  title="Test node latency"
                >
                  {(() => {
                    if (testingNodes.has(node.address)) return <span className="text-text-tertiary">...</span>
                    const probeResult = testResults.get(node.address)
                    if (!probeResult) return <span className="text-text-tertiary">⏱</span>
                    const stale = Date.now() - probeResult.timestamp > CACHE_TTL
                    if (probeResult.reachable && probeResult.latencyMs !== null) {
                      return <span className={stale ? 'text-text-tertiary' : 'text-success'}>{probeResult.latencyMs}ms</span>
                    }
                    return <span className={stale ? 'text-text-tertiary' : 'text-danger'}>Fail</span>
                  })()}
                </button>
                <div className="w-[60px] shrink-0 flex justify-center">
                  <span
                    className={`status-dot ${nodeStatus.dotClass}`}
                    title={`${nodeStatus.label}: ${nodeStatus.detail}`}
                  />
                </div>
              </div>
            )
          })}
        </div>

        {rows.length === 0 && !loading && (
          <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
            {verifiedOnly
              ? 'No node here has been verified for this hop yet.'
              : 'No nodes match your filters'}
          </div>
        )}
      </div>
      )}

      {reviewing && (
        <ChainReviewModal
          entry={reviewing.entry}
          exit={reviewing.exit}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  )
}

function formatPrice(prices: { denom: string; value: string }[] | null | undefined): string {
  if (!prices) return '—'
  const p = prices.find((x) => x.denom === 'udvpn')
  if (!p) return '—'
  const val = parseInt(p.value, 10) / 1e6
  if (val >= 1000) return val.toLocaleString('en', { maximumFractionDigits: 0 })
  return val.toLocaleString('en', { maximumFractionDigits: 2 })
}

/**
 * One hop of the rail. Identity only, no price: the row it came from carries both the
 * per-GB and per-hour figure, and the pair's total is quoted once, next to Review.
 */
function HopSlot({ role, node, active, onActivate, onClear }: {
  role: ChainRole
  node: SentNode | null
  active: boolean
  onActivate: () => void
  onClear: () => void
}) {
  const code = node ? COUNTRY_CODES[node.country] || '' : ''
  return (
    <div
      onClick={onActivate}
      className={`flex-1 min-w-0 border rounded-sm px-3 py-2 cursor-pointer transition-colors ${
        active ? 'border-accent' : 'border-border hover:border-border-focus'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs uppercase tracking-wide ${active ? 'text-accent' : 'text-text-secondary'}`}>
          {role === 'entry' ? '1. Entry' : '2. Exit'}
        </span>
        {node && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear() }}
            className="text-text-tertiary hover:text-danger transition-colors text-xs px-1"
            title={`Clear the ${role} node`}
          >
            ✕
          </button>
        )}
      </div>
      {node ? (
        <>
          <div className="flex items-center gap-2 min-w-0">
            {code && <span className={`fi fi-${code} shrink-0`} style={{ fontSize: '12px', lineHeight: 1 }} />}
            <span className="text-text-primary text-sm truncate">{node.moniker || node.address}</span>
          </div>
          <div className="text-text-tertiary text-xs truncate">
            {node.country}{node.city ? `, ${node.city}` : ''}
            {node.asn ? ` · AS${node.asn}` : ''}
          </div>
        </>
      ) : (
        <div className="text-text-tertiary text-xs py-1">
          {active ? 'Pick a node below.' : 'Not picked yet.'}
        </div>
      )}
    </div>
  )
}
