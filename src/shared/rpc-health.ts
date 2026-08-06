// Health of the blockchain RPC endpoint — the single dependency behind every
// balance, session, plan and transaction in the app. Pure and import-free so
// both the main-process monitor and the renderer can use it, and so Node's
// native test runner can load it (same constraint as funds.ts).

/** What one probe of an endpoint's /status observed. */
export interface RpcProbe {
  reachable: boolean
  latencyMs: number | null
  chainId: string | null
  height: number | null
  /** Seconds between the endpoint's latest block and now. */
  blockAgeSec: number | null
  error: string | null
}

export type RpcState = 'ok' | 'degraded' | 'down' | 'suspended' | 'unknown'

export interface RpcHealth extends RpcProbe {
  state: RpcState
  endpoint: string
  /** Epoch ms of the probe, or 0 when nothing has been probed yet. */
  checkedAt: number
}

/** A probed endpoint, as returned by the main-process probe-all. */
export interface RpcCandidate {
  endpoint: string
  probe: RpcProbe
  /**
   * False when the aggregator's own public-RPC feed already reports this
   * endpoint as failing. Undefined when we have no aggregator opinion.
   */
  aggregatorHealthy?: boolean
}

/** Above this, the endpoint answers but every screen feels broken. */
export const SLOW_LATENCY_MS = 2_500
/** Sentinel blocks land every ~6s; two minutes behind means it's not keeping up. */
export const STALE_BLOCK_AGE_SEC = 120
export const EXPECTED_CHAIN_ID = 'sentinelhub-2'

/**
 * A wrong chain is `down`, not `degraded`: queries would return another
 * network's data and a transaction signed for it is unusable.
 */
export function classifyRpc(probe: RpcProbe): 'ok' | 'degraded' | 'down' {
  if (!probe.reachable) return 'down'
  if (probe.chainId !== null && probe.chainId !== EXPECTED_CHAIN_ID) return 'down'
  if (probe.blockAgeSec !== null && probe.blockAgeSec > STALE_BLOCK_AGE_SEC) return 'degraded'
  if (probe.latencyMs !== null && probe.latencyMs >= SLOW_LATENCY_MS) return 'degraded'
  return 'ok'
}

/** Why a reachable endpoint is still degraded — drives the label and the tooltip. */
export function degradedReason(h: RpcProbe): 'lagging' | 'slow' | null {
  if (h.blockAgeSec !== null && h.blockAgeSec > STALE_BLOCK_AGE_SEC) return 'lagging'
  if (h.latencyMs !== null && h.latencyMs >= SLOW_LATENCY_MS) return 'slow'
  return null
}

/** Short status-bar text. Kept terse — the tooltip carries the detail. */
export function rpcHealthLabel(h: RpcHealth): string {
  switch (h.state) {
    case 'ok':
      return h.latencyMs === null ? 'RPC ok' : `RPC ${h.latencyMs}ms`
    case 'degraded':
      return degradedReason(h) === 'lagging' ? 'RPC lagging' : 'RPC slow'
    case 'down':
      return 'RPC unreachable'
    case 'suspended':
      // Name the cause in the label. Grey + "paused" alone reads as a fault, and
      // the natural response — switching endpoints — cannot clear it.
      return 'RPC paused (VPN)'
    case 'unknown':
      return 'RPC checking'
  }
}

/**
 * Should a list that came back empty be presented as "couldn't ask" rather than
 * "nothing there"? Only `down` qualifies: a `degraded` endpoint answered, so its
 * empty list is real (the banner warns about slow/lagging separately), and while
 * `suspended` main returns empty by design and the UI already says so.
 */
export function isChainUnreachable(state: RpcState): boolean {
  return state === 'down'
}

/** Strip scheme and default port for display: 'https://rpc.sentinel.co:443' → 'rpc.sentinel.co'. */
export function rpcHostLabel(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '').replace(/:443$/, '').replace(/\/+$/, '')
}

/**
 * The endpoint to offer as a replacement for `currentEndpoint`, or null when
 * nothing probed better. Healthy beats degraded; within a tier, fastest wins.
 * Never returns the endpoint already in use, and never one the aggregator
 * already reports as failing.
 */
export function pickBestRpc(candidates: RpcCandidate[], currentEndpoint: string): RpcCandidate | null {
  const usable = candidates.filter(
    (c) => c.endpoint !== currentEndpoint && c.aggregatorHealthy !== false && classifyRpc(c.probe) !== 'down',
  )
  if (usable.length === 0) return null
  const byLatency = (a: RpcCandidate, b: RpcCandidate) =>
    (a.probe.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.probe.latencyMs ?? Number.MAX_SAFE_INTEGER)
  const healthy = usable.filter((c) => classifyRpc(c.probe) === 'ok')
  const tier = healthy.length > 0 ? healthy : usable
  return [...tier].sort(byLatency)[0]
}

/**
 * Does this error message mean "we couldn't reach the chain" rather than "the
 * chain said no"? Matches the shapes these calls actually produce: withTimeout's
 * label, undici/net fetch failures, and gateway responses.
 *
 * Two different wordings for an HTTP status, because two different layers produce
 * one: `RPC returned N` is rpc-monitor.ts's own probe, `Bad status on response: N`
 * is @cosmjs/tendermint-rpc's filterBadStatus — i.e. every real chain call. This
 * only ever knew the first, so a rate-limited endpoint reached the connect modal as
 * a bare `Bad status on response: 429` (seen live on as-rpc.sentineldao.com) and
 * never reported the failure to the health monitor.
 *
 * The status list stays narrow on purpose: 429/502/503/504 are the endpoint
 * refusing to serve us, while a 400 is the chain rejecting the request and must
 * keep its own message.
 *
 * Deliberately does NOT match broadcastOrTimeout's transaction-timeout message —
 * a timed-out broadcast may still have landed, so it must never be reported as
 * a connectivity failure where nothing was sent.
 */
export function isRpcConnectivityError(message: string): boolean {
  return /RPC connect timed out|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network error|(?:RPC returned|Bad status on response:) (?:50[234]|429)/i.test(
    message,
  )
}
