/**
 * Pure decision logic for the Plans tab's smart connect: which of a plan's
 * linked nodes the auto-pick may buy, in what order, and how far a failing
 * connect ladder may walk before it stops spending. Electron-free and
 * unit-tested (plan-connect.test.ts); the PLAN_SMART_CONNECT handler in
 * ipc-handlers.ts supplies the inputs and performs the effects.
 */

export interface PlanNodeCandidate {
  address: string
  moniker: string
  country: string
  /** SentNode protocol tag, 0=unknown 1=WG 2=V2Ray 3=OpenVPN 4=XRAY 5=AWG 6=Hysteria2. */
  type: number
  /** The aggregator's API base for the node; '' when the directory has no row. */
  api: string
  isActive: boolean
  isHealthy: boolean
  /** Freshest known probe, null = unprobed. */
  latencyMs: number | null
  /** A probe ran just now and got nothing back. */
  probeFailed: boolean
  /** protocolRuntimeError() came back clean for this node's protocol. */
  runtimeOk: boolean
}

/**
 * Tie-break order inside one latency bucket. The WireGuard family first: it is
 * the kernel path and the most exercised in this app; OpenVPN last, two nodes
 * network-wide and a distro-binary dependency.
 */
export const PROTOCOL_PREFERENCE = [1, 5, 4, 2, 6, 3]

/** Latencies inside one bucket are treated as equal so jitter can't reorder. */
export const LATENCY_BUCKET_MS = 25

/** Session-creating txs one smart connect may broadcast before it stops. */
export const MAX_TX_ATTEMPTS = 3

/** Protocols with a local SOCKS5 listener, the only ones proxy mode can run. */
const PROXY_CAPABLE_TYPES = new Set([2, 4, 6])

const CONNECTABLE_TYPES = new Set([1, 2, 3, 4, 5, 6])

/** The exclusion reason for a candidate the auto-pick must not buy, or null. */
function exclusionReason(c: PlanNodeCandidate, requireProxyCapable: boolean): string | null {
  if (c.api === '') return 'not listed in the node directory'
  if (!CONNECTABLE_TYPES.has(c.type)) return 'runs an unknown protocol'
  if (!c.runtimeOk) return 'its protocol cannot run on this machine'
  if (!c.isActive) return 'not active'
  if (!c.isHealthy) return 'reported unhealthy by the node directory'
  if (c.probeFailed) return 'did not answer a probe'
  if (requireProxyCapable && !PROXY_CAPABLE_TYPES.has(c.type)) {
    return 'cannot run in local proxy mode'
  }
  return null
}

function latencyBucket(c: PlanNodeCandidate): number {
  // Unprobed sorts after every probed candidate but stays eligible: the probe
  // window is bounded, and a node it never reached is not thereby dead.
  if (c.latencyMs === null) return Number.MAX_SAFE_INTEGER
  return Math.floor(c.latencyMs / LATENCY_BUCKET_MS)
}

function protocolRank(type: number): number {
  const i = PROTOCOL_PREFERENCE.indexOf(type)
  return i === -1 ? PROTOCOL_PREFERENCE.length : i
}

/**
 * Split a plan's candidates into a ranked buy order and the excluded rest.
 * Only POSITIVE evidence ranks: anything the directory marks unhealthy or
 * inactive, anything unprobeable, anything this machine cannot run, is
 * excluded with a reason the modal can show.
 */
export function rankPlanCandidates(
  candidates: PlanNodeCandidate[],
  opts: { requireProxyCapable: boolean },
): { ranked: PlanNodeCandidate[]; excluded: { address: string; reason: string }[] } {
  const ranked: PlanNodeCandidate[] = []
  const excluded: { address: string; reason: string }[] = []
  for (const c of candidates) {
    const reason = exclusionReason(c, opts.requireProxyCapable)
    if (reason) excluded.push({ address: c.address, reason })
    else ranked.push(c)
  }
  ranked.sort((a, b) =>
    latencyBucket(a) - latencyBucket(b) ||
    protocolRank(a.type) - protocolRank(b.type) ||
    a.address.localeCompare(b.address),
  )
  return { ranked, excluded }
}

export type SmartConnectFailure =
  | 'preflight'   // pre-payment check failed, nothing was broadcast
  | 'handshake'   // session bought, handshake failed, refunded
  | 'policy'      // session bought, node's config failed a guard, refunded
  | 'endpoint'    // the node's endpoint could not be resolved, nothing spent
  | 'tx-timeout'  // a session-creating tx timed out and MAY STILL LAND
  | 'funds'       // the wallet cannot afford the next attempt
  | 'chain'       // the chain rejected or was unreachable

/**
 * May the ladder move to the next candidate after this failure?
 *
 * preflight/endpoint cost nothing, so they always advance. The refunded
 * failures advance while the tx budget lasts. A tx TIMEOUT stops everything:
 * the tx may still commit, and a second MsgStartSession fired after it could
 * buy a second subscription — the timeout copy already sends the user to the
 * Sessions tab. funds/chain failures would fail every later candidate too.
 */
export function shouldTryNextCandidate(failure: SmartConnectFailure, txAttemptsSoFar: number): boolean {
  if (failure === 'preflight' || failure === 'endpoint') return true
  if (failure === 'handshake' || failure === 'policy') return txAttemptsSoFar < MAX_TX_ATTEMPTS
  return false
}

/**
 * Which tx the next ladder attempt broadcasts. THE money rule of smart
 * connect: the plan's price is spent at most once. Before any subscription
 * exists the attempt subscribes (plan/v3 MsgStartSession, charges the plan
 * price); from the moment one commits, every further attempt rides it
 * (subscription/v3 MsgStartSession, gas only) — including attempts whose
 * session was refunded, because the refund cancels the SESSION, never the
 * subscription.
 */
export function ladderNextTx(subscriptionId: string | null): 'plan-subscribe' | 'session-only' {
  return subscriptionId === null ? 'plan-subscribe' : 'session-only'
}

/** One user-facing paragraph naming every node the ladder tried and why it failed. */
export function smartConnectFailureSummary(attempts: { moniker: string; reason: string }[]): string {
  if (attempts.length === 0) {
    return 'No node in this plan was usable right now. Nothing was charged.'
  }
  const lines = attempts.map((a) => `${a.moniker}: ${a.reason}`)
  return `Could not connect through this plan. Tried ${attempts.length} node${attempts.length === 1 ? '' : 's'}. ${lines.join('; ')}`
}
