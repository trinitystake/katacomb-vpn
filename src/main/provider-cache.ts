import { makeDiskCache } from './disk-cache'
import type { ProviderInfo } from './provider-service'

const TTL_MS = 60 * 60 * 1000

const cache = makeDiskCache<ProviderInfo>('provider-cache.json', 'providers')
let memCache: { providers: ProviderInfo[]; fetchedAt: number } | null = null

function loadIfNeeded(): void {
  if (memCache) return
  const disk = cache.load()
  if (disk) memCache = { providers: disk.items, fetchedAt: disk.fetchedAt }
}

export function getCachedProviders(): { providers: ProviderInfo[]; fetchedAt: number | null } {
  loadIfNeeded()
  if (!memCache) return { providers: [], fetchedAt: null }
  return { providers: memCache.providers, fetchedAt: memCache.fetchedAt }
}

export function isCacheFresh(): boolean {
  loadIfNeeded()
  if (!memCache) return false
  return Date.now() - memCache.fetchedAt < TTL_MS
}

export function setCachedProviders(providers: ProviderInfo[]): void {
  memCache = { providers, fetchedAt: Date.now() }
  cache.save(memCache.providers, memCache.fetchedAt)
}
