import { useCallback, useEffect, useRef, useState } from 'react'
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
 *
 * `key` identifies the SET being graded, and it is what makes filtering work: a
 * different key abandons the sweep in flight and starts on the new set. Narrowing to
 * 23 Canadian nodes used to leave the full 408-node sweep running to completion,
 * which is slower for the user AND contacts hundreds of operators they just
 * excluded. Nothing is lost by abandoning it, because grades are cached in main, so
 * widening again re-probes only what is genuinely new.
 */
export function useChainEligibility() {
  const [results, setResults] = useState<Map<string, ChainEligibility>>(new Map())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /**
   * Read by probe() instead of the state, so probe's identity does not change every
   * time a chunk lands. A caller debouncing on `probe` in its deps would otherwise
   * reset its timer on each recorded chunk and, if chunks land faster than the
   * debounce, never fire at all.
   */
  const resultsRef = useRef(results)
  useEffect(() => { resultsRef.current = results }, [results])
  /** The set currently being graded. */
  const runKey = useRef<string>('')
  /** Bumped per run, so a superseded loop can tell it no longer owns the state. */
  const generation = useRef(0)

  const record = useCallback((batch: ChainEligibility[]) => {
    setResults((prev) => {
      const next = new Map(prev)
      for (const r of batch) next.set(r.nodeAddress, r)
      return next
    })
  }, [])

  /** Probe every node in `nodes` we don't already have an answer for. */
  const probe = useCallback(async (nodes: SentNode[], key: string) => {
    if (key === runKey.current) return
    runKey.current = key
    const run = ++generation.current

    const pending = nodes.filter((n) => !resultsRef.current.has(n.address) && n.api)
    if (pending.length === 0) {
      setProgress(null)
      return
    }
    setProgress({ done: 0, total: pending.length })
    try {
      for (let i = 0; i < pending.length; i += CHUNK) {
        // Superseded by a newer filter: stop issuing requests, and touch no shared
        // state on the way out — the newer run owns it now.
        if (generation.current !== run) return
        const chunk = pending.slice(i, i + CHUNK)
        try {
          record(await window.api.nodeChainEligibility(
            chunk.map((n) => ({ nodeAddress: n.address, remoteUrl: n.api, nodeType: n.type })),
          ))
        } catch {
          // One bad chunk must not abandon the rest: the nodes in it simply stay
          // ungraded, which the picker already renders as "unknown".
        }
        // Recorded above even when superseded — the request was already paid for, and
        // a result is a result. Only the progress bar belongs to the current run.
        if (generation.current !== run) return
        setProgress({ done: Math.min(i + CHUNK, pending.length), total: pending.length })
      }
    } finally {
      if (generation.current === run) setProgress(null)
    }
  }, [record])

  return { results, progress, probe }
}
