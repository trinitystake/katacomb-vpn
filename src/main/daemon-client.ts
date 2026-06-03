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

let nextId = 1

/**
 * Send one request to the daemon and resolve with its result (or reject with the
 * daemon's error / a transport error). One short-lived connection per call.
 */
export function daemonRequest(op: DaemonOp, args?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const socket = createConnection(DAEMON_SOCKET_PATH)
    let buf = ''
    let settled = false
    const finish = (err: Error | null, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error(`daemon ${op} timed out`)), 60000)

    socket.setEncoding('utf-8')
    socket.on('connect', () => {
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
    socket.on('error', (err) => finish(err))
  })
}
