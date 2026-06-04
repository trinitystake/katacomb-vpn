import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { writeFileAtomic } from './fs-utils'

/**
 * Remembered V2Ray protocol/security badge per node address. The real
 * protocol/security of a node is only knowable after the (paid) handshake, so
 * we cache what we learned to hint it in the node list next time — letting the
 * user prefer nodes already seen as encrypted and avoid known VLess-none ones.
 */
export interface V2RayClassEntry {
  badge: string // e.g. "VMess+TLS", "VMess", "VLess+TLS", "VLess ⚠"
  classifiedAt: number
}

type CacheFile = Record<string, V2RayClassEntry>

// Bound the file so it can't grow without limit; we keep the most recent entries.
const MAX_ENTRIES = 2000

let memCache: CacheFile | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'v2ray-class-cache.json')
}

function loadFromDisk(): CacheFile {
  const p = cachePath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as CacheFile
  } catch {
    return {}
  }
}

/** Per-node remembered badge, keyed by node address. Lazily loaded from disk. */
export function getV2RayClassifications(): Record<string, V2RayClassEntry> {
  if (!memCache) memCache = loadFromDisk()
  return memCache
}

/** Record (or refresh) the badge learned for a node at handshake time. */
export function rememberV2RayClass(nodeAddress: string, badge: string): void {
  const cache = getV2RayClassifications()
  cache[nodeAddress] = { badge, classifiedAt: Date.now() }

  // Cap growth: drop the oldest entries past MAX_ENTRIES.
  const keys = Object.keys(cache)
  if (keys.length > MAX_ENTRIES) {
    const oldestFirst = keys.sort((a, b) => cache[a].classifiedAt - cache[b].classifiedAt)
    for (const k of oldestFirst.slice(0, keys.length - MAX_ENTRIES)) {
      delete cache[k]
    }
  }

  try {
    writeFileAtomic(cachePath(), JSON.stringify(cache))
  } catch {
    // best-effort — disk full / permission errors must not break connect
  }
}
