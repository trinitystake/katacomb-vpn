import { IPC } from '../../shared/ipc-channels'
import { withTimeout } from '../async-utils'
import { isSafeNodeApiUrl } from '../config-guard'
import { fetchFreshSocket } from '../net-fetch'
import { SocksHttpsAgent } from '../socks-agent'
import { getRpcHealth, probeFeedCandidates, runAutoRpcSelectionReport } from '../chain/rpc-monitor'
import { binaryExists, isBinaryAvailable, isVpnActive, getActiveProxyPort } from '../vpn/vpn-manager'
import {
  probeNode,
  startBatch,
  cancelBatch,
  speedTest,
  getAllCachedResults,
  fetchNodeServiceMetadata,
  NODE_PROTOCOL_CHECK_TIMEOUT_MS,
} from '../nodes/node-tester'
import { classifyHopEligibility, type HopMetadataEntry } from '../protocols/multihop-config'
import { assertString } from './validate'
import type { Handle } from './handle'

// A node's advertised inbounds change only when its operator reconfigures it, so a
// long TTL is safe and keeps the multihop picker from re-probing on every render.
const CHAIN_ELIGIBILITY_TTL_MS = 10 * 60 * 1000
// The picker probes in chunks; this bounds one IPC call, not the whole list.
const CHAIN_ELIGIBILITY_MAX_BATCH = 60
const CHAIN_ELIGIBILITY_CONCURRENCY = 8
// Grading through an already-connected local proxy: an extra hop each way, so more
// than the direct budget. Well under NODE_CHECK_VIA_PROXY_TIMEOUT_MS, though — that
// one is generous because a timeout there strands a paid entry session, whereas a
// slow answer here only costs one row in the picker.
const CHAIN_ELIGIBILITY_VIA_PROXY_TIMEOUT_MS = 15_000
// Public IP lookups (NETWORK_GET_IP). Short on purpose: icanhazip answers in
// ~100ms on a working path, and a hung service should fail into the renderer's
// retry ladder rather than hold the status-bar spinner for 15s.
const IP_LOOKUP_TIMEOUT_MS = 5_000

/** How a node graded for each end of a chain. `reachable: false` means unknown. */
interface ChainEligibilityResult {
  nodeAddress: string
  checkedAt: number
  reachable: boolean
  transports: string[]
  entry: boolean
  exit: boolean
  entrySecurity: 'reality' | 'tls' | null
  exitSecurity: 'reality' | 'tls' | null
  error?: string
}
const chainEligibilityCache = new Map<string, ChainEligibilityResult>()

/**
 * Read-only diagnostics: RPC health, bundled-binary presence, node latency
 * probing, multihop eligibility grading, and the public-IP lookup.
 *
 * None of these spends money or touches the tunnel, which is why they live
 * apart from the connection state machine in ipc-handlers.ts. The one thing
 * here that reaches the network on the user's behalf - the eligibility grade -
 * routes through the active proxy when one exists and must never retry direct.
 */
export function registerDiagnosticsHandlers(handle: Handle): void {
  // Live health of the endpoint currently in use (pushed on change via RPC_HEALTH_UPDATE)
  handle(IPC.RPC_HEALTH_GET, async () => {
    return getRpcHealth()
  })

  // Probe the public endpoint list in parallel — feeds the failover banner and
  // the Settings list, so neither has to test one endpoint per click.
  handle(IPC.RPC_PROBE_ALL, async () => {
    return probeFeedCandidates()
  })

  // Retest and reselect: one shared probe pass runs the auto-selection and
  // returns the exact rows it graded, so the list on screen can never disagree
  // with the decision.
  handle(IPC.RPC_AUTO_SELECT, async () => {
    return runAutoRpcSelectionReport()
  })

  // Binary check — checks bundled binaries first, then system PATH. tun2socks is
  // deliberately NOT here: the engine is compiled into the privileged helper, so
  // there is no tun2socks executable to find and no package that would be used if
  // one were installed. Probing for it reported a permanent "Missing" on a healthy
  // install (seen on the 1.9.0 deb) and pointed users at an irrelevant apt package.
  handle(IPC.BINARY_CHECK, async () => {
    return {
      wireguard: binaryExists('wg-quick'),
      v2ray: isBinaryAvailable('v2ray'),
    }
  })

  // Node Testing: Single probe
  handle(IPC.NODE_TEST_PROBE, async (_event, params: { nodeAddress: string; remoteUrl: string }) => {
    assertString(params.nodeAddress, 'nodeAddress')
    // A non-empty remoteUrl must be a safe http(s) endpoint (finding M3); empty is
    // allowed and handled gracefully by probeNode ("No API endpoint").
    if (typeof params.remoteUrl === 'string' && params.remoteUrl !== '' && !isSafeNodeApiUrl(params.remoteUrl)) {
      throw new Error('Invalid node probe URL')
    }
    return probeNode(params.remoteUrl, params.nodeAddress)
  })

  // Node Testing: Batch probe
  handle(IPC.NODE_TEST_BATCH, async (_event, nodes: Array<{ nodeAddress: string; remoteUrl: string }>) => {
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('Invalid nodes array')
    for (const n of nodes) {
      assertString(n.nodeAddress, 'nodeAddress')
      // Same http(s)-only guard as the single probe (finding M3); empty is allowed.
      if (typeof n.remoteUrl === 'string' && n.remoteUrl !== '' && !isSafeNodeApiUrl(n.remoteUrl)) {
        throw new Error('Invalid node probe URL')
      }
    }
    startBatch(nodes)
  })

  // Node Testing: Cancel batch
  handle(IPC.NODE_TEST_CANCEL, async () => {
    cancelBatch()
  })

  // Node Testing: Speed test on active connection
  handle(IPC.NODE_TEST_SPEED, async () => {
    if (!isVpnActive()) throw new Error('No active VPN connection')
    return speedTest()
  })

  // Node Testing: Get cached results
  handle(IPC.NODE_TEST_RESULTS, async () => {
    return getAllCachedResults()
  })

  // Multihop: grade nodes for each end of a chain, BEFORE anything is paid for.
  //
  // The exit hop of a chain must serve plain TCP (only TCP delegates dialing to
  // xray's detour dialer — see EXIT_TRANSPORTS), and that fact is not in the node
  // list: the aggregator publishes one transport per node, which reports tcp for 16
  // nodes network-wide while 138 of 241 healthy v9 nodes actually serve one. So it
  // has to come from each node's own listing. Cheap and unauthenticated — the same
  // root-path request the protocol preflight already makes.
  handle(IPC.NODE_CHAIN_ELIGIBILITY, async (_event, nodes: Array<{
    nodeAddress: string; remoteUrl: string; nodeType: number
  }>) => {
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('Invalid nodes array')
    if (nodes.length > CHAIN_ELIGIBILITY_MAX_BATCH) {
      throw new Error(`Too many nodes in one batch (max ${CHAIN_ELIGIBILITY_MAX_BATCH})`)
    }
    for (const n of nodes) {
      assertString(n.nodeAddress, 'nodeAddress')
      if (typeof n.remoteUrl === 'string' && n.remoteUrl !== '' && !isSafeNodeApiUrl(n.remoteUrl)) {
        throw new Error('Invalid node probe URL')
      }
      if (n.nodeType !== 2 && n.nodeType !== 4) {
        throw new Error('Only V2Ray (2) and XRAY (4) nodes can be chained')
      }
    }

    const now = Date.now()
    const out: ChainEligibilityResult[] = new Array(nodes.length)
    let index = 0
    // Grading is unauthenticated and carries no session, but it still tells every node
    // it asks that this address is shopping for a chain. When a tunnel is already up we
    // send it through that tunnel rather than off the physical NIC.
    //
    // Only proxy mode needs an agent to do it. In tunnel mode the OS has already put
    // these probes in the tunnel (see getActiveProxyPort), so asking for one there would
    // route tunnel traffic through a proxy that isn't running. One agent for the batch:
    // it opens a fresh socket per request (keepAlive false) and is safe to share.
    const proxyPort = getActiveProxyPort()
    const proxyAgent = proxyPort === null ? undefined : new SocksHttpsAgent(proxyPort)
    async function worker(): Promise<void> {
      while (index < nodes.length) {
        const slot = index++
        const node = nodes[slot]
        // Keyed by node alone, unlike node-tester's rootMemo. There, a direct answer
        // satisfying a proxied read would skip a request that existed to BE proxied;
        // here a cache hit means no request at all, which is the better outcome either
        // way, so the route it was first learned over doesn't matter.
        const cached = chainEligibilityCache.get(node.nodeAddress)
        if (cached && now - cached.checkedAt < CHAIN_ELIGIBILITY_TTL_MS) {
          out[slot] = cached
          continue
        }
        let result: ChainEligibilityResult
        try {
          // Same reason preflightConnect wraps its own call: nodeFetch's timeout
          // covers socket inactivity, not the TCP connect, so a blackholed node
          // hangs past it. Through the proxy each probe crosses an extra hop, but
          // no money rides on this one, so it gets a tighter budget than the
          // purchase-time check.
          const metadata = await withTimeout(
            fetchNodeServiceMetadata(node.remoteUrl, proxyAgent),
            proxyAgent ? CHAIN_ELIGIBILITY_VIA_PROXY_TIMEOUT_MS : NODE_PROTOCOL_CHECK_TIMEOUT_MS,
            'node inbound listing',
          )
          const graded = classifyHopEligibility(
            node.nodeType === 4 ? 'xray' : 'v2ray',
            metadata as HopMetadataEntry[],
          )
          result = { nodeAddress: node.nodeAddress, checkedAt: Date.now(), reachable: true, ...graded }
        } catch (err) {
          // Unreachable and "too old to say" are both reported as unknown rather
          // than as a refusal: a v8.3.1 node may well work, we just cannot tell
          // without paying, and the picker says so instead of hiding it.
          //
          // A proxied probe that fails lands here too, and deliberately does NOT
          // retry direct: falling back would leak the address this route exists to
          // hide, and would do it silently. The row reads as unknown instead.
          result = {
            nodeAddress: node.nodeAddress,
            checkedAt: Date.now(),
            reachable: false,
            transports: [],
            entry: false,
            exit: false,
            entrySecurity: null,
            exitSecurity: null,
            error: err instanceof Error ? err.message : 'Probe failed',
          }
        }
        chainEligibilityCache.set(node.nodeAddress, result)
        out[slot] = result
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CHAIN_ELIGIBILITY_CONCURRENCY, nodes.length) }, worker),
    )
    return out
  })

  // Network: public IP lookup, two single-purpose modes the renderer stages.
  // includeGeo=false is the IP itself from icanhazip.com (fast, unmetered) —
  // rendered immediately, and the thing whose failure means "unreachable".
  // includeGeo=true is the ipapi.co geo enrichment ONLY: its free tier is
  // limited per SOURCE IP, and through a tunnel the source is the exit node's
  // shared address, so 429 is the ordinary case on a busy node (measured live
  // through a Sydney exit) — the renderer treats it as best-effort decoration
  // and never blocks the IP on it. Failures return an empty ip rather than
  // throwing: a dead lookup is what an idle tunnel looks like, not a fault, and
  // letting the AbortError escape logged a handler stack trace on every poll.
  handle(IPC.NETWORK_GET_IP, async (_event, includeGeo?: boolean) => {
    if (includeGeo !== false) {
      try {
        const response = await fetchFreshSocket('https://ipapi.co/json/', IP_LOOKUP_TIMEOUT_MS)
        if (response.status !== 200) throw new Error(`IP lookup failed: ${response.status}`)
        const json = JSON.parse(response.body) as {
          ip?: string; country_name?: string; city?: string; asn?: string; org?: string
        }
        return {
          ip: json.ip || '',
          country: json.country_name || '',
          city: json.city || '',
          asn: json.asn || '',
          org: json.org || '',
        }
      } catch {
        return { ip: '', country: '', city: '', asn: '', org: '' }
      }
    }
    try {
      const response = await fetchFreshSocket('https://icanhazip.com', IP_LOOKUP_TIMEOUT_MS)
      if (response.status !== 200) throw new Error(`IP lookup failed: ${response.status}`)
      return { ip: response.body.trim(), country: '', city: '', asn: '', org: '' }
    } catch {
      return { ip: '', country: '', city: '', asn: '', org: '' }
    }
  })
}
