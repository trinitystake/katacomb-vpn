import { useState, useMemo } from 'react'
import type { SentNode, NodeFilter } from '../types'
import { useNodesContext } from '../contexts/NodesContext'
import { v2rayConnectionCategory } from '../utils/v2ray-connection'
import { nodeStatusRank } from '../utils/node-status'

const DEFAULT_FILTER: NodeFilter = {
  country: '',
  city: '',
  type: 'all',
  activeOnly: true,
  healthyOnly: true,
  residentialOnly: false,
  whitelistedOnly: false,
  hideDuplicates: true,
  bookmarkedOnly: false,
  v2rayConnection: { vmess: true, 'vmess-tls': true, 'vless-tls': true, 'vless-none': false, unknown: true },
  search: '',
}

type SortKey = 'country' | 'city' | 'moniker' | 'type' | 'priceGb' | 'priceHr' | 'peers' | 'latency' | 'status'
type SortDir = 'asc' | 'desc'

function getUdvpnPrice(prices: { denom: string; value: string }[]): number {
  const p = prices.find((x) => x.denom === 'udvpn')
  return p ? parseInt(p.value, 10) / 1e6 : Infinity
}

function compareNodes(
  a: SentNode, b: SentNode,
  key: SortKey, dir: SortDir,
  latencyMap: Map<string, number | null>,
): number {
  let cmp = 0
  switch (key) {
    case 'country':
      cmp = (a.country || '').localeCompare(b.country || '')
      break
    case 'city':
      cmp = (a.city || '').localeCompare(b.city || '')
      break
    case 'moniker':
      cmp = (a.moniker || '').localeCompare(b.moniker || '')
      break
    case 'type':
      cmp = a.type - b.type
      break
    case 'priceGb':
      cmp = getUdvpnPrice(a.gigabytePrices) - getUdvpnPrice(b.gigabytePrices)
      break
    case 'priceHr':
      cmp = getUdvpnPrice(a.hourlyPrices) - getUdvpnPrice(b.hourlyPrices)
      break
    case 'peers':
      cmp = a.peers - b.peers
      break
    case 'latency': {
      const la = latencyMap.get(a.address)
      const lb = latencyMap.get(b.address)
      // Untested nodes sort last, failed (null latency) nodes sort second-to-last
      const va = la === undefined ? Infinity : la === null ? Infinity - 1 : la
      const vb = lb === undefined ? Infinity : lb === null ? Infinity - 1 : lb
      cmp = va - vb
      break
    }
    case 'status':
      // Three ranks, not two — an active-but-unhealthy node sorts between
      // healthy and inactive rather than tying with inactive.
      cmp = nodeStatusRank(a) - nodeStatusRank(b)
      break
  }
  return dir === 'asc' ? cmp : -cmp
}

const EMPTY_LATENCY_MAP: Map<string, number | null> = new Map()

export function useNodes(latencyMap: Map<string, number | null> = EMPTY_LATENCY_MAP) {
  // Raw node state is owned by the NodesProvider so Map + Nodes tabs share
  // a single fetch + a single in-memory cache (seeded from disk on startup).
  const { allNodes, lastFetched, loading, refresh, bookmarks, toggleBookmark } = useNodesContext()

  // Per-consumer filter/sort state — Map and Nodes can hold independent filters.
  const [filter, setFilter] = useState<NodeFilter>(DEFAULT_FILTER)
  const [sortKey, setSortKey] = useState<SortKey>('country')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const countries = useMemo(() => {
    const set = new Set(allNodes.map((n) => n.country).filter(Boolean))
    return Array.from(set).sort()
  }, [allNodes])

  const cities = useMemo(() => {
    const filtered = filter.country
      ? allNodes.filter((n) => n.country === filter.country)
      : allNodes
    const set = new Set(filtered.map((n) => n.city).filter(Boolean))
    return Array.from(set).sort()
  }, [allNodes, filter.country])

  const filteredNodes = useMemo(() => {
    let nodes = allNodes

    if (filter.country) nodes = nodes.filter((n) => n.country === filter.country)
    if (filter.city) nodes = nodes.filter((n) => n.city === filter.city)
    if (filter.type !== 'all') nodes = nodes.filter((n) => n.type === filter.type)
    if (filter.activeOnly) nodes = nodes.filter((n) => n.isActive)
    if (filter.healthyOnly) nodes = nodes.filter((n) => n.isHealthy)
    if (filter.residentialOnly) nodes = nodes.filter((n) => n.isResidential)
    if (filter.whitelistedOnly) nodes = nodes.filter((n) => n.isWhitelisted)
    if (filter.hideDuplicates) nodes = nodes.filter((n) => !n.isDuplicate)
    // V2Ray connection sub-filter: keep a V2Ray node only if its category is enabled.
    nodes = nodes.filter((n) => n.type !== 2 || filter.v2rayConnection[v2rayConnectionCategory(n.connection)])
    if (filter.bookmarkedOnly) nodes = nodes.filter((n) => bookmarks.has(n.address))
    if (filter.search) {
      const q = filter.search.toLowerCase()
      nodes = nodes.filter((n) => (n.moniker || '').toLowerCase().includes(q))
    }

    return nodes.slice().sort((a, b) => compareNodes(a, b, sortKey, sortDir, latencyMap))
  }, [allNodes, filter, sortKey, sortDir, bookmarks, latencyMap])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function updateFilter(patch: Partial<NodeFilter>) {
    setFilter((f) => {
      const next = { ...f, ...patch }
      // Reset city when country changes
      if (patch.country !== undefined && patch.country !== f.country) {
        next.city = ''
      }
      return next
    })
  }

  return {
    nodes: filteredNodes,
    totalCount: allNodes.length,
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
  }
}
