import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanInfo, PlanAllocation, DiscoverProgress } from '../types'

const POLL_ALLOCATIONS_MS = 120_000

export function usePlans() {
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [allocations, setAllocations] = useState<PlanAllocation[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [progress, setProgress] = useState<DiscoverProgress | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshCached = useCallback(async () => {
    try {
      const cached = await window.api.planListCached()
      setPlans(cached.plans)
      setFetchedAt(cached.fetchedAt)
    } catch {
      // silent
    }
  }, [])

  const refreshAllocations = useCallback(async () => {
    try {
      const allocs = await window.api.planAllocations()
      setAllocations(allocs)
    } catch {
      // silent
    }
  }, [])

  const discover = useCallback(async (maxCount: number) => {
    setDiscovering(true)
    setProgress({ done: 0, total: maxCount, phase: 'connecting' })
    try {
      const result = await window.api.planDiscover(maxCount)
      setPlans(result)
      setFetchedAt(Date.now())
      return result
    } finally {
      setDiscovering(false)
    }
  }, [])

  useEffect(() => {
    refreshCached()
    refreshAllocations()
  }, [refreshCached, refreshAllocations])

  useEffect(() => {
    intervalRef.current = setInterval(refreshAllocations, POLL_ALLOCATIONS_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [refreshAllocations])

  useEffect(() => {
    const unsub = window.api.onPlanDiscoverProgress((p) => setProgress(p))
    return unsub
  }, [])

  return {
    plans,
    fetchedAt,
    allocations,
    discovering,
    progress,
    discover,
    refreshAllocations,
    refreshCached,
  }
}
