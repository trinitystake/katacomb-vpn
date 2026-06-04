import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react'
import type { SentNode } from '../types'

interface NodesContextValue {
  allNodes: SentNode[]
  lastFetched: Date | null
  loading: boolean
  refresh: () => Promise<void>
  bookmarks: Set<string>
  toggleBookmark: (nodeAddress: string) => Promise<void>
  // Remembered V2Ray protocol/security badge per node address (learned at the
  // last handshake; only knowable post-subscription, cached to hint the list).
  v2rayClass: Record<string, { badge: string }>
}

const NodesContext = createContext<NodesContextValue | null>(null)

export function NodesProvider({ children }: { children: ReactNode }) {
  const [allNodes, setAllNodes] = useState<SentNode[]>([])
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set())
  const [v2rayClass, setV2rayClass] = useState<Record<string, { badge: string }>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const nodes = await window.api.nodesFetch()
      setAllNodes(nodes)
      setLastFetched(new Date())
    } catch {
      // silent — main process keeps trying on its 60s timer
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const loadV2RayClass = () => window.api.nodesV2RayClass().then(setV2rayClass).catch(() => {})

    // Instant paint from disk cache (no network)
    window.api
      .nodesGetCached()
      .then((cached) => {
        if (cached?.nodes) {
          setAllNodes(cached.nodes)
          setLastFetched(new Date(cached.fetchedAt))
        }
      })
      .catch(() => {
        // silent — main will push a fresh list shortly
      })

    loadV2RayClass()

    // Subscribe to main-driven refreshes (60s timer in main process). Refresh
    // the remembered badges on the same tick so a newly-learned node shows up.
    const off = window.api.onNodesUpdate((nodes) => {
      setAllNodes(nodes)
      setLastFetched(new Date())
      loadV2RayClass()
    })

    return off
  }, [])

  useEffect(() => {
    window.api.bookmarkList().then((list) => setBookmarks(new Set(list))).catch(() => {})
  }, [])

  const toggleBookmark = useCallback(async (nodeAddress: string) => {
    try {
      const updated = await window.api.bookmarkToggle(nodeAddress)
      setBookmarks(new Set(updated))
    } catch {
      // silent
    }
  }, [])

  const value = useMemo(
    () => ({ allNodes, lastFetched, loading, refresh, bookmarks, toggleBookmark, v2rayClass }),
    [allNodes, lastFetched, loading, refresh, bookmarks, toggleBookmark, v2rayClass],
  )

  return <NodesContext.Provider value={value}>{children}</NodesContext.Provider>
}

export function useNodesContext(): NodesContextValue {
  const ctx = useContext(NodesContext)
  if (!ctx) {
    throw new Error('useNodesContext must be used within a NodesProvider')
  }
  return ctx
}
