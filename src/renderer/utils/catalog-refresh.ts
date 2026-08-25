// When an automatic full plan-catalog rescan is justified. Import-free so the
// native test runner covers it (catalog-refresh.test.ts).

// A catalog older than this triggers one automatic rescan when the Catalog
// panel becomes visible.
export const AUTO_DISCOVER_STALE_MS = 6 * 3600_000

/**
 * At launch only an EMPTY cache justifies the scan (My plans joins
 * subscriptions against the cached catalog, so a first run needs one
 * regardless of sub-tab; a merely old catalog waits until someone looks at
 * it). When the Catalog panel becomes visible, an old cache qualifies too.
 * Never while `stale`: the chain half was answered from memory because our
 * own tunnel is up, so a rescan would just return the cache.
 */
export function shouldAutoRescanCatalog(
  trigger: 'launch' | 'catalog-visible',
  stale: boolean,
  fetchedAt: number | null,
  now: number,
): boolean {
  if (stale) return false
  if (fetchedAt === null) return true
  return trigger === 'catalog-visible' && now - fetchedAt > AUTO_DISCOVER_STALE_MS
}
