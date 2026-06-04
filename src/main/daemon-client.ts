// User-space client for the root daemon. Runs in the Electron main process.
import { createConnection } from 'net'
import { existsSync } from 'fs'
import {
  DAEMON_SOCKET_PATH,
  type DaemonOp,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon-protocol'

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
