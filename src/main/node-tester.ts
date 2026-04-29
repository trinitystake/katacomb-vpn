import https from 'node:https'
import http from 'node:http'
import { net, BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'

// Sentinel nodes use self-signed TLS certificates, so we need a custom agent
const insecureAgent = new https.Agent({ rejectUnauthorized: false })

/** Fetch a URL accepting self-signed certs (for node probes). */
function nodeFetch(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https')
    const mod = isHttps ? https : http
    const options = isHttps ? { agent: insecureAgent } : {}
    const req = mod.get(url, options, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout')) })
  })
}

export interface NodeProbeResult {
  nodeAddress: string
  timestamp: number
  reachable: boolean
  latencyMs: number | null
  error?: string
}

export interface SpeedTestResult {
  downloadMbps: number
  googleLatencyMs: number | null
  googleReachable: boolean
  error?: string
}

// In-memory cache: address -> result (10-minute expiry)
const probeCache = new Map<string, NodeProbeResult>()
const CACHE_TTL = 10 * 60 * 1000

// Active batch abort controller
let batchAbort: AbortController | null = null

function getCachedResult(nodeAddress: string): NodeProbeResult | null {
  const cached = probeCache.get(nodeAddress)
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    probeCache.delete(nodeAddress)
    return null
  }
  return cached
}

export function getAllCachedResults(): Record<string, NodeProbeResult> {
  const results: Record<string, NodeProbeResult> = {}
  const now = Date.now()
  for (const [addr, result] of probeCache) {
    if (now - result.timestamp <= CACHE_TTL) {
      results[addr] = result
    } else {
      probeCache.delete(addr)
    }
  }
  return results
}

export async function probeNode(remoteUrl: string, nodeAddress: string): Promise<NodeProbeResult> {
  // Check cache first
  const cached = getCachedResult(nodeAddress)
  if (cached) return cached

  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') {
    const result: NodeProbeResult = {
      nodeAddress,
      timestamp: Date.now(),
      reachable: false,
      latencyMs: null,
      error: 'No API endpoint',
    }
    probeCache.set(nodeAddress, result)
    return result
  }

  const timestamp = Date.now()
  try {
    // Ensure URL has a scheme (api field may be bare host:port)
    const normalizedUrl = remoteUrl.startsWith('http') ? remoteUrl : `https://${remoteUrl}`
    // Hit root path — Sentinel nodes serve status at /
    const url = normalizedUrl.replace(/\/+$/, '') + '/'
    const start = performance.now()
    const response = await nodeFetch(url, 8000)
    const latencyMs = Math.round(performance.now() - start)

    if (response.status < 200 || response.status >= 300) {
      const result: NodeProbeResult = {
        nodeAddress,
        timestamp,
        reachable: false,
        latencyMs: null,
        error: `HTTP ${response.status}`,
      }
      probeCache.set(nodeAddress, result)
      return result
    }

    // Try to parse JSON for extra status info
    let statusOk = true
    try {
      const json = JSON.parse(response.body) as { success?: boolean; result?: unknown }
      if (json.success === false) statusOk = false
    } catch {
      // Non-JSON response is fine — the node responded
    }

    const result: NodeProbeResult = {
      nodeAddress,
      timestamp,
      reachable: statusOk,
      latencyMs,
      error: statusOk ? undefined : 'Node reports unhealthy',
    }
    probeCache.set(nodeAddress, result)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isTimeout = message.includes('abort') || message.includes('timeout') || message.includes('TimeoutError')
    const result: NodeProbeResult = {
      nodeAddress,
      timestamp,
      reachable: false,
      latencyMs: null,
      error: isTimeout ? 'Timeout' : message,
    }
    probeCache.set(nodeAddress, result)
    return result
  }
}

export async function probeBatch(
  nodes: Array<{ nodeAddress: string; remoteUrl: string }>,
  signal: AbortSignal,
): Promise<void> {
  const CONCURRENCY = 3
  let done = 0
  const total = nodes.length
  let index = 0

  function sendProgress(result: NodeProbeResult): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.NODE_TEST_PROGRESS, { done, total, result })
    }
  }

  async function worker(): Promise<void> {
    while (index < nodes.length) {
      if (signal.aborted) return
      const current = nodes[index++]
      const result = await probeNode(current.remoteUrl, current.nodeAddress)
      done++
      sendProgress(result)
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, nodes.length) }, () => worker())
  await Promise.all(workers)
}

export function startBatch(
  nodes: Array<{ nodeAddress: string; remoteUrl: string }>,
): AbortController {
  cancelBatch()
  const controller = new AbortController()
  batchAbort = controller
  probeBatch(nodes, controller.signal).finally(() => {
    if (batchAbort === controller) batchAbort = null
  })
  return controller
}

export function cancelBatch(): void {
  if (batchAbort) {
    batchAbort.abort()
    batchAbort = null
  }
}

const SPEED_TEST_URLS = [
  'https://speed.cloudflare.com/__down?bytes=5000000',
  'https://proof.ovh.net/files/1Mb.dat',
  'http://speedtest.tele2.net/1MB.zip',
]

export async function speedTest(signal?: AbortSignal): Promise<SpeedTestResult> {
  let downloadMbps = 0
  let downloadError: string | undefined

  // Try download targets in order until one succeeds
  for (const url of SPEED_TEST_URLS) {
    if (signal?.aborted) break
    try {
      const start = performance.now()
      const response = await net.fetch(url, {
        signal: signal || AbortSignal.timeout(30000),
      })
      if (!response.ok) continue

      const buffer = await response.arrayBuffer()
      const elapsed = (performance.now() - start) / 1000 // seconds
      const bits = buffer.byteLength * 8
      downloadMbps = Math.round((bits / elapsed / 1_000_000) * 100) / 100
      downloadError = undefined
      break
    } catch (err) {
      downloadError = err instanceof Error ? err.message : 'Download failed'
    }
  }

  // Google reachability check
  let googleLatencyMs: number | null = null
  let googleReachable = false
  try {
    const start = performance.now()
    const res = await net.fetch('https://www.google.com/generate_204', {
      signal: AbortSignal.timeout(10000),
    })
    googleLatencyMs = Math.round(performance.now() - start)
    googleReachable = res.status === 204 || res.ok
  } catch {
    // Google unreachable through tunnel
  }

  return {
    downloadMbps,
    googleLatencyMs,
    googleReachable,
    error: downloadError,
  }
}
