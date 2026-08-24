// The one set of byte/duration/price formatters for plan and session figures.
// Import-free so Node's native test runner loads it directly (format.test.ts),
// like connect-errors.ts.
//
// Bytes are DECIMAL on chain: provider-msgs.ts pins BYTES_PER_GB = 1e9 and
// every live plan agrees (250 GB = 250000000000). The retired per-tab
// formatters disagreed with each other and with the per-GB price math (a
// 1024-based one labeled GiB as GB, reading ~7.4% low).

/** Plan sizes at or past this render as Unlimited rather than a number. */
export const UNLIMITED_BYTES_THRESHOLD = 1e15

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB']

/** Up to two decimals, trailing zeros trimmed: 250 GB, 1.5 GB, 1.25 GB. */
function trim2(v: number): string {
  return String(parseFloat(v.toFixed(2)))
}

export function formatBytes(bytes: string | number): string {
  const n = Number(bytes)
  if (!isFinite(n) || n <= 0) return '0 B'
  if (n >= UNLIMITED_BYTES_THRESHOLD) return 'Unlimited'
  if (n < 1000) return `${Math.round(n)} B`
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < BYTE_UNITS.length - 1) {
    v /= 1000
    i++
  }
  return `${trim2(v)} ${BYTE_UNITS[i]}`
}

/**
 * The two largest non-zero units, so a 36 hour plan reads 1d 12h rather than
 * the truncated 1d the old per-tab formatters produced.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds) || seconds <= 0) return '-'
  const s = Math.floor(seconds)
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = s % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  if (mins > 0) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  return `${secs}s`
}

export function formatTimeAgo(ts: number | null): string {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** "12 Sep 2026" for validity dates (subscription startAt / inactiveAt). */
export function formatDateUntil(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export interface PlanPrice {
  denom: string
  baseValue: string
  quoteValue: string
}

/**
 * The price a plan actually quotes. udvpn renders as P2P (the display token);
 * any other denom keeps its real figure and denom label with `udvpn: null` —
 * NEVER zero, which is what used to make foreign-denom plans render as free
 * and sort as the cheapest thing on the tab.
 */
export function planPriceDisplay(prices: PlanPrice[]): { amount: string; denomLabel: string; udvpn: number | null } {
  const u = prices.find((p) => p.denom === 'udvpn')
  if (u) {
    const v = parseInt(u.quoteValue, 10)
    return {
      amount: (v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      denomLabel: 'P2P',
      udvpn: isFinite(v) ? v : null,
    }
  }
  const other = prices[0]
  if (other) {
    const v = Number(other.quoteValue)
    return {
      amount: isFinite(v) ? v.toLocaleString('en-US') : other.quoteValue,
      denomLabel: other.denom,
      udvpn: null,
    }
  }
  return { amount: '', denomLabel: '', udvpn: null }
}

/** P2P per decimal GB; null for foreign denoms and unlimited plans. */
export function pricePerGb(plan: { prices: PlanPrice[]; bytes: string }): number | null {
  const { udvpn } = planPriceDisplay(plan.prices)
  const bytes = Number(plan.bytes)
  if (udvpn === null || udvpn <= 0 || !isFinite(bytes) || bytes <= 0) return null
  if (bytes >= UNLIMITED_BYTES_THRESHOLD) return null
  return udvpn / (bytes / 1e9) / 1e6
}

/** P2P per day of validity; null for foreign denoms or missing duration. */
export function pricePerDay(plan: { prices: PlanPrice[]; durationSeconds: number | null }): number | null {
  const { udvpn } = planPriceDisplay(plan.prices)
  const seconds = plan.durationSeconds
  if (udvpn === null || udvpn <= 0 || !seconds || seconds <= 0) return null
  return udvpn / (seconds / 86400) / 1e6
}
