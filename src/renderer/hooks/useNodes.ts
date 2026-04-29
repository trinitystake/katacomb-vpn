import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { SentNode, NodeFilter } from '../types'

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
  search: '',
}

type SortKey = 'country' | 'city' | 'moniker' | 'type' | 'priceGb' | 'priceHr' | 'peers' | 'latency' | 'status'
type SortDir = 'asc' | 'desc'

function getUdvpnPrice(prices: { denom: string; value: string }[]): number {
  const p = prices.find((x) => x.denom === 'udvpn')
  return p ? parseInt(p.value, 10) / 1e6 : Infinity
}

// External latency results for sorting — set by NodeTable via setLatencyMap
let latencyMap: Map<string, number | null> = new Map()

export function setLatencyMap(map: Map<string, number | null>): void {
  latencyMap = map
}

function compareNodes(a: SentNode, b: SentNode, key: SortKey, dir: SortDir): number {
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
    case 'status': {
      const sa = a.isActive && a.isHealthy ? 1 : 0
      const sb = b.isActive && b.isHealthy ? 1 : 0
      cmp = sa - sb
      break
    }
  }
  return dir === 'asc' ? cmp : -cmp
}

export function useNodes() {
  const [allNodes, setAllNodes] = useState<SentNode[]>([])
  const [filter, setFilter] = useState<NodeFilter>(DEFAULT_FILTER)
  const [sortKey, setSortKey] = useState<SortKey>('country')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [loading, setLoading] = useState(false)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load bookmarks on mount
  useEffect(() => {
    window.api.bookmarkList().then((list) => setBookmarks(new Set(list))).catch(() => {})
  }, [])

  const toggleBookmark = useCallback(async (nodeAddress: string) => {
    try {
      const updated = await window.api.bookmarkToggle(nodeAddress)
      setBookmarks(new Set(updated))
    } catch { /* silent */ }
  }, [])

  const fetchNodes = useCallback(async () => {
    setLoading(true)
    try {
      const nodes = await window.api.nodesFetch()
      setAllNodes(nodes)
      setLastFetched(new Date())
    } catch {
      // silent — will retry on interval
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchNodes()
    intervalRef.current = setInterval(fetchNodes, 60_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchNodes])

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
    if (filter.type === 'wireguard') nodes = nodes.filter((n) => n.type === 1)
    if (filter.type === 'v2ray') nodes = nodes.filter((n) => n.type === 2)
    if (filter.activeOnly) nodes = nodes.filter((n) => n.isActive)
    if (filter.healthyOnly) nodes = nodes.filter((n) => n.isHealthy)
    if (filter.residentialOnly) nodes = nodes.filter((n) => n.isResidential)
    if (filter.whitelistedOnly) nodes = nodes.filter((n) => n.isWhitelisted)
    if (filter.hideDuplicates) nodes = nodes.filter((n) => !n.isDuplicate)
    if (filter.bookmarkedOnly) nodes = nodes.filter((n) => bookmarks.has(n.address))
    if (filter.search) {
      const q = filter.search.toLowerCase()
      nodes = nodes.filter((n) => (n.moniker || '').toLowerCase().includes(q))
    }

    return nodes.slice().sort((a, b) => compareNodes(a, b, sortKey, sortDir))
  }, [allNodes, filter, sortKey, sortDir, bookmarks])

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
    refresh: fetchNodes,
    bookmarks,
    toggleBookmark,
  }
}
