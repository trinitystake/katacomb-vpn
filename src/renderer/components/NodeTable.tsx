import { useRef, useState, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNodes } from '../hooks/useNodes'
import { useConnection } from '../hooks/useConnection'
import { useNodeTest } from '../hooks/useNodeTest'
import NodeFilters from './NodeFilters'
import ConnectionModal from './ConnectionModal'
import type { SentNode } from '../types'

const COUNTRY_CODES: Record<string, string> = {
  'Afghanistan': 'af', 'Albania': 'al', 'Algeria': 'dz', 'Argentina': 'ar',
  'Armenia': 'am', 'Australia': 'au', 'Austria': 'at', 'Azerbaijan': 'az',
  'Bahamas': 'bs', 'Bahrain': 'bh', 'Bangladesh': 'bd', 'Belarus': 'by',
  'Belgium': 'be', 'Bolivia': 'bo', 'Bosnia and Herzegovina': 'ba',
  'Brazil': 'br', 'Bulgaria': 'bg', 'Cambodia': 'kh', 'Canada': 'ca',
  'Chile': 'cl',
  'China': 'cn', 'Colombia': 'co', 'Costa Rica': 'cr', 'Croatia': 'hr',
  'Cuba': 'cu', 'Cyprus': 'cy', 'Czech Republic': 'cz', 'Czechia': 'cz',
  'Denmark': 'dk', 'Dominican Republic': 'do', 'DR Congo': 'cd',
  'Ecuador': 'ec',
  'Egypt': 'eg', 'El Salvador': 'sv', 'Estonia': 'ee', 'Ethiopia': 'et',
  'Finland': 'fi', 'France': 'fr', 'Georgia': 'ge', 'Germany': 'de',
  'Ghana': 'gh', 'Greece': 'gr', 'Guatemala': 'gt', 'Honduras': 'hn',
  'Hong Kong': 'hk', 'Hungary': 'hu', 'Iceland': 'is', 'India': 'in',
  'Indonesia': 'id', 'Iran': 'ir', 'Iraq': 'iq', 'Ireland': 'ie',
  'Israel': 'il', 'Italy': 'it', 'Jamaica': 'jm', 'Japan': 'jp',
  'Jordan': 'jo', 'Kazakhstan': 'kz', 'Kenya': 'ke', 'Kuwait': 'kw',
  'Kyrgyzstan': 'kg', 'Latvia': 'lv', 'Lebanon': 'lb', 'Lithuania': 'lt',
  'Luxembourg': 'lu',
  'Malaysia': 'my', 'Malta': 'mt', 'Mexico': 'mx', 'Moldova': 'md',
  'Mongolia': 'mn', 'Montenegro': 'me', 'Morocco': 'ma', 'Myanmar': 'mm',
  'Nepal': 'np', 'Netherlands': 'nl', 'New Zealand': 'nz', 'Nigeria': 'ng',
  'North Macedonia': 'mk', 'Norway': 'no', 'Pakistan': 'pk', 'Panama': 'pa',
  'Paraguay': 'py', 'Peru': 'pe', 'Philippines': 'ph', 'Poland': 'pl',
  'Portugal': 'pt', 'Puerto Rico': 'pr', 'Qatar': 'qa', 'Romania': 'ro',
  'Russia': 'ru',
  'Saudi Arabia': 'sa', 'Senegal': 'sn', 'Serbia': 'rs', 'Singapore': 'sg',
  'Slovakia': 'sk', 'Slovenia': 'si', 'South Africa': 'za',
  'South Korea': 'kr', 'Spain': 'es', 'Sri Lanka': 'lk', 'Sweden': 'se',
  'Switzerland': 'ch', 'Taiwan': 'tw', 'Thailand': 'th', 'Tunisia': 'tn',
  'Turkey': 'tr', 'Türkiye': 'tr', 'Ukraine': 'ua',
  'United Arab Emirates': 'ae', 'United Kingdom': 'gb',
  'United States': 'us', 'Uruguay': 'uy', 'Uzbekistan': 'uz',
  'Venezuela': 've', 'Vietnam': 'vn',
}

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

      {/* Virtualized rows */}
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
            const active = node.isActive && node.isHealthy
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
                <div className="w-[80px] shrink-0">
                  <span className={node.type === 1 ? 'text-info' : 'text-warning'}>
                    {node.type === 1 ? 'WG' : 'V2Ray'}
                  </span>
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
                  <span className={`status-dot ${active ? 'status-dot-active' : 'status-dot-inactive'}`} />
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

      {selectedNode && (
        <ConnectionModal
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  )
}
