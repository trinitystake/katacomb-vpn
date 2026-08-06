// Pure decision logic for the connect/reconnect paths. NO Electron / wallet /
// vpn-manager imports — kept side-effect-free so the money (refund) and
// concurrency (reconnect) decisions are unit-testable in isolation.

/**
 * User-facing message for a session that was created on-chain but then failed to
 * establish a tunnel. `policyRejected` selects the VLess-none preamble; otherwise
 * the underlying `reason` is included. The tail reports the refund outcome — and
 * when the auto-cancel could NOT be done, names the session id to cancel manually.
 */
export function sessionFailureMessage(opts: {
  refunded: boolean
  isDeposit: boolean
  sessionId: string
  nodeMoniker: string
  reason: string
  policyRejected: boolean
}): string {
  const preamble = opts.policyRejected
    ? `Node "${opts.nodeMoniker}" only offers unencrypted (VLess-none) inbounds — not connecting`
    : `Could not establish the tunnel to "${opts.nodeMoniker}": ${opts.reason}`
  const tail = opts.refunded
    ? `The session was cancelled${opts.isDeposit ? ' and your deposit refunded' : ''}.`
    : `Could not auto-cancel the session — open the Session tab and cancel session #${opts.sessionId} manually.`
  return `${preamble}. ${tail}`
}

export type ReconnectDecision =
  | { action: 'abort' }
  | { action: 'give-up' }
  | { action: 'retry'; attempt: number; delayMs: number }

/**
 * Decide what the reconnect scheduler should do next. `attempt` is the number of
 * attempts already made; `next = attempt + 1`. Abort conditions take precedence
 * over the attempt-limit so an intentional disconnect always wins.
 */
export function decideReconnect(opts: {
  attempt: number
  maxAttempts: number
  autoReconnect: boolean
  intentional: boolean
  hasSession: boolean
}): ReconnectDecision {
  if (!opts.hasSession || opts.intentional || !opts.autoReconnect) return { action: 'abort' }
  const next = opts.attempt + 1
  if (next > opts.maxAttempts) return { action: 'give-up' }
  return { action: 'retry', attempt: next, delayMs: backoffDelayMs(next) }
}

/** Exponential backoff for reconnect attempt `n`: 2^n seconds, capped at 60s. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 60000)
}

export interface QuotaInput {
  /** null or <=0 ⇒ not time-metered. */
  maxDurationSeconds: number | null
  /** On-chain `duration` settled before this connect. */
  baselineDurationSeconds: number
  /** How long the CURRENT tunnel has been up. */
  connectedSeconds: number
  /** 0 ⇒ not data-metered. */
  maxBytes: number
  /** On-chain download settled before this connect. */
  baselineBytes: number
  /** Interface rx counter for the current tunnel (getTrafficStats().rxBytes). */
  liveRxBytes: number
}

export type QuotaVerdict =
  | { level: 'ok'; pct: number }
  /** `remaining` is seconds for reason 'time', bytes for reason 'data'. */
  | { level: 'warn'; pct: number; reason: 'time' | 'data'; remaining: number }
  | { level: 'expired'; reason: 'time' | 'data' }

const QUOTA_WARN_PCT = 90

/**
 * How much of the paid session is used up? Only the caps that actually exist are
 * evaluated (a per-GB session has no time cap and vice versa — same hasByteCap /
 * hasTimeCap split the Sessions tab draws its gauges from), and the worst of the
 * two wins. With NEITHER cap set the verdict is always 'ok': a capless session
 * must never be torn down.
 *
 * BOTH caps are measured the same way: what the chain already settled, plus what
 * this tunnel has done since it came up. For bytes that is
 * `baselineBytes + liveRxBytes` (DOWNLOAD ONLY, the same number the user is looking
 * at); for time it is `baselineDurationSeconds + connectedSeconds`.
 *
 * Time deliberately does NOT use wall-clock since the session's `startAt`. The
 * chain meters `duration` from the node's usage proofs, so an idle session accrues
 * nothing — verified on mainnet: session #53647217 sat for 53 minutes with
 * `duration: 0`, which a wall-clock reading would have called 88% spent and torn
 * down, destroying a full paid hour.
 *
 * The node's own metering may still differ slightly from ours, which is what the
 * reconnect give-up path absorbs. In local-proxy mode there is no interface to
 * count, so `liveRxBytes` is 0 and only a time cap can expire.
 */
export function evaluateQuota(input: QuotaInput): QuotaVerdict {
  const hasTimeCap = input.maxDurationSeconds !== null && input.maxDurationSeconds > 0
  const hasByteCap = input.maxBytes > 0

  const usedSeconds = input.baselineDurationSeconds + input.connectedSeconds
  const usedBytes = input.baselineBytes + input.liveRxBytes

  const timePct = hasTimeCap ? usedSeconds / input.maxDurationSeconds! * 100 : null
  const dataPct = hasByteCap ? usedBytes / input.maxBytes * 100 : null

  if (timePct === null && dataPct === null) return { level: 'ok', pct: 0 }

  // Worst of the two decides — whichever cap runs out first ends the session.
  const reason: 'time' | 'data' =
    (dataPct ?? -1) > (timePct ?? -1) ? 'data' : 'time'
  const pct = Math.max(timePct ?? 0, dataPct ?? 0)

  if (pct >= 100) return { level: 'expired', reason }
  if (pct >= QUOTA_WARN_PCT) {
    const remaining = reason === 'time'
      ? Math.max(0, input.maxDurationSeconds! - usedSeconds)
      : Math.max(0, input.maxBytes - usedBytes)
    return { level: 'warn', pct, reason, remaining }
  }
  return { level: 'ok', pct }
}

/** Node `/info` service_type spellings → our numeric protocol tag. */
const SERVICE_TYPE_ALIASES: Record<string, number> = {
  wireguard: 1,
  v2ray: 2,
  openvpn: 3,
  xray: 4,
  amneziawg: 5,
  awg: 5,
  hysteria2: 6,
  hy2: 6,
}

/**
 * Normalize a node's self-reported `service_type` to the numeric protocol tag the
 * node list uses (1=WireGuard … 6=Hysteria2). v9 nodes report strings and spell
 * them inconsistently (`amnezia_wg`, `AmneziaWG`, `hysteria_2`), older ones report
 * the number. Returns null for anything we don't recognise — the caller treats
 * that as "can't verify", never as a match.
 */
export function serviceTypeToNodeType(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 6 ? value : null
  }
  if (typeof value !== 'string') return null
  const key = value.toLowerCase().replace(/[\s_-]/g, '')
  if (/^\d+$/.test(key)) {
    const n = parseInt(key, 10)
    return n >= 1 && n <= 6 ? n : null
  }
  return SERVICE_TYPE_ALIASES[key] ?? null
}

/**
 * Does this bring-up failure come from wg-quick/awg-quick being unable to set
 * DNS? Both shell out to `resolvconf`, which isn't present on distros without
 * openresolv or the systemd-resolved shim — the tunnel itself is fine, only the
 * DNS step failed, so it's worth offering a retry without it.
 */
export function isDnsProvisionError(msg: string): boolean {
  return /resolvconf/i.test(msg)
}

/**
 * Drop `DNS = …` lines from a WireGuard/AmneziaWG INI, leaving everything else
 * untouched. Used for the user-consented retry when resolvconf is missing: the
 * tunnel comes up, but DNS stays on the system resolver.
 */
export function stripDnsLines(config: string): string {
  return config
    .split('\n')
    .filter((line) => !/^\s*DNS\s*=/i.test(line))
    .join('\n')
}

/**
 * Bytes the tunnel must have sent with NOTHING coming back before we call it one-way.
 * Small enough that a handful of DNS retries and TCP SYNs reach it, large enough that
 * a brief stall doesn't.
 */
export const ONE_WAY_TX_FLOOR_BYTES = 64 * 1024
/** How long the silence has to hold. Longer than any plausible network stall. */
export const ONE_WAY_SILENCE_MS = 90_000

/**
 * True when the tunnel is transmitting but nothing is coming back — the signature of
 * a node that has stopped forwarding, or has dropped our peer, while the interface
 * stays up. That state is invisible to the interface-presence monitor: wg-quick
 * reports success whether or not the node ever answers a handshake, so mainnet
 * #53647217 sat "connected" for hours having moved ~3 KB out and 0 bytes in.
 *
 * BOTH conditions are required. An idle tunnel also receives nothing, and silence on
 * both counters is just a user who isn't browsing — not a fault. Only traffic leaving
 * with no reply is evidence.
 */
export function isTunnelOneWay(txSinceLastRx: number, msSinceLastRx: number): boolean {
  return txSinceLastRx >= ONE_WAY_TX_FLOOR_BYTES && msSinceLastRx >= ONE_WAY_SILENCE_MS
}
