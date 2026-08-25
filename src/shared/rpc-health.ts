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

/**
 * `suspended` and `blocked` are states of OUR OWN making, not of the endpoint:
 * the tunnel carries the traffic, or the kill switch is dropping it. Both mean
 * "not measured", and neither is a fault to be fixed by changing endpoint.
 */
export type RpcState = 'ok' | 'degraded' | 'down' | 'suspended' | 'blocked' | 'unknown'

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
const SLOW_LATENCY_MS = 2_500
/** Sentinel blocks land every ~6s; two minutes behind means it's not keeping up. */
export const STALE_BLOCK_AGE_SEC = 120
const EXPECTED_CHAIN_ID = 'sentinelhub-2'

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
    case 'blocked':
      // A session that expired with the kill switch on leaves the DROP-all chain
      // armed deliberately, so nothing reaches the chain. Reported as `down` it
      // accused the endpoint and offered a switch that changes nothing; the fix
      // is the expiry banner's Restore button, or turning the kill switch off.
      return 'RPC blocked (kill switch)'
    case 'unknown':
      return 'RPC checking'
  }
}

/**
 * Should a list that came back empty be presented as "couldn't ask" rather than
 * "nothing there"? A `degraded` endpoint answered, so its empty list is real (the
 * banner warns about slow/lagging separately), and while `suspended` main returns
 * empty by design and the UI already says so. `down` and `blocked` are the two
 * where the query really was attempted and really did fail.
 */
export function isChainUnreachable(state: RpcState): boolean {
  return state === 'down' || state === 'blocked'
}

/**
 * Would publishing this reading be a NEW accusation against the endpoint, made
 * on a single sample? Then hold it until a second probe agrees.
 *
 * A probe measures the whole path, and the path is not the endpoint. The first
 * probe after a tunnel teardown races the local network being restored — routes,
 * resolver, Chromium's socket pool — and a single dropped SYN costs a second,
 * two cost three, against a 2500ms "slow" threshold and an endpoint that answers
 * in ~400ms. That is what put "RPC slow" on screen for the rest of the 30s poll
 * window every time a session ended, with a banner offering to switch away from
 * an endpoint that was never at fault. Same shape at startup, where the first
 * probe races healStrandedKillSwitch() flushing a leftover DROP-all chain.
 *
 * Good news is published immediately: a probe that came back healthy has already
 * proved the whole path works, so there is nothing left to confirm. And an
 * endpoint already published as faulty is not re-confirmed — the accusation has
 * been made, and later readings only refresh its figures.
 *
 * The same rule tunnelCarriesTraffic follows ("only both failing, repeatedly, is
 * a verdict") and the one reportRpcFailure already assumes ("one flaky query
 * would then strand the indicator on red").
 */
export function needsConfirmation(probed: RpcState, published: RpcState): boolean {
  if (probed === 'ok') return false
  return published !== 'down' && published !== 'degraded'
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

/** A Smart RPC switch target must be within this many blocks of the tallest probed height. */
export const AUTO_HEIGHT_TOLERANCE_BLOCKS = 10
/** Smart RPC keeps the current endpoint unless the best candidate beats it by more than this. */
export const AUTO_KEEP_MARGIN_MS = 250

/**
 * Positive qualification for an automatic switch, stricter than pickBestRpc's
 * filter: an endpoint that did not report the right chain id and a height in
 * consensus with the pack has not earned a silent switch of the endpoint that
 * broadcasts the user's payments. (`classifyRpc` gives a null chainId the
 * benefit of the doubt; this does not.)
 */
function qualifiesForAuto(c: RpcCandidate, minHeight: number): boolean {
  return (
    c.probe.reachable &&
    c.probe.chainId === EXPECTED_CHAIN_ID &&
    c.aggregatorHealthy !== false &&
    c.probe.height !== null &&
    c.probe.height >= minHeight
  )
}

/**
 * The endpoint auto mode should switch to, or null to keep the current one.
 *
 * The height check is a cross-endpoint consensus: the feed only nominates
 * candidates, and an endpoint lying about the chain or lagging behind the
 * tallest probed height is excluded no matter how fast it answers. Stickiness
 * keeps the current endpoint unless it stopped qualifying, went degraded while
 * a healthy candidate exists, or a healthy candidate beats it by more than
 * AUTO_KEEP_MARGIN_MS — so launches don't flap between similar endpoints, and
 * a chain-wide stall (every endpoint lagging together) switches nothing.
 */
export function pickAutoRpc(candidates: RpcCandidate[], currentEndpoint: string): string | null {
  const heights = candidates.map((c) => c.probe.height).filter((h): h is number => h !== null)
  if (heights.length === 0) return null
  const minHeight = Math.max(...heights) - AUTO_HEIGHT_TOLERANCE_BLOCKS

  const others = candidates.filter((c) => c.endpoint !== currentEndpoint && qualifiesForAuto(c, minHeight))
  if (others.length === 0) return null
  const byLatency = (a: RpcCandidate, b: RpcCandidate) =>
    (a.probe.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.probe.latencyMs ?? Number.MAX_SAFE_INTEGER)
  const healthy = others.filter((c) => classifyRpc(c.probe) === 'ok')
  const best = [...(healthy.length > 0 ? healthy : others)].sort(byLatency)[0]

  const current = candidates.find((c) => c.endpoint === currentEndpoint)
  if (current === undefined || !qualifiesForAuto(current, minHeight)) return best.endpoint

  // A qualifying candidate is reachable on the right chain, so classifyRpc can
  // only say ok or degraded here.
  if (classifyRpc(current.probe) === 'ok') {
    if (classifyRpc(best.probe) !== 'ok') return null
    if (current.probe.latencyMs === null || best.probe.latencyMs === null) return null
    return best.probe.latencyMs + AUTO_KEEP_MARGIN_MS < current.probe.latencyMs ? best.endpoint : null
  }
  // Degraded current: a hop to another degraded endpoint buys nothing.
  return classifyRpc(best.probe) === 'ok' ? best.endpoint : null
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
