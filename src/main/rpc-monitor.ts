import { BrowserWindow, net } from 'electron'
import { IPC } from '../shared/ipc-channels'
import {
  classifyRpc,
  needsConfirmation,
  type RpcCandidate,
  type RpcHealth,
  type RpcProbe,
} from '../shared/rpc-health'
import { isKillSwitchArmed } from './kill-switch'
import { getRpcEndpoint } from './settings'
import { isVpnActive } from './vpn-manager'

const PROBE_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 30_000
/** How many endpoints probeAll has in flight at once. */
const PROBE_CONCURRENCY = 6
/**
 * How long to leave a first bad reading unpublished before re-probing. Long
 * enough for the things that inflate it to finish — the routes and resolver a
 * teardown restores, a stranded kill-switch chain being flushed at startup, a
 * retransmitted SYN — and short enough that a genuinely bad endpoint is still
 * named within the same poll window rather than the next one.
 */
const CONFIRM_DELAY_MS = 2_500

/**
 * Health of the RPC endpoint currently configured, refreshed on a timer and
 * pushed to every window. Every chain read and every transaction goes through
 * this one endpoint, so when it's unhealthy the app can say so instead of
 * silently returning stale or empty data.
 */
let health: RpcHealth = {
  state: 'unknown',
  endpoint: '',
  reachable: false,
  latencyMs: null,
  chainId: null,
  height: null,
  blockAgeSec: null,
  error: null,
  checkedAt: 0,
}

let pollTimer: ReturnType<typeof setInterval> | null = null
/** Set while a probe is in flight, so a burst of failures doesn't fan out. */
let probeInFlight: Promise<void> | null = null
/** Set while a held bad reading is waiting to be re-probed (see CONFIRM_DELAY_MS). */
let confirmTimer: ReturnType<typeof setTimeout> | null = null

interface StatusResponse {
  result?: {
    node_info?: { network?: string }
    sync_info?: { latest_block_height?: string; latest_block_time?: string }
  }
}

/**
 * One `/status` round-trip. Returns a probe rather than throwing — every caller
 * wants the failure as data. `blockAgeSec` is what catches the nastiest kind of
 * bad endpoint: one that answers instantly but is hours behind the chain.
 */
async function probeRpc(endpoint: string): Promise<RpcProbe> {
  const start = Date.now()
  try {
    const response = await net.fetch(`${endpoint}/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - start
    if (!response.ok) {
      return { reachable: false, latencyMs, chainId: null, height: null, blockAgeSec: null, error: `RPC returned ${response.status}` }
    }
    const json = (await response.json()) as StatusResponse
    const sync = json?.result?.sync_info
    const heightRaw = sync?.latest_block_height
    const height = heightRaw !== undefined && /^\d+$/.test(heightRaw) ? parseInt(heightRaw, 10) : null
    const blockTime = sync?.latest_block_time ? Date.parse(sync.latest_block_time) : NaN
    return {
      reachable: true,
      latencyMs,
      chainId: json?.result?.node_info?.network ?? null,
      height,
      blockAgeSec: Number.isFinite(blockTime) ? Math.max(0, Math.round((Date.now() - blockTime) / 1000)) : null,
      error: null,
    }
  } catch (err) {
    return {
      reachable: false,
      latencyMs: null,
      chainId: null,
      height: null,
      blockAgeSec: null,
      error: err instanceof Error ? err.message : 'RPC probe failed',
    }
  }
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.RPC_HEALTH_UPDATE, health)
  }
}

function setHealth(next: RpcHealth): void {
  const changed =
    next.state !== health.state ||
    next.endpoint !== health.endpoint ||
    next.latencyMs !== health.latencyMs ||
    next.height !== health.height
  health = next
  if (changed) broadcast()
}

function cancelConfirm(): void {
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

/**
 * What we already know about the path to the chain without sending anything, or
 * null when a probe is the only way to find out.
 *
 * Order matters: while connected with the kill switch on, both hold — and the
 * tunnel is the reason the app isn't querying, so it wins.
 */
function unprobedState(): 'suspended' | 'blocked' | null {
  if (isVpnActive()) return 'suspended'
  // A session that expires with the kill switch on leaves the DROP-all chain up
  // by design (standDownSession). Probing through it fails every time, and
  // reporting that as `down` blames the endpoint for our own firewall.
  if (isKillSwitchArmed()) return 'blocked'
  return null
}

/**
 * Publish a state we know without probing: `suspended` while our own tunnel
 * carries the traffic, `blocked` while our own kill switch drops it, `unknown`
 * in the moment after either goes away, when the honest answer is that nothing
 * has been measured yet.
 */
function publishUnprobed(state: 'suspended' | 'blocked' | 'unknown', endpoint: string): void {
  setHealth({
    state,
    endpoint,
    reachable: false,
    latencyMs: null,
    chainId: null,
    height: null,
    blockAgeSec: null,
    error: null,
    checkedAt: Date.now(),
  })
}

/**
 * Probe the configured endpoint and publish the result.
 *
 * While our own tunnel is up, every chain handler short-circuits on
 * isVpnActive() and serves its cache instead — no query is sent through the
 * tunnel. Probing then would grade an endpoint the app isn't using (over a
 * route it wouldn't use either), so the state becomes `suspended` and no
 * request is made. Same for a kill-switch chain we left armed on purpose.
 *
 * `confirming` marks the second probe of a reading that needsConfirmation held
 * back; only that one may publish a fresh fault.
 */
async function refreshRpcHealth(opts: { confirming?: boolean } = {}): Promise<void> {
  if (probeInFlight) return probeInFlight
  const endpoint = getRpcEndpoint()

  const unprobed = unprobedState()
  if (unprobed) {
    cancelConfirm()
    publishUnprobed(unprobed, endpoint)
    return
  }

  probeInFlight = (async () => {
    const probe = await probeRpc(endpoint)
    // The tunnel can come up during the probe (10s window). Publishing the
    // result then would show a live endpoint the app has already stopped
    // querying, until the next poll corrected it.
    const nowUnprobed = unprobedState()
    if (nowUnprobed) {
      cancelConfirm()
      publishUnprobed(nowUnprobed, endpoint)
      return
    }
    const state = classifyRpc(probe)
    if (!opts.confirming && needsConfirmation(state, health.state)) {
      console.log(
        `[rpc] ${endpoint} probed ${state} (${probe.latencyMs ?? '-'}ms${probe.error ? `, ${probe.error}` : ''}) — ` +
        `re-probing in ${CONFIRM_DELAY_MS}ms before reporting it`,
      )
      if (!confirmTimer) {
        confirmTimer = setTimeout(() => {
          confirmTimer = null
          void refreshRpcHealth({ confirming: true })
        }, CONFIRM_DELAY_MS)
      }
      return
    }
    cancelConfirm()
    setHealth({ ...probe, state, endpoint, checkedAt: Date.now() })
  })()
  try {
    await probeInFlight
  } finally {
    probeInFlight = null
  }
}

export function getRpcHealth(): RpcHealth {
  return health
}

/**
 * Called from the chain handlers' existing catch blocks. It deliberately does
 * NOT mark the endpoint down itself — one flaky query would then strand the
 * indicator on red. It asks for an out-of-band probe, and the probe decides.
 */
export function reportRpcFailure(): void {
  void refreshRpcHealth()
}

/** Re-probe now — used after the endpoint setting changes. */
export function onRpcEndpointChanged(): void {
  // Any held reading belongs to the endpoint we just stopped using.
  cancelConfirm()
  void refreshRpcHealth()
}

/**
 * Re-evaluate now that the route between the app and the chain may have changed
 * — the tunnel came up or went down, or the kill switch was armed or disarmed.
 * Without this the pill only caught up on the next 30s poll, so a disconnect
 * left "RPC paused" on screen long enough to look stuck rather than merely stale.
 *
 * When the path just cleared, the pill goes to "checking" first. The probe may
 * take a moment — longer still if its reading has to be confirmed — and leaving
 * "paused (VPN)" or "blocked" up meanwhile names a cause that is already gone.
 */
export function onChainPathChanged(): void {
  const stale = health.state === 'suspended' || health.state === 'blocked'
  if (stale && !unprobedState()) publishUnprobed('unknown', getRpcEndpoint())
  void refreshRpcHealth()
}

export function startRpcMonitor(): void {
  if (pollTimer) return
  void refreshRpcHealth()
  pollTimer = setInterval(() => { void refreshRpcHealth() }, POLL_INTERVAL_MS)
}

export function stopRpcMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  cancelConfirm()
}

/**
 * Probe a list of endpoints, a few at a time. Feeds both the failover banner's
 * "switch to a working endpoint" and the Settings list, so neither has to walk
 * the list serially the way the old click-to-test flow did.
 */
export async function probeAll(endpoints: string[]): Promise<RpcCandidate[]> {
  const results: RpcCandidate[] = []
  const queue = [...endpoints]
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
    for (let endpoint = queue.shift(); endpoint !== undefined; endpoint = queue.shift()) {
      results.push({ endpoint, probe: await probeRpc(endpoint) })
    }
  })
  await Promise.all(workers)
  return results
}
