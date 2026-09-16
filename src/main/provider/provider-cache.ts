import { makeDiskCache } from '../disk-cache'
import type { ProviderInfo } from './provider-service'
import type { ProviderOverview } from './provider-console'

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

// The last successful PROVIDER_OVERVIEW read, served stale while the tunnel is up
// so the Provider tab stays readable when the chain is unreachable through it.
// Tagged with the address it was read for — serving another wallet's provider
// would be worse than serving nothing, which is why a wallet switch clears it.
// In memory only, unlike the provider list above: it is per-wallet and cheap to
// re-read, and persisting one wallet's provider record across launches would
// outlive the reason it was cached.
let overview: { address: string; data: ProviderOverview; fetchedAt: number } | null = null

export function getCachedProviderOverview(
  address: string,
): { data: ProviderOverview; fetchedAt: number } | null {
  if (!overview || overview.address !== address) return null
  return { data: overview.data, fetchedAt: overview.fetchedAt }
}

export function setCachedProviderOverview(address: string, data: ProviderOverview, fetchedAt: number): void {
  overview = { address, data, fetchedAt }
}

export function clearCachedProviderOverview(): void {
  overview = null
}
