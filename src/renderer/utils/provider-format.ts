// Money and status formatting for the Provider console.
//
// Lives here rather than in ProviderConsole.tsx because all three console files
// import it: a component file that other components import for its helpers ends
// up being loaded for the helpers alone.
//
// Every figure passed in is computed in the main process from chain data. These
// functions only render it, and none of them is ever the source of a transaction
// amount.

/** sentinel.types.v1.Status */
export const STATUS_ACTIVE = 1

export function formatUdvpn(udvpn: string | number): string {
  const n = typeof udvpn === 'number' ? udvpn : Number(udvpn)
  if (!isFinite(n)) return '—'
  if (n === 0) return 'free'
  return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} P2P`
}

/**
 * formatUdvpn for balances rather than prices.
 *
 * The "free" that formatUdvpn returns for zero is right for a plan price and wrong
 * for an amount: "Revenue: free" and "burn: free → 360 P2P" both read as nonsense.
 */
export function formatUdvpnAmount(udvpn: string | number): string {
  const n = typeof udvpn === 'number' ? udvpn : Number(udvpn)
  if (!isFinite(n)) return '—'
  return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} P2P`
}

/**
 * The dollar value of a udvpn amount, for display only — every figure that ends
 * up in a transaction stays in udvpn, priced from chain data. Sub-cent amounts
 * keep two significant digits instead of rounding to $0.00.
 */
export function formatUsd(udvpn: string | number, usdPerP2p: number): string {
  const p2p = (typeof udvpn === 'number' ? udvpn : Number(udvpn)) / 1e6
  if (!isFinite(p2p)) return ''
  const usd = p2p * usdPerP2p
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toPrecision(2)}`
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * "3 days ago" for a chain timestamp, or null when there isn't one.
 *
 * Used for the provider's status_at, which is the only thing on the record that
 * says how long it has been in its current state.
 */
export function formatSince(iso: string | null): string | null {
  if (!iso) return null
  const then = Date.parse(iso)
  if (!isFinite(then)) return null
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
