import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './fs-utils'

export interface CachedPlan {
  id: string
  provAddress: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
}

interface CacheFile {
  plans: CachedPlan[]
  fetchedAt: number
}

let memCache: CacheFile | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'plan-cache.json')
}

function loadFromDisk(): CacheFile | null {
  const path = cachePath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as CacheFile
    if (!Array.isArray(parsed.plans) || typeof parsed.fetchedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function saveToDisk(cache: CacheFile): void {
  try {
    writeFileAtomic(cachePath(), JSON.stringify(cache))
  } catch {
    // best-effort
  }
}

export function getCachedPlans(): { plans: CachedPlan[]; fetchedAt: number | null } {
  if (!memCache) memCache = loadFromDisk()
  if (!memCache) return { plans: [], fetchedAt: null }
  return { plans: memCache.plans, fetchedAt: memCache.fetchedAt }
}

export function setCachedPlans(plans: CachedPlan[]): void {
  memCache = { plans, fetchedAt: Date.now() }
  saveToDisk(memCache)
}
