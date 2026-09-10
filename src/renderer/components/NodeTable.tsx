import { useRef, useState, useMemo, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNodes } from '../hooks/useNodes'
import { useConnection } from '../hooks/useConnection'
import { useNodeTest } from '../hooks/useNodeTest'
import { useNavigation } from '../contexts/NavigationContext'
import NodeFilters from './NodeFilters'
import ConnectionModal from './ConnectionModal'
import Spinner from './Spinner'
import CountryFlag from './CountryFlag'
import { ChevronIcon, StarIcon } from './Icons'
import {
  NODE_COL,
  ROW_HEIGHT,
  NodeIdentityCell,
  TypeCell,
  PriceCell,
  LatencyCell,
  StatusCell,
} from './NodeCells'
import type { SentNode } from '../types'

type SortKey = 'country' | 'moniker' | 'type' | 'priceGb' | 'priceHr' | 'leases' | 'sessions' | 'peers' | 'latency' | 'status'

/**
 * Column widths come from NODE_COL (NodeCells.tsx), shared with the Multi-hop table,
 * so header and cell agree by construction.
 *
 * The sum is a hard constraint, not a preference: fixed columns
 * 132+110+96+60+72+60+72+80 = 682, plus px-4 (32) + the bookmark gutter (28) +
 * the identity column's 180px minimum = a 922px floor, against ~947px of content at
 * the 960px minWidth (main/index.ts, an OUTER window size on Linux, less Chromium's
 * ~11px thin scrollbar: global.css sets scrollbar-width before the 8px webkit rules,
 * so the standard property is what applies). That leaves the identity column 205px at
 * the minimum, enough for the moniker line and ~26 characters of address before the
 * ellipsis; at 1920px it shows the whole address. Past the floor the header's
 * background band and each row's border stop at the viewport edge while the cells
 * spill past them. Re-do this arithmetic before adding a column.
 *
 * Price is one column with two sort keys (priceHr, priceGb), rendered as two buttons
 * in the header: the entry is keyed priceHr so the active-sort lookup works for the
 * first, and the header map special-cases it for the second.
 *
 * The second column is labelled Location but keyed 'country': it renders country over
 * city and sorts by country. Keeping the key is what lets useNodes' shared default
 * ('country') stay valid for the Map and Multi-hop tabs.
 */
const COLUMNS: { key: SortKey; label: string; width: string }[] = [
  { key: 'moniker', label: 'Node', width: NODE_COL.identity },
  { key: 'country', label: 'Location', width: NODE_COL.location },
  { key: 'type', label: 'Type', width: NODE_COL.type },
  { key: 'priceHr', label: 'Price', width: `${NODE_COL.price} justify-end` },
  { key: 'leases', label: 'Leases', width: `${NODE_COL.leases} justify-center` },
  { key: 'sessions', label: 'Sessions', width: `${NODE_COL.sessions} justify-center` },
  { key: 'peers', label: 'Peers', width: `${NODE_COL.peers} justify-center` },
  { key: 'latency', label: 'Latency', width: `${NODE_COL.latency} justify-center` },
  { key: 'status', label: 'Status', width: `${NODE_COL.status} justify-center` },
]

export default function NodeTable() {
  const { status: connStatus } = useConnection()
  const connectedAddress = connStatus.state === 'connected' ? connStatus.nodeAddress : null
  const { results: testResults, testing: testingNodes, batchProgress, testBatch, cancelBatch, testNode } = useNodeTest()

  // Derived latency map drives the sort comparator in useNodes.
  const latencyMap = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const [addr, result] of testResults) {
      map.set(addr, result.reachable ? result.latencyMs : null)
    }
    return map
  }, [testResults])

  const {
    nodes,
    totalCount,
    filter,
    updateFilter,
    sortKey,
    sortDir,
    toggleSort,
    loading,
    lastFetched,
    error,
    refresh,
    bookmarks,
    toggleBookmark,
  } = useNodes(latencyMap)

  // Apply country filter handed off from the Map tab (one-shot).
  const { nodesCountryFilter, clearNodesCountryFilter } = useNavigation()
  useEffect(() => {
    if (nodesCountryFilter) {
      updateFilter({ country: nodesCountryFilter })
      clearNodesCountryFilter()
    }
  }, [nodesCountryFilter, updateFilter, clearNodesCountryFilter])

  const [selectedNode, setSelectedNode] = useState<SentNode | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  })

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return null
    return <ChevronIcon direction={sortDir === 'asc' ? 'up' : 'down'} className="w-3 h-3 text-accent" />
  }

  return (
    <div className="h-full flex flex-col">
      <NodeFilters
        filter={filter}
        updateFilter={updateFilter}
        totalCount={totalCount}
        filteredCount={nodes.length}
        loading={loading}
        lastFetched={lastFetched}
        onRefresh={refresh}
        batchProgress={batchProgress}
        onTestBatch={() => {
          const batch = nodes.map((n) => ({ nodeAddress: n.address, remoteUrl: n.api }))
          testBatch(batch)
        }}
        onCancelBatch={cancelBatch}
      />

      {/* With a list in hand a failed refresh only makes it stale, and blanking the
          table would be worse than showing the last good one. Only the no-list-at-all
          case gets the full-pane treatment. */}
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
      /* Virtualized rows */
      <div ref={parentRef} className="flex-1 overflow-auto">
        {/* Sticky header */}
        <div className="sticky top-0 z-10 flex items-center px-4 py-2 border-b border-border bg-bg-secondary text-text-secondary text-xs font-medium uppercase tracking-wide select-none">
          <div className={`${NODE_COL.bookmark} shrink-0`} />
          {COLUMNS.map((col) =>
            col.key === 'priceHr' ? (
              // One column, two sort targets, in the order the cell stacks them.
              <div key={col.key} className={`${col.width} flex items-center gap-1.5 shrink-0`} title="Price in P2P">
                <span>{col.label}</span>
                {(['priceHr', 'priceGb'] as const).map((key) => (
                  <button
                    key={key}
                    onClick={() => toggleSort(key)}
                    className={`normal-case hover:text-accent transition-colors flex items-center gap-0.5 ${
                      sortKey === key ? 'text-text-primary' : ''
                    }`}
                  >
                    {key === 'priceHr' ? '/hr' : '/GB'}
                    {sortIndicator(key)}
                  </button>
                ))}
              </div>
            ) : (
              <button
                key={col.key}
                onClick={() => toggleSort(col.key)}
                className={`${col.width} text-left hover:text-accent transition-colors flex items-center gap-1 shrink-0`}
              >
                {col.label}
                {sortIndicator(col.key)}
              </button>
            ),
          )}
        </div>

        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const node = nodes[virtualRow.index]
            if (!node) return null
            const isConnected = connectedAddress === node.address

            return (
              <div
                key={node.address}
                onClick={() => setSelectedNode(node)}
                // The 2px left edge is a pseudo-element so the row's padding, and the
                // width arithmetic above, stay untouched.
                className={`absolute left-0 w-full flex items-center px-4 text-sm cursor-pointer border-b transition-colors before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${
                  isConnected
                    ? 'bg-success-subtle border-success before:bg-success'
                    : 'border-border hover:bg-bg-hover hover:before:bg-accent'
                }`}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); toggleBookmark(node.address) }}
                  className={`${NODE_COL.bookmark} shrink-0 flex justify-center transition-colors ${
                    bookmarks.has(node.address) ? 'text-warning' : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                  title={bookmarks.has(node.address) ? 'Remove bookmark' : 'Bookmark node'}
                  aria-label={bookmarks.has(node.address) ? 'Remove bookmark' : 'Bookmark node'}
                >
                  <StarIcon filled={bookmarks.has(node.address)} className="w-3.5 h-3.5" />
                </button>
                <NodeIdentityCell node={node} onActivate={() => setSelectedNode(node)} />
                {/* leading-tight keeps the two lines a pair; at 48px the row no longer
                    depends on it to avoid clipping, but a third line still would. */}
                <div className={`${NODE_COL.location} shrink-0 leading-tight`}>
                  <div className="flex items-center gap-2">
                    <CountryFlag country={node.country} />
                    <span className="truncate">{node.country || '—'}</span>
                  </div>
                  {/* Always rendered, so every row is the same height. */}
                  <div className="text-[10px] text-text-secondary truncate">{node.city || '—'}</div>
                </div>
                <TypeCell node={node} />
                <PriceCell node={node} />
                {/* ?? '—' rather than bare interpolation: 0 is a real and common value that must
                    render as 0, while an absent count must not render as a blank cell. */}
                <div className={`${NODE_COL.leases} shrink-0 text-text-secondary text-center font-mono text-xs`}>
                  {node.leases ?? '—'}
                </div>
                <div className={`${NODE_COL.sessions} shrink-0 text-text-primary text-center font-mono text-xs`}>
                  {node.sessions ?? '—'}
                </div>
                <div className={`${NODE_COL.peers} shrink-0 text-text-primary text-center font-mono text-xs`}>
                  {node.peers}
                </div>
                <LatencyCell
                  probe={testResults.get(node.address)}
                  testing={testingNodes.has(node.address)}
                  onTest={() => testNode(node.address, node.api)}
                />
                <StatusCell node={node} connected={isConnected} />
              </div>
            )
          })}
        </div>

        {nodes.length === 0 && !loading && (
          <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
            No nodes match your filters
          </div>
        )}
      </div>
      )}

      {selectedNode && (
        <ConnectionModal
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  )
}
