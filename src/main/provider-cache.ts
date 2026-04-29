import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ProviderInfo } from './provider-service'

interface CacheFile {
  providers: ProviderInfo[]
  fetchedAt: number
}

const TTL_MS = 60 * 60 * 1000

let memCache: CacheFile | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'provider-cache.json')
}

function loadFromDisk(): CacheFile | null {
  const path = cachePath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as CacheFile
    if (!Array.isArray(parsed.providers) || typeof parsed.fetchedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function saveToDisk(cache: CacheFile): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(cache), { mode: 0o600 })
  } catch {
    // best-effort
  }
}

export function getCachedProviders(): { providers: ProviderInfo[]; fetchedAt: number | null } {
  if (!memCache) memCache = loadFromDisk()
  if (!memCache) return { providers: [], fetchedAt: null }
  return { providers: memCache.providers, fetchedAt: memCache.fetchedAt }
}

export function isCacheFresh(): boolean {
  if (!memCache) memCache = loadFromDisk()
  if (!memCache) return false
  return Date.now() - memCache.fetchedAt < TTL_MS
}

export function setCachedProviders(providers: ProviderInfo[]): void {
  memCache = { providers, fetchedAt: Date.now() }
  saveToDisk(memCache)
}
