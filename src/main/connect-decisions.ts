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
    ? `Node "${opts.nodeMoniker}" only offers unencrypted (VLess-none) inbounds, not connecting`
    : `Could not establish the tunnel to "${opts.nodeMoniker}": ${trimTrailingStop(opts.reason)}`
  const tail = opts.refunded
    ? `The session was cancelled${opts.isDeposit ? ' and your deposit refunded' : ''}.`
    : `Could not auto-cancel the session. Open the Session tab and cancel session #${opts.sessionId} manually.`
  return `${preamble}. ${tail}`
}

/**
 * User-facing message for a MULTIHOP chain that failed after one or both of its
 * sessions were paid for. Unlike the single-hop case there can be two deposits in
 * flight, and cancelling them is two independent transactions either of which can
 * fail — so the tail reports each session individually and names exactly the ones
 * the user still has to cancel by hand. `failedRole` says which hop broke (null
 * when the failure wasn't hop-specific, e.g. the second purchase never landed).
 */
/**
 * Cancel a list of paid sessions ONE AT A TIME, reporting each outcome, and never
 * letting one failure stop the rest.
 *
 * The sequencing is the whole point, and it is why this lives here rather than
 * inline: every cancel is a transaction signed by the SAME account, so two in
 * flight at once read the same account sequence number and the chain rejects the
 * loser. That is not theoretical — cancelling a failed chain with Promise.all
 * refunded entry #55122441 and had exit #55122449 rejected, leaving a live session
 * the user had to cancel by hand. `establishChainOrRefund` documents the identical
 * constraint for the two purchases.
 *
 * `cancel` is injected so the ordering can be tested without spending anything;
 * ipc-handlers binds it to the real endSession.
 */
export async function refundEachInTurn(
  sessionIds: string[],
  cancel: (sessionId: string) => Promise<void>,
): Promise<{ sessionId: string; refunded: boolean }[]> {
  const results: { sessionId: string; refunded: boolean }[] = []
  for (const sessionId of sessionIds) {
    try {
      await cancel(sessionId)
      results.push({ sessionId, refunded: true })
    } catch {
      results.push({ sessionId, refunded: false })
    }
  }
  return results
}

/** Node and builder errors end in a full stop; the templates below add their own. */
function trimTrailingStop(reason: string): string {
  return reason.replace(/\s*\.+\s*$/, '')
}

export function chainFailureMessage(opts: {
  reason: string
  policyRejected: boolean
  failedRole: 'entry' | 'exit' | null
  nodeMoniker: string
  refunds: { sessionId: string; refunded: boolean }[]
}): string {
  const where = opts.failedRole ? ` (${opts.failedRole} hop)` : ''
  const preamble = opts.policyRejected
    ? `Node "${opts.nodeMoniker}" only offers unencrypted (VLess-none) inbounds, not connecting${where}`
    : `Could not establish the two-hop chain${where}: ${trimTrailingStop(opts.reason)}`

  if (opts.refunds.length === 0) return `${preamble}. No sessions were created.`

  const stranded = opts.refunds.filter((r) => !r.refunded).map((r) => `#${r.sessionId}`)
  if (stranded.length === 0) {
    const noun = opts.refunds.length === 1 ? 'The session was' : 'Both sessions were'
    return `${preamble}. ${noun} cancelled and your deposit${opts.refunds.length === 1 ? '' : 's'} refunded.`
  }
  const list = stranded.join(' and ')
  const verb = stranded.length === 1 ? 'session' : 'sessions'
  return (
    `${preamble}. Could not auto-cancel ${verb} ${list}. Open the Session tab and ` +
    `cancel ${stranded.length === 1 ? 'it' : 'them'} manually.`
  )
}

export type ReconnectDecision =
  /**
   * The reason is load-bearing, not documentation. 'intentional' and 'no-session'
   * mean someone has already torn the tunnel down; 'auto-reconnect-off' means it
   * dropped on its own and NOTHING will clean up after it, so the caller has to
   * stand the session down itself rather than leave main believing it is connected.
   */
  | { action: 'abort'; reason: 'no-session' | 'intentional' | 'auto-reconnect-off' }
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
  if (!opts.hasSession) return { action: 'abort', reason: 'no-session' }
  if (opts.intentional) return { action: 'abort', reason: 'intentional' }
  if (!opts.autoReconnect) return { action: 'abort', reason: 'auto-reconnect-off' }
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
 * Point a WireGuard/AmneziaWG INI at ONE chosen resolver, replacing whatever DNS
 * the node pushed.
 *
 * Nodes advertise a LIST, and its first entry is typically their own in-tunnel
 * resolver. wg-quick hands the whole list to resolvconf, and systemd-resolved
 * starts at entry one: when that server is a black hole (routed into the tunnel,
 * never answers) every uncached lookup costs the glibc ceiling of 10s (5s x 2
 * attempts) until resolved fails over and pins a working server. Measured live on
 * 2026-08-19: `DNS = 10.8.0.1, 1.0.0.1, 1.1.1.1`, ~34s of dead DNS after connect,
 * then instant forever after, because resolved's server choice is sticky for the
 * life of the link. That is why it reads as a one-time stall and why it comes back
 * on the next connect to the same node.
 *
 * Replacing rather than reordering is deliberate: the node's resolver sees every
 * name the user looks up, so a user who named a resolver should get that one and
 * nothing else. `stripDnsLines` stays the separate, narrower tool for the
 * resolvconf-missing retry.
 */
export function replaceDnsLines(config: string, resolverIp: string): string {
  const lines = config.split('\n')
  const isDns = (line: string): boolean => /^\s*DNS\s*=/i.test(line)

  const first = lines.findIndex(isDns)
  if (first !== -1) {
    // Keep the node's line position, drop any further DNS lines.
    return lines
      .map((line, i) => (i === first ? `DNS = ${resolverIp}` : line))
      .filter((line, i) => i === first || !isDns(line))
      .join('\n')
  }

  // The node pushed no DNS at all. Add one, or the user stays on their LAN
  // resolver while tunnelled, which is the leak this setting exists to close.
  const start = lines.findIndex((line) => line.trim().toLowerCase() === '[interface]')
  if (start === -1) return config
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }
  // Step back over the blank line before the next section so the key stays inside
  // [Interface] — wg-quick reads DNS only there.
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  return [...lines.slice(0, end), `DNS = ${resolverIp}`, ...lines.slice(end)].join('\n')
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

/**
 * Does a session keep accruing usage while NO tunnel interface exists?
 *
 * Only in local-proxy mode, which has no interface by design and is spending the
 * session all the same. In tunnel mode the interface IS the tunnel, so its absence
 * is not "unmeasurable", it is gone — and the node stops metering the moment that
 * happens: mainnet #56141731 settled 148.03s against 147s of interface uptime and
 * still read 148.03s twenty-four minutes later with the session active on chain.
 *
 * Treating the two the same is what let a dropped tunnel bill wall-clock. The
 * figure is written to `lastSessionUsage` as a FLOOR the chain can never undercut,
 * so an over-count there is permanent: the time gauge reads the wall clock since
 * the session was bought instead of the time it was actually connected, and the
 * quota watchdog ends a session that still has paid time on it.
 */
export function usageAccruesWithoutTunnelInterface(mode: 'tunnel' | 'proxy'): boolean {
  return mode === 'proxy'
}

/**
 * Which remembered-usage entries may be forgotten, given the session rows the chain
 * just returned?
 *
 * The chain DELETES settled sessions, so an id no longer in the list is a session
 * that is over and its floor can go. But `getSessionsForAddress` swallows a failed
 * query and returns `[]`, which makes "the chain is unreachable" and "you have no
 * sessions" the SAME VALUE at every call site above it — and pruning on that erases
 * the floor for sessions that are very much alive.
 *
 * That is not a rare race, it is the normal state after a tunnel dies:
 * `standDownSession` deliberately leaves the DROP-all kill switch armed, so the chain
 * is unreachable precisely when the usage has just been recorded. Measured live on
 * mainnet #56152782 — 462 s of tunnel and 37.5 MB written to session-usage.json at
 * 18:00:37, the file emptied to `{}` at 18:00:55 by the next WALLET_SESSIONS poll,
 * and the gauge left showing the chain's not-yet-settled 0 s.
 *
 * So an EMPTY list prunes NOTHING. A stale entry costs a few hundred bytes and is
 * cleared by the next read that returns anything; a wrongly pruned one destroys the
 * only record of usage the chain has not caught up with yet.
 */
export function prunableUsageIds(
  remembered: string[],
  liveSessionIds: string[],
  activeSessionId: string | null,
): string[] {
  if (liveSessionIds.length === 0) return []
  const live = new Set(liveSessionIds)
  return remembered.filter((id) => !live.has(id) && id !== activeSessionId)
}

/**
 * What to tell the user when a tunnel came up and then carried nothing. The two
 * cases are NOT the same failure and must not get the same advice.
 *
 * `nodeIssuedFreshPeer` is the whole distinction: did the node mint a peer for the
 * config this tunnel was built from, or did we replay a saved one?
 *
 * When we replayed a saved config, the tunnel is dead for good. A dvpnx node's two
 * cleanup paths do NOT fire together (workers/session.go): it drops the PEER on any
 * of four triggers — max bytes, max duration, the chain session missing, or the
 * chain session no longer active — but deletes its own session RECORD on the last
 * of those alone. So a node routinely holds a record with no peer behind it, and
 * with a record present its handshake handler answers 409 and refuses to issue a
 * new peer (api/handshake/handlers.go rejects on session id OR peer request, before
 * doing anything else). Its whole API is `GET /` and `POST /` — there is no route
 * that clears the stale record. Nothing the client can do brings that peer back
 * while the session lives on chain, so "reconnect and try again" is a loop with no
 * exit: verified on mainnet #53670474, where a WireGuard initiation built from the
 * saved config's own keys drew no answer at all while the node's API was up and
 * serving four other peers.
 *
 * When the node DID just issue a peer, none of that applies — the fault may be
 * local (routing, the kill switch) or a momentary stall at the node — so the
 * existing retry-without-re-paying path is the right offer.
 *
 * Neither wording promises money back: ending a session forfeits its remainder,
 * which is what the confirm dialog already tells the user.
 */
export function deadTunnelMessage(nodeIssuedFreshPeer: boolean, isChain = false): string {
  if (isChain) {
    // Which hop failed is not knowable from here, but it is not a coin flip: the
    // entry is dialled directly and its certificate is verified, so a dead entry
    // fails earlier and louder. An exit that accepts the relay and forwards nothing
    // produces exactly this signature, so say so rather than making the user guess
    // between two nodes with no information.
    return 'The chain came up but no traffic is getting through.\n\n' +
      'Both hops are paid for and still open, so retry the connection first. If it fails ' +
      'again, the exit hop is the more likely one at fault: the entry is dialled directly ' +
      'and would have failed earlier, while an exit that accepts the connection and forwards ' +
      'nothing looks exactly like this. End the chain and build a new one with a different exit.'
  }
  if (nodeIssuedFreshPeer) {
    return 'The tunnel came up but no traffic is getting through. The node is not carrying ' +
      'traffic for the peer it just issued.\n\n' +
      'Your session is still open and paid for, so retry the connection. If it fails again, ' +
      'end the session and pick a different node.'
  }
  return 'The tunnel came up but no traffic is getting through. The node has dropped this ' +
    "session's tunnel peer.\n\n" +
    'It will not issue a replacement: the node still holds its own record of the session, and ' +
    'it only clears that once the session is gone from the chain. This session cannot be ' +
    'reconnected. Every attempt rebuilds the same dead tunnel. End it from the Sessions tab ' +
    'and start a new session.'
}

/**
 * Reduce a failed node API call to its HTTP status and the node's OWN error text.
 *
 * The SDK's handshake is a bare axios POST, so a rejection is an AxiosError whose
 * `message` says only "Request failed with status code N" — and logging the error
 * object itself prints ~600 lines of request, socket, agent and TLS internals
 * without ever showing what the node objected to. The useful sentence is in the
 * response body: dvpnx answers with go-sdk `types.Response`,
 * `{success:false, error:{code, message}}`.
 *
 * Returns a null status when the call never got an HTTP response at all (timeout,
 * DNS, connection refused), which is itself the distinction worth logging.
 */
export function describeNodeApiError(err: unknown): { status: number | null; message: string } {
  const e = err as {
    response?: { status?: unknown; data?: { error?: { message?: unknown } } }
    message?: unknown
  }
  const status = typeof e?.response?.status === 'number' ? e.response.status : null
  const nodeMessage = e?.response?.data?.error?.message
  if (typeof nodeMessage === 'string' && nodeMessage !== '') return { status, message: nodeMessage }
  return { status, message: typeof e?.message === 'string' ? e.message : String(err) }
}

/**
 * What to do to the kill-switch chain after the user toggles Kill Switch or Local
 * Network Sharing mid-session. The ARMED MARKER decides, not the connection
 * state: the chain deliberately outlives the tunnel in the stand-down ("expired,
 * traffic blocked") state, and the user must still be able to change their mind
 * there. `tunnelActive` is `isVpnActive()`, which is false in proxy mode by
 * design — so proxy mode can never reach 'arm'.
 */
export function decideFirewallAction(input: {
  killSwitch: boolean
  lanSharing: boolean
  armed: boolean
  armedLanSharing: boolean
  tunnelActive: boolean
}): 'arm' | 'disarm' | 'rearm' | 'none' {
  if (input.armed && !input.killSwitch) return 'disarm'
  if (input.armed && input.lanSharing !== input.armedLanSharing) return 'rearm'
  if (!input.armed && input.killSwitch && input.tunnelActive) return 'arm'
  return 'none'
}

/**
 * Is a child-proxy protocol (v2ray/xray/hysteria2) actually carrying the user's
 * traffic? A live child process is NOT the same question.
 *
 * In PROXY mode it is: the spawned core is the whole connection, nothing is
 * routed, and only apps pointed at the SOCKS listener are tunneled.
 *
 * In TUNNEL mode the child is only half of it. The redirection IS tun2socks, so
 * until its interface exists nothing the user does goes through the node. That
 * gap is not theoretical: `connectV2Ray` spawns the core, THEN awaits
 * `tun-up` through polkit, so the whole time the password dialog is open the
 * child is alive and traffic is still going out of the physical NIC. Reporting
 * "connected" there put a green banner and the user's own home IP on screen at
 * the same time, and the egress-IP check cached the untunneled answer.
 *
 * It stayed hidden until `runPrivileged` stopped being synchronous: while the
 * call blocked the main process the status poll could not run inside the gap.
 */
export function isChildProxyCarryingTraffic(input: {
  childAlive: boolean
  proxyMode: boolean
  tunUp: boolean
}): boolean {
  if (!input.childAlive) return false
  return input.proxyMode || input.tunUp
}
