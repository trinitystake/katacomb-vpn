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
