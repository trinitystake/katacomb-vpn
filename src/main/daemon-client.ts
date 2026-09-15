// User-space client for the root daemon. Runs in the Electron main process.
import { createConnection } from 'net'
import { existsSync } from 'fs'
import {
  DAEMON_SOCKET_PATH,
  type DaemonOp,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon-protocol'
import { withTimeout } from './async-utils'

/** The daemon is present (deb install). When false, callers use the pkexec fallback. */
export function isDaemonAvailable(): boolean {
  return existsSync(DAEMON_SOCKET_PATH)
}

/**
 * The daemon's socket exists but no connection could be established — a stale
 * socket after a crash/OOM (ECONNREFUSED/ENOENT) or a pre-connect timeout. Kept
 * distinct from a daemon op-rejection so `runPrivileged` can safely fall back to
 * pkexec for the former but never for the latter (which would retry a rejected
 * op as root).
 */
export class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUnreachableError'
  }
}

let nextId = 1

/**
 * Send one request to the daemon and resolve with its result (or reject with the
 * daemon's error / a transport error). One short-lived connection per call.
 */
export function daemonRequest(
  op: DaemonOp,
  args?: Record<string, unknown>,
  socketPath: string = DAEMON_SOCKET_PATH, // overridable only for tests
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const socket = createConnection(socketPath)
    let buf = ''
    let settled = false
    let connected = false
    const finish = (err: Error | null, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(result)
    }
    // A timeout *before* we ever connect means the daemon isn't accepting
    // connections (dead process / stale socket) → unreachable, safe to fall back.
    // After connect it's a stuck op → propagate (a retry could double-execute).
    const timer = setTimeout(
      () => finish(connected
        ? new Error(`daemon ${op} timed out`)
        : new DaemonUnreachableError(`daemon ${op}: connect timed out`)),
      60000,
    )

    socket.setEncoding('utf-8')
    socket.on('connect', () => {
      connected = true
      const req: DaemonRequest = { id, op, args }
      socket.write(JSON.stringify(req) + '\n')
    })
    socket.on('data', (chunk: string) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      let res: DaemonResponse
      try {
        res = JSON.parse(buf.slice(0, idx)) as DaemonResponse
      } catch {
        finish(new Error(`daemon ${op}: malformed response`))
        return
      }
      if (res.ok) finish(null, res.result)
      else finish(new Error(res.error || `daemon ${op} failed`))
    })
    // A socket error *before* connect = dead/stale daemon (ECONNREFUSED/ENOENT) →
    // unreachable. After connect = a mid-op transport failure → propagate as-is.
    socket.on('error', (err) =>
      finish(connected ? err : new DaemonUnreachableError(`daemon ${op}: ${err.message}`)))
  })
}

/**
 * What a running daemon says it can do. `ops` is absent on a daemon older than
 * the change that added it to the probe reply — that is "cannot say", NOT "does
 * nothing", so callers must not read a missing list as a refusal.
 */
export interface DaemonCapabilities {
  version: number
  ops: string[] | null
}

/**
 * Ask the daemon what it serves. Returns null when there is no reachable daemon
 * at all (no socket, or the probe failed), which is the ordinary AppImage/dev
 * case where `runPrivileged` uses pkexec instead.
 *
 * Deliberately NOT cached. The probe is a sub-millisecond round trip on a local
 * socket, and the one moment the answer changes is exactly when a user has just
 * restarted the daemon because we told them it was stale — a cached refusal
 * would survive the fix and keep blocking them.
 */
export async function daemonCapabilities(): Promise<DaemonCapabilities | null> {
  if (!isDaemonAvailable()) return null
  try {
    // Bound the wait: a wedged daemon holding the socket open would otherwise
    // stall the connect preflight for daemonRequest's full 60s budget.
    const result = await withTimeout(daemonRequest('protocol_version'), 3000, 'daemon probe')
    const r = (result ?? {}) as { version?: unknown; ops?: unknown }
    if (typeof r.version !== 'number') return null
    const ops = Array.isArray(r.ops) && r.ops.every((o) => typeof o === 'string')
      ? (r.ops as string[])
      : null
    return { version: r.version, ops }
  } catch {
    // Includes the `unknown op: protocol_version` refusal from a daemon that
    // predates the op entirely. Same answer: it cannot tell us, so do not block.
    return null
  }
}

/**
 * True when a running daemon is known NOT to serve `op` — i.e. it reported its
 * op list and `op` is absent. False in every uncertain case (no daemon, old
 * daemon, failed probe), so this can only ever add a refusal we are sure about.
 *
 * Why it exists: the skew that actually happens is a daemon left running across
 * an upgrade that lacks a newly ADDED op (amneziawg_* and openvpn_* were both
 * additive, with no protocol-version bump, so the version number cannot see it).
 * Without this the first sign is `unknown op` from the bring-up, which for those
 * two protocols is AFTER the session has been paid for.
 */
export async function daemonMissingOp(op: DaemonOp): Promise<boolean> {
  const caps = await daemonCapabilities()
  if (!caps || caps.ops === null) return false
  return !caps.ops.includes(op)
}

/**
 * How many IPsec/XFRM policies with a transform template are installed, or null
 * when we cannot know. IPsec VPNs (strongSwan, libreswan, most corporate
 * clients) install no network interface, so `detectOtherVpn`'s `ip link show`
 * cannot see them; reading the policies needs CAP_NET_ADMIN.
 *
 * Deliberately daemon-ONLY, never the pkexec fallback. On the AppImage and in
 * dev there is no daemon, and routing this through pkexec would put a password
 * prompt in front of a warning the user did not ask for and which must never
 * gate a connect. No daemon means null, and the caller reports what it can see.
 */
export async function daemonXfrmPolicyCount(): Promise<number | null> {
  if (!isDaemonAvailable()) return null
  try {
    const result = await withTimeout(daemonRequest('xfrm_policies'), 3000, 'daemon xfrm probe')
    const count = (result as { count?: unknown } | null)?.count
    return typeof count === 'number' ? count : null
  } catch {
    // Includes `unknown op` from a daemon predating this op. Same answer: unknown.
    return null
  }
}
