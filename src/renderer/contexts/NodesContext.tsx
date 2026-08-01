import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react'
import type { SentNode } from '../types'

interface NodesContextValue {
  allNodes: SentNode[]
  lastFetched: Date | null
  loading: boolean
  /** Why the last fetch failed, or null. Set only by fetches we asked for. */
  error: string | null
  refresh: () => Promise<void>
  bookmarks: Set<string>
  toggleBookmark: (nodeAddress: string) => Promise<void>
}

const NodesContext = createContext<NodesContextValue | null>(null)

export function NodesProvider({ children }: { children: ReactNode }) {
  const [allNodes, setAllNodes] = useState<SentNode[]>([])
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const nodes = await window.api.nodesFetch()
      setAllNodes(nodes)
      setLastFetched(new Date())
      setError(null)
    } catch (e) {
      // Reported, not swallowed: with no cached list this is the difference
      // between an actionable message and a spinner that never resolves.
      setError(e instanceof Error ? e.message : 'Could not reach the node directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Subscribe BEFORE asking for anything, so a push that lands while the
    // first read is in flight can't be missed.
    const off = window.api.onNodesUpdate((nodes) => {
      setAllNodes(nodes)
      setLastFetched(new Date())
      setError(null)
    })

    // Instant paint from disk cache (no network). When it yields nothing there
    // is nothing to wait for — main's first fetch may already have broadcast
    // before this listener existed — so ask for the list ourselves rather than
    // sitting on a spinner until the 60s timer happens to come round.
    window.api
      .nodesGetCached()
      .then((cached) => {
        if (cached?.nodes?.length) {
          setAllNodes(cached.nodes)
          setLastFetched(new Date(cached.fetchedAt))
          return
        }
        void refresh()
      })
      .catch(() => {
        void refresh()
      })

    return off
  }, [refresh])

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
    () => ({ allNodes, lastFetched, loading, error, refresh, bookmarks, toggleBookmark }),
    [allNodes, lastFetched, loading, error, refresh, bookmarks, toggleBookmark],
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
