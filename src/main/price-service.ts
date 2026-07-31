// The P2P → USD rate, used only to show what a plan price is worth in dollars.
//
// Nothing here is ever used to compute a transaction: every on-chain figure stays
// in udvpn, priced from chain data. A missing rate therefore just hides the "≈ $x"
// hint rather than blocking anything, which is why every failure returns the last
// known value (or null) instead of throwing.
//
// The request is a plain public GET with no wallet address, no plan id and no
// query of our own — CoinGecko learns that someone asked for the Sentinel price,
// nothing more. It goes through Electron's `net` so it follows the app's proxy
// and, when the tunnel is up, the tunnel.

import { net } from 'electron'

const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sentinel&vs_currencies=usd'
// CoinGecko's id for the chain's token: id "sentinel", ticker P2P, denom udvpn.
const COIN_ID = 'sentinel'
const TTL_MS = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

export interface TokenPrice {
  /** USD for one P2P (= 1,000,000 udvpn). */
  usd: number
  fetchedAt: number
}

let cached: TokenPrice | null = null
let inFlight: Promise<TokenPrice | null> | null = null

async function fetchPrice(): Promise<TokenPrice | null> {
  try {
    const response = await net.fetch(PRICE_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) return cached
    const json = await response.json() as Record<string, { usd?: number } | undefined>
    const usd = json?.[COIN_ID]?.usd
    if (typeof usd !== 'number' || !isFinite(usd) || usd <= 0) return cached
    cached = { usd, fetchedAt: Date.now() }
    return cached
  } catch {
    // Offline, rate-limited, or blocked — the last good rate is better than none.
    return cached
  }
}

/** The current rate, from a 15-minute memory cache. Never throws. */
export async function getTokenPrice(): Promise<TokenPrice | null> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached
  if (!inFlight) {
    inFlight = fetchPrice().finally(() => { inFlight = null })
  }
  return inFlight
}
