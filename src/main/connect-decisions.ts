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
