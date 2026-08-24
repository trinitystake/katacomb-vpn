import { makeDiskCache } from './disk-cache'

export interface CachedPlan {
  id: string
  provAddress: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
  /**
   * Linked ACTIVE nodes counted during the same rescan that fetched the plan
   * (the chain has no bulk query for this, so it is exactly as fresh as
   * `fetchedAt`). null = never counted, e.g. a cache file from before this
   * field existed — the catalog must keep those VISIBLE, only 0 hides a plan.
   */
  nodeCount: number | null
}

const cache = makeDiskCache<CachedPlan>('plan-cache.json', 'plans')
let memCache: { plans: CachedPlan[]; fetchedAt: number } | null = null

export function getCachedPlans(): { plans: CachedPlan[]; fetchedAt: number | null } {
  if (!memCache) {
    const disk = cache.load()
    if (disk) {
      // A cache written before nodeCount existed lacks the field; normalize to
      // null ("never counted") so the type is true downstream.
      memCache = {
        plans: disk.items.map((p) => ({ ...p, nodeCount: p.nodeCount ?? null })),
        fetchedAt: disk.fetchedAt,
      }
    }
  }
  if (!memCache) return { plans: [], fetchedAt: null }
  return { plans: memCache.plans, fetchedAt: memCache.fetchedAt }
}

export function setCachedPlans(plans: CachedPlan[]): void {
  memCache = { plans, fetchedAt: Date.now() }
  cache.save(memCache.plans, memCache.fetchedAt)
}
