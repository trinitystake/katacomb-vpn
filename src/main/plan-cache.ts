import { makeDiskCache } from './disk-cache'

export interface CachedPlan {
  id: string
  provAddress: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
}

const cache = makeDiskCache<CachedPlan>('plan-cache.json', 'plans')
let memCache: { plans: CachedPlan[]; fetchedAt: number } | null = null

export function getCachedPlans(): { plans: CachedPlan[]; fetchedAt: number | null } {
  if (!memCache) {
    const disk = cache.load()
    if (disk) memCache = { plans: disk.items, fetchedAt: disk.fetchedAt }
  }
  if (!memCache) return { plans: [], fetchedAt: null }
  return { plans: memCache.plans, fetchedAt: memCache.fetchedAt }
}

export function setCachedPlans(plans: CachedPlan[]): void {
  memCache = { plans, fetchedAt: Date.now() }
  cache.save(memCache.plans, memCache.fetchedAt)
}
