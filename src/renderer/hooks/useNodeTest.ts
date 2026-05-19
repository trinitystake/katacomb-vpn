import { useState, useEffect, useCallback } from 'react'
import type { NodeProbeResult, SpeedTestResult, BatchProgress } from '../types'

export function useNodeTest() {
  const [results, setResults] = useState<Map<string, NodeProbeResult>>(new Map())
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const [speedResult, setSpeedResult] = useState<SpeedTestResult | null>(null)
  const [speedTesting, setSpeedTesting] = useState(false)

  // Load cached results on mount
  useEffect(() => {
    window.api.nodeTestResults().then((cached) => {
      const map = new Map<string, NodeProbeResult>()
      for (const [addr, result] of Object.entries(cached)) {
        map.set(addr, result)
      }
      if (map.size > 0) setResults(map)
    }).catch(() => {})
  }, [])

  // Listen for batch progress events
  useEffect(() => {
    const unsub = window.api.onNodeTestProgress((progress: BatchProgress) => {
      setResults((prev) => {
        const next = new Map(prev)
        next.set(progress.result.nodeAddress, progress.result)
        return next
      })
      setTesting((prev) => {
        const next = new Set(prev)
        next.delete(progress.result.nodeAddress)
        return next
      })
      setBatchProgress({ done: progress.done, total: progress.total })
      if (progress.done >= progress.total) {
        setBatchProgress(null)
      }
    })
    return () => { unsub() }
  }, [])

  const testNode = useCallback(async (nodeAddress: string, remoteUrl: string) => {
    setTesting((prev) => new Set(prev).add(nodeAddress))
    try {
      const result = await window.api.nodeTestProbe({ nodeAddress, remoteUrl })
      setResults((prev) => {
        const next = new Map(prev)
        next.set(nodeAddress, result)
        return next
      })
      return result
    } finally {
      setTesting((prev) => {
        const next = new Set(prev)
        next.delete(nodeAddress)
        return next
      })
    }
  }, [])

  const testBatch = useCallback(async (nodes: Array<{ nodeAddress: string; remoteUrl: string }>) => {
    setBatchProgress({ done: 0, total: nodes.length })
    setTesting((prev) => {
      const next = new Set(prev)
      for (const n of nodes) next.add(n.nodeAddress)
      return next
    })
    try {
      await window.api.nodeTestBatch(nodes)
    } catch {
      setBatchProgress(null)
    }
  }, [])

  const cancelBatch = useCallback(async () => {
    await window.api.nodeTestCancel()
    setBatchProgress(null)
    setTesting(new Set())
  }, [])

  const testSpeed = useCallback(async () => {
    setSpeedTesting(true)
    setSpeedResult(null)
    try {
      const result = await window.api.nodeTestSpeed()
      setSpeedResult(result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Speed test failed'
      const failResult: SpeedTestResult = { downloadMbps: 0, googleLatencyMs: null, googleReachable: false, error }
      setSpeedResult(failResult)
      return failResult
    } finally {
      setSpeedTesting(false)
    }
  }, [])

  return {
    results,
    testing,
    batchProgress,
    testNode,
    testBatch,
    cancelBatch,
    speedResult,
    speedTesting,
    testSpeed,
  }
}
