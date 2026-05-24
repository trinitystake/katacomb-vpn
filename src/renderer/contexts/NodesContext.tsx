import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react'
import type { SentNode } from '../types'

interface NodesContextValue {
  allNodes: SentNode[]
  lastFetched: Date | null
  loading: boolean
  refresh: () => Promise<void>
  bookmarks: Set<string>
  toggleBookmark: (nodeAddress: string) => Promise<void>
}

const NodesContext = createContext<NodesContextValue | null>(null)

export function NodesProvider({ children }: { children: ReactNode }) {
  const [allNodes, setAllNodes] = useState<SentNode[]>([])
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set())

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

    // Subscribe to main-driven refreshes (60s timer in main process)
    const off = window.api.onNodesUpdate((nodes) => {
      setAllNodes(nodes)
      setLastFetched(new Date())
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

  return (
    <NodesContext.Provider value={{ allNodes, lastFetched, loading, refresh, bookmarks, toggleBookmark }}>
      {children}
    </NodesContext.Provider>
  )
}

export function useNodesContext(): NodesContextValue {
  const ctx = useContext(NodesContext)
  if (!ctx) {
    throw new Error('useNodesContext must be used within a NodesProvider')
  }
  return ctx
}
