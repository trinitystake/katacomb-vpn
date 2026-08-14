import { useCallback, useRef, useState } from 'react'
import type { ChainEligibility, SentNode } from '../types'

/** Main caps one call at 60; probe in chunks so progress moves while it runs. */
const CHUNK = 30

/**
 * Grades nodes for each end of a multihop chain (see NODE_CHAIN_ELIGIBILITY).
 * Results are cached in main for 10 minutes and mirrored here, so re-opening the
 * picker or stepping back and forth costs nothing.
 *
 * A node is only re-probed when we have no answer for it — an operator does not
 * reconfigure inbounds while someone is picking a hop.
 */
export function useChainEligibility() {
  const [results, setResults] = useState<Map<string, ChainEligibility>>(new Map())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Guards against a second probe of the same node from a re-render or a rapid
  // re-open; `results` alone can't, because it lags the in-flight requests.
  const inFlight = useRef<Set<string>>(new Set())
  const cancelled = useRef(false)

  const record = useCallback((batch: ChainEligibility[]) => {
    setResults((prev) => {
      const next = new Map(prev)
      for (const r of batch) next.set(r.nodeAddress, r)
      return next
    })
  }, [])

  /** Probe every node we don't already have an answer for. Chunked, resumable. */
  const probe = useCallback(async (nodes: SentNode[]) => {
    const pending = nodes.filter(
      (n) => !results.has(n.address) && !inFlight.current.has(n.address) && n.api,
    )
    if (pending.length === 0) return
    cancelled.current = false
    for (const n of pending) inFlight.current.add(n.address)
    setProgress({ done: 0, total: pending.length })
    try {
      for (let i = 0; i < pending.length; i += CHUNK) {
        if (cancelled.current) break
        const chunk = pending.slice(i, i + CHUNK)
        try {
          record(await window.api.nodeChainEligibility(
            chunk.map((n) => ({ nodeAddress: n.address, remoteUrl: n.api, nodeType: n.type })),
          ))
        } catch {
          // One bad chunk must not abandon the rest: the nodes in it simply stay
          // ungraded, which the picker already renders as "unknown".
        }
        setProgress({ done: Math.min(i + CHUNK, pending.length), total: pending.length })
      }
    } finally {
      for (const n of pending) inFlight.current.delete(n.address)
      setProgress(null)
    }
  }, [results, record])

  /** Probe one node and hand the answer back, for the pre-purchase gate. */
  const probeOne = useCallback(async (node: SentNode): Promise<ChainEligibility | null> => {
    const known = results.get(node.address)
    if (known) return known
    try {
      const [result] = await window.api.nodeChainEligibility([
        { nodeAddress: node.address, remoteUrl: node.api, nodeType: node.type },
      ])
      if (result) record([result])
      return result ?? null
    } catch {
      return null
    }
  }, [results, record])

  const cancel = useCallback(() => { cancelled.current = true }, [])

  return { results, progress, probe, probeOne, cancel }
}
