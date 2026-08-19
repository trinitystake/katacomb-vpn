// The one place the userData JSON-cache pattern lives: read + shape-check on
// load (null on any failure — a corrupt or missing cache is just a cold
// start), atomic best-effort write on save. plan-cache, provider-cache and
// nodes-cache are thin wrappers over this.
import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './fs-utils'

/**
 * A JSON array cache at `userData/<fileName>` with the on-disk shape
 * `{ [field]: T[], fetchedAt: number }`. `field` is part of the existing
 * on-disk format ('plans' / 'providers' / 'nodes') — keep it stable, or every
 * user's cache silently cold-starts on upgrade.
 */
export function makeDiskCache<T>(fileName: string, field: string) {
  const cachePath = () => join(app.getPath('userData'), fileName)
  return {
    load(): { items: T[]; fetchedAt: number } | null {
      const path = cachePath()
      if (!existsSync(path)) return null
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
        const items = parsed?.[field]
        const fetchedAt = parsed?.fetchedAt
        if (!Array.isArray(items) || typeof fetchedAt !== 'number') return null
        return { items: items as T[], fetchedAt }
      } catch {
        return null
      }
    },
    save(items: T[], fetchedAt: number): void {
      try {
        writeFileAtomic(cachePath(), JSON.stringify({ [field]: items, fetchedAt }))
      } catch {
        // best-effort: disk full / permission errors must not break the app
      }
    },
  }
}
