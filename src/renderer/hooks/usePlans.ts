import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanInfo, PlanAllocation, DiscoverProgress } from '../types'
import { useSettings } from '../contexts/SettingsContext'

export function usePlans() {
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [allocations, setAllocations] = useState<PlanAllocation[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [progress, setProgress] = useState<DiscoverProgress | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { settings } = useSettings()
  const pollSec = settings?.pollAllocationSec ?? 120

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
    intervalRef.current = setInterval(refreshAllocations, pollSec * 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [refreshAllocations, pollSec])

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
