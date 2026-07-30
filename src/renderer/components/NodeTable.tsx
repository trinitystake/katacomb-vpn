import { useRef, useState, useMemo, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNodes } from '../hooks/useNodes'
import { useConnection } from '../hooks/useConnection'
import { useNodeTest } from '../hooks/useNodeTest'
import { useNavigation } from '../contexts/NavigationContext'
import NodeFilters from './NodeFilters'
import ConnectionModal from './ConnectionModal'
import Spinner from './Spinner'
import type { SentNode } from '../types'
import { COUNTRY_CODES } from '../utils/country-codes'
import { v2rayConnectionBadge, isCleartextConnection } from '../utils/v2ray-connection'
import { nodeStatusMeta } from '../utils/node-status'
import { protocolMeta } from '../utils/protocols'

function formatPrice(prices: { denom: string; value: string }[] | null | undefined): string {
  if (!prices) return '—'
  const p = prices.find((x) => x.denom === 'udvpn')
  if (!p) return '—'
  const val = parseInt(p.value, 10) / 1e6
  if (val >= 1000) return val.toLocaleString('en', { maximumFractionDigits: 0 })
  return val.toLocaleString('en', { maximumFractionDigits: 2 })
}

type SortKey = 'country' | 'city' | 'moniker' | 'type' | 'priceGb' | 'priceHr' | 'peers' | 'latency' | 'status'

const COLUMNS: { key: SortKey; label: string; width: string }[] = [
  { key: 'country', label: 'Country', width: 'w-[160px]' },
  { key: 'city', label: 'City', width: 'w-[120px]' },
  { key: 'moniker', label: 'Moniker', width: 'flex-1 min-w-[140px]' },
  { key: 'type', label: 'Type', width: 'w-[80px]' },
  { key: 'priceGb', label: 'P2P/GB', width: 'w-[80px]' },
  { key: 'priceHr', label: 'P2P/Hr', width: 'w-[80px]' },
  { key: 'peers', label: 'Peers', width: 'w-[60px] justify-center' },
  { key: 'latency', label: 'Latency', width: 'w-[70px] justify-center' },
  { key: 'status', label: 'Status', width: 'w-[60px] justify-center' },
]

const CACHE_TTL = 10 * 60 * 1000

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
    countries,
    cities,
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
    estimateSize: () => 36,
    overscan: 20,
  })

  return (
    <div className="h-full flex flex-col">
      <NodeFilters
        filter={filter}
        updateFilter={updateFilter}
        countries={countries}
        cities={cities}
        totalCount={totalCount}
        filteredCount={nodes.length}
        lastFetched={lastFetched}
        loading={loading}
        onRefresh={refresh}
        batchProgress={batchProgress}
        onTestBatch={() => {
          const batch = nodes.map((n) => ({ nodeAddress: n.address, remoteUrl: n.api }))
          testBatch(batch)
        }}
        onCancelBatch={cancelBatch}
      />

      {!lastFetched ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-text-secondary text-sm flex items-center gap-2">
            <Spinner />
            Loading nodes...
          </div>
        </div>
      ) : (
      /* Virtualized rows */
      <div ref={parentRef} className="flex-1 overflow-auto">
        {/* Sticky header */}
        <div className="sticky top-0 z-10 flex items-center px-4 py-2 border-b border-border bg-bg-secondary text-text-secondary text-xs font-medium uppercase tracking-wide select-none">
          <div className="w-[28px] shrink-0" />
          {COLUMNS.map((col) => (
            <button
              key={col.key}
              onClick={() => toggleSort(col.key)}
              className={`${col.width} text-left hover:text-accent transition-colors flex items-center gap-1 shrink-0`}
            >
              {col.label}
              {sortKey === col.key && (
                <span className="text-accent">{sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
            </button>
          ))}
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
            const code = COUNTRY_CODES[node.country] || ''
            const nodeStatus = nodeStatusMeta(node)
            const isConnected = connectedAddress === node.address

            return (
              <div
                key={node.address}
                onClick={() => setSelectedNode(node)}
                className={`absolute left-0 w-full flex items-center px-4 text-sm cursor-pointer border-b transition-colors ${
                  isConnected
                    ? 'bg-success-subtle border-success hover:bg-success-subtle'
                    : 'border-border hover:bg-bg-hover'
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
                  {code && (
                    <span
                      className={`fi fi-${code}`}
                      style={{ fontSize: '12px', lineHeight: 1 }}
                    />
                  )}
                  <span className="truncate">{node.country || '—'}</span>
                  {isConnected && (
                    <span className="status-dot status-dot-active shrink-0" />
                  )}
                </div>
                <div className="w-[120px] shrink-0 truncate text-text-secondary">
                  {node.city || '—'}
                </div>
                <div className="flex-1 min-w-[140px] truncate text-text-primary">
                  {node.moniker || '—'}
                </div>
                <div className="w-[80px] shrink-0 leading-tight">
                  <span className={protocolMeta(node.type).color}>
                    {protocolMeta(node.type).short}
                  </span>
                  {node.type === 2 && (() => {
                    const badge = v2rayConnectionBadge(node.connection)
                    const cleartext = isCleartextConnection(node.connection)
                    return (
                      <span
                        className={`block text-[10px] truncate ${cleartext ? 'text-danger' : 'text-text-tertiary'}`}
                        title="V2Ray protocol/security advertised by the node (unverified until you connect)"
                      >
                        {badge ?? 'unknown'}
                      </span>
                    )
                  })()}
                </div>
                <div className="w-[80px] shrink-0 text-text-secondary font-mono text-xs">
                  {formatPrice(node.gigabytePrices)}
                </div>
                <div className="w-[80px] shrink-0 text-text-secondary font-mono text-xs">
                  {formatPrice(node.hourlyPrices)}
                </div>
                <div className="w-[60px] shrink-0 text-text-secondary text-center font-mono text-xs">
                  {node.peers}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); testNode(node.address, node.api) }}
                  disabled={testingNodes.has(node.address)}
                  className="w-[70px] shrink-0 text-center font-mono text-xs transition-colors hover:text-accent disabled:pointer-events-none"
                  title="Test node latency"
                >
                  {(() => {
                    if (testingNodes.has(node.address)) return <span className="text-text-tertiary">...</span>
                    const probe = testResults.get(node.address)
                    if (!probe) return <span className="text-text-tertiary">⏱</span>
                    const stale = Date.now() - probe.timestamp > CACHE_TTL
                    if (probe.reachable && probe.latencyMs !== null) {
                      return <span className={stale ? 'text-text-tertiary' : 'text-success'}>{probe.latencyMs}ms</span>
                    }
                    return <span className={stale ? 'text-text-tertiary' : 'text-danger'}>Fail</span>
                  })()}
                </button>
                <div className="w-[60px] shrink-0 flex justify-center">
                  <span
                    className={`status-dot ${nodeStatus.dotClass}`}
                    title={`${nodeStatus.label} — ${nodeStatus.detail}`}
                  />
                </div>
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
