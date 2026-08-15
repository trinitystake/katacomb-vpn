import https from 'node:https'
import http from 'node:http'
import { net, BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'

// dVPN nodes use self-signed TLS certificates, so we need a custom agent
const insecureAgent = new https.Agent({ rejectUnauthorized: false })

/**
 * Fetch a URL accepting self-signed certs (for node probes).
 *
 * `agent` overrides the direct one, which is how the multihop path asks a node about
 * itself THROUGH the entry hop instead of from the user's own address (see
 * socks-agent.ts). It must carry its own rejectUnauthorized:false.
 */
function nodeFetch(
  url: string,
  timeoutMs: number,
  agent?: https.Agent,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https')
    const mod = isHttps ? https : http
    const options = isHttps ? { agent: agent ?? insecureAgent } : {}
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

// In-memory cache of the last probe per node, surfaced to the renderer on mount
// via getAllCachedResults() so the latency column survives navigation. Probes are
// never served FROM this cache — an explicit Test / Test Nodes click always
// re-probes (see probeNode), so re-clicking recalculates the latency.
const probeCache = new Map<string, NodeProbeResult>()
const CACHE_TTL = 10 * 60 * 1000 // results older than this are dropped on read

// Active batch abort controller
let batchAbort: AbortController | null = null

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
    // Hit root path — dVPN nodes serve status at /
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

/**
 * Ask a node what protocol it actually runs. dVPN nodes serve their info at
 * the ROOT path as `{success, result:{…, service_type}}` (there is no /info route
 * — it 404s); `service_type` is a string on v9 nodes ("amneziawg", "hysteria2").
 * Throws when the node is unreachable or the response isn't the expected shape,
 * so the caller can tell "mismatch" apart from "couldn't ask".
 */
export async function fetchNodeServiceType(remoteUrl: string, agent?: https.Agent): Promise<string | number> {
  const serviceType = (await fetchNodeRoot(remoteUrl, agent)).service_type
  if (serviceType === undefined) throw new Error('Node did not report a service type')
  return serviceType
}

/**
 * The inbounds a node advertises publicly (`service_metadata`), used to grade it
 * for each end of a multihop chain BEFORE any session is paid for. Present on
 * v9.0.0 nodes only — an older node throws, and the caller reports it as unknown
 * rather than guessing.
 *
 * Note what this listing does NOT carry: every node measured reports `port: ""`
 * and `tls_pin: ""` here, because both are minted per session and only appear in
 * the handshake response. `classifyHopEligibility` is written to that shape.
 */
export async function fetchNodeServiceMetadata(remoteUrl: string, agent?: https.Agent): Promise<NodeInboundListing[]> {
  const metadata = (await fetchNodeRoot(remoteUrl, agent)).service_metadata
  if (!Array.isArray(metadata)) throw new Error('this node runs a version older than 9.0.0, which publishes no inbound list')
  return metadata
}

/** One entry of a node's advertised `service_metadata`. */
export interface NodeInboundListing {
  port: string | number
  proxy_protocol: number
  transport_protocol: number
  transport_security: number
}

interface NodeRootInfo {
  service_type?: string | number
  service_metadata?: NodeInboundListing[]
}

/**
 * In-flight/just-finished root reads, so back-to-back questions about the SAME node
 * cost one request. The pre-purchase gate asks two of them within milliseconds
 * (`preflightConnect` wants `service_type`, `assertChainEligible` wants
 * `service_metadata`, both from this one document), and for a chain that was four
 * requests with a 10s timeout each in front of the connect button.
 *
 * Deliberately tiny and success-only: this must not turn into the answer cache that
 * `chainEligibilityCache` already is, and a node that failed has to be retried, not
 * remembered. Long enough to span one connect attempt, short enough that nothing else
 * can observe a stale reading.
 */
const ROOT_MEMO_MS = 5000
const rootMemo = new Map<string, { at: number; info: NodeRootInfo }>()

/**
 * A stable id per agent, so the memo below can be keyed by ROUTE as well as URL.
 *
 * Load-bearing for multihop privacy, not just tidiness: the picker probes candidate
 * exits directly, and the purchase-time checks then ask the same node the same question
 * through the entry hop. Keyed on the URL alone, that direct answer would satisfy the
 * proxied read and the request that was supposed to come from the entry would simply
 * never be made — the fix would look like it worked while changing nothing.
 */
const agentIds = new WeakMap<https.Agent, number>()
let nextAgentId = 1
function routeKey(agent?: https.Agent): string {
  if (!agent) return 'direct'
  let id = agentIds.get(agent)
  if (id === undefined) {
    id = nextAgentId++
    agentIds.set(agent, id)
  }
  return `via${id}`
}

async function fetchNodeRoot(remoteUrl: string, agent?: https.Agent): Promise<NodeRootInfo> {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') {
    throw new Error('Node has no API endpoint')
  }
  const normalizedUrl = remoteUrl.startsWith('http') ? remoteUrl : `https://${remoteUrl}`
  const url = normalizedUrl.replace(/\/+$/, '') + '/'
  const now = Date.now()
  const memoKey = `${routeKey(agent)} ${url}`
  const memo = rootMemo.get(memoKey)
  if (memo && now - memo.at < ROOT_MEMO_MS) return memo.info

  // Through a proxy this request crosses an extra hop before it reaches the node, so
  // the direct budget is not the right one. Being mean here would fail a chain whose
  // ENTRY session is already paid for, over latency we introduced ourselves.
  const response = await nodeFetch(url, agent ? 15000 : 8000, agent)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Node returned HTTP ${response.status}`)
  }
  const json = JSON.parse(response.body) as { result?: NodeRootInfo }
  const info = json.result ?? {}
  // Bounded by time, but also by size, so a long picker session probing hundreds of
  // nodes can't grow this without limit.
  if (rootMemo.size > 200) rootMemo.clear()
  rootMemo.set(memoKey, { at: now, info })
  return info
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
