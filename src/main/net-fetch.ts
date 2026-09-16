import { get as httpsGet } from 'node:https'

/**
 * GET over a FRESH socket every time (`agent: false` → Connection: close, no
 * pooling). Chromium's pooled keep-alive sockets are a trap across a tunnel
 * transition: a socket opened BEFORE connect routes out the physical NIC, and
 * once the kill switch is armed its packets are silently DROPped — no RST ever
 * arrives, so Chromium cannot detect the corpse and a reused socket just hangs
 * until the caller's abort. Live symptom: the IP display taking ~6s after a
 * Sessions-tab reconnect (stale socket from the disconnect-time lookup, 5s
 * hang, then the 1s retry dialing fresh through the tunnel) while every fresh
 * dial answered in ~100ms. The probes and IP lookups are rare and tiny, so one
 * TLS setup per request costs nothing.
 */
export function fetchFreshSocket(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { agent: false, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}
