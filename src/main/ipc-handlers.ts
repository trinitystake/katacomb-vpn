import { ipcMain, net, BrowserWindow, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { IPC } from '../shared/ipc-channels'
import { writeFileAtomic } from './fs-utils'
import {
  hasStoredWallet,
  generateMnemonicPhrase,
  importWallet,
  restoreWallet,
  switchWallet,
  deriveSubaccount,
  getAddress,
  getBalance,
  getActiveSessions,
  getWallet,
  getPrivKey,
  logout,
} from './wallet'
import { subscribeToNode, performHandshake, resolveNodeRemoteUrl, loadSessionConfig, endSession, V2RayPolicyError } from './chain-service'
import { withTimeout } from './async-utils'
import { sessionFailureMessage, decideReconnect, serviceTypeToNodeType, stripDnsLines } from './connect-decisions'
import { discoverPlans, listCachedPlans, listNodesForPlan, listPlansForNode, queryPlanAllocations, subscribeToPlan, startSessionWithExistingSubscription, querySubscriptions, cancelSubscription, updateSubscriptionPolicy } from './plan-service'
import { getProvider, listProviders } from './provider-service'
import { getCachedProviders } from './provider-cache'
import { loadSettings, saveSettings, listWallets, deleteWalletEntry, renameWallet, type AppSettings } from './settings'
import { loadNodesCache, saveNodesCache, type NodesCacheFile } from './nodes-cache'
import {
  connectV2Ray,
  connectWireGuard,
  connectWireGuardFromConfig,
  connectAmneziaWgFromConfig,
  connectV2RayFromConfig,
  connectXRayFromConfig,
  connectHysteria2FromConfig,
  disconnect,
  getConnectionStatus,
  isVpnActive,
  detectOtherVpn,
  getV2RayError,
  bringUpV2RayTunnel,
  getV2RayRemoteHost,
  getWireGuardRemoteHost,
  isWireGuardUp,
  binaryExists,
  isBinaryAvailable,
  protocolRuntimeError,
} from './vpn-manager'
import { runPrivileged, canEscalatePrivileges } from './privileged'
import { isAllowedBypassCidr, isAllowedDnsResolver, isSafeNodeApiUrl } from './config-guard'
import { enableKillSwitch, disableKillSwitch, isKillSwitchArmed } from './kill-switch'
import { getTrafficStats, resetTrafficStats, maxUsageBytes } from './traffic-stats'
import { probeNode, startBatch, cancelBatch, speedTest, getAllCachedResults, fetchNodeServiceType } from './node-tester'
import { onV2RayUnexpectedExit } from './vpn-manager'
import type { Wireguard, V2Ray } from '@sentinel-official/sentinel-js-sdk'

const NODES_API = 'https://api.sentnodes.com/v2/nodes'
const PUBLIC_RPC_API = 'https://sentnodes.com/public-rpc/json'
const PUBLIC_RPC_TTL_MS = 60_000
const RECONNECT_MAX_ATTEMPTS = 5
// Bound the refund (endSession) so a slow RPC during the failure path can't itself
// hang the connect flow — see establishSessionOrRefund (finding H1).
const REFUND_TIMEOUT_MS = 10_000
// Bound the pre-payment protocol check — it blocks the connect button.
const NODE_PROTOCOL_CHECK_TIMEOUT_MS = 10_000
// The kill switch drops any DNS that isn't tunnel-routed, so when it's on we
// need a resolver reachable through the tunnel. A 'system' resolver is usually a
// LAN/systemd-resolved address that won't route through the tunnel — fall back to
// this public resolver (in ALLOWED_DNS_RESOLVERS; reached via the tunnel, so the
// node sees its IP, not yours).
const DEFAULT_KILLSWITCH_DNS = '1.1.1.1'

/**
 * The resolver IP to apply for a V2Ray connection, or null for no override
 * (System Default with the kill switch off). Single source of truth shared by the
 * connect path (DoH injection into the v2ray config) and applyPostConnectSettings
 * (resolv.conf override + the kill-switch DNS allowance). A chosen resolver becomes
 * DoH inside v2ray (see withV2RayDoH); 'system' stays plaintext unless the kill
 * switch forces a public fallback.
 */
function effectiveV2RayResolverIp(settings: AppSettings): string | null {
  if (settings.dnsResolver !== 'system') return settings.dnsResolver
  return settings.killSwitch ? DEFAULT_KILLSWITCH_DNS : null
}

let activeWg: Wireguard | null = null
let activeV2ray: V2Ray | null = null
// Xray/Hysteria2 have no SDK instance (we build their configs ourselves), so we hold
// the built config string across the subscribe→connect handoff, like activeWg/activeV2ray.
let activeXrayConfig: string | null = null
let activeHysteria2Config: string | null = null
let activeAmneziaWgConfig: string | null = null
let activeSessionId: string | null = null
let activeNodeInfo: { address: string; moniker: string; country: string; type: number; v2raySummary?: string } | null = null
// True when the user enabled the kill switch but arming it failed — surfaced to
// the renderer so "protected" is never silently a lie.
let killSwitchFailed = false
// True when a kill-switch TEARDOWN failed while it was armed — the DROP-all chain may
// still be blocking traffic until the next-launch self-heal. Surfaced so the renderer
// can warn even in the idle state (finding M6).
let killSwitchTeardownFailed = false

// Cached values returned when VPN is active and RPC is unreachable
let lastKnownBalance: { denom: string; amount: string }[] = []
let lastKnownSessions: unknown[] = []
let cachedNodes: { address: string; moniker: string; country: string }[] = []

// Per-session usage measured live during the last connect (on-chain baseline +
// interface bytes). After disconnect the on-chain counter lags, so WALLET_SESSIONS
// shows max(onChain, remembered) to keep the Session tab from collapsing to ~0
// until the chain settles. In-memory only (resets on app restart).
const lastSessionUsage = new Map<string, { downloadBytes: string; uploadBytes: string }>()

// Shared in-memory cache for the full node list. Seeded from disk on startup,
// refreshed on a 60s timer in main, broadcast to all renderer windows on update.
let nodesMemoryCache: NodesCacheFile | null = null
let nodeRefreshTimer: ReturnType<typeof setInterval> | null = null

// Tiny TTL cache for the public RPC list. The user only sees this when the
// Settings modal is open, so refreshing every minute is more than enough.
interface PublicRpcEntry {
  provider: string
  address: string
  status: number
  height: number
  location: string
  isLoadbalance: number
  availability: number
  errorReason: string | null
}
let publicRpcCache: { list: PublicRpcEntry[]; fetchedAt: number } | null = null

// Auto-reconnect state
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let isIntentionalDisconnect = false
// Bumped every time the connection lifecycle ends (a disconnect). An in-flight
// reconnect captures it and bails if it changes mid-flight, so a user disconnect
// can never be undone by a reconnect that completes after it (finding H4).
// isIntentionalDisconnect alone is insufficient — it's reset to false at the end
// of performDisconnect, so a reconnect body resolving afterward would miss it.
let connectionEpoch = 0

// Serializes the tunnel-affecting ops (connect / disconnect / reconnect) so they
// can't interleave and orphan a child process (finding M1). Composes with
// connectionEpoch: the lock prevents concurrent execution; the epoch invalidates a
// reconnect that was queued behind a disconnect.
let connectionLock: Promise<unknown> = Promise.resolve()
function withConnectionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = connectionLock.then(fn, fn)
  connectionLock = run.then(() => {}, () => {})
  return run
}

// The protocol we INTEND to be connected with for the current session. Distinct
// from vpn-manager's own `activeProtocol` (actual process/interface truth, which
// getConnectionStatus() clears the instant the interface drops): this one must
// survive a WG interface drop so the liveness monitor below knows to reconnect
// (finding L8 — the two are not duplication, so they're named apart, not merged).
// V2Ray has a process exit callback; WireGuard has no process to watch, so we poll.
let desiredProtocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | null = null
// Tunnel vs. local-proxy for the current session — a runtime choice, so it is
// deliberately NOT persisted in SavedSessionConfig (a session-tab reconnect is
// always full-tunnel). Auto-reconnect replays whatever the user picked.
let desiredMode: 'tunnel' | 'proxy' = 'tunnel'
let wgMonitorTimer: ReturnType<typeof setInterval> | null = null

function startWireGuardMonitor(): void {
  if (wgMonitorTimer) return
  wgMonitorTimer = setInterval(() => {
    // AmneziaWG shares the monitor: same sntl0 interface, same no-process-to-watch problem.
    if ((desiredProtocol !== 'wireguard' && desiredProtocol !== 'amneziawg') || isIntentionalDisconnect || reconnectAttempt > 0) return
    if (!activeSessionId) return
    if (!isWireGuardUp()) {
      console.log('[vpn] WireGuard interface dropped, attempting reconnect...')
      attemptReconnect()
    }
  }, 5000)
}

function stopWireGuardMonitor(): void {
  if (wgMonitorTimer) {
    clearInterval(wgMonitorTimer)
    wgMonitorTimer = null
  }
}

// Main-process listeners (e.g. the tray) for connection-state changes. Mirrors
// the onV2RayUnexpectedExit pattern: ipc-handlers owns the state and notifies on
// change — callers register a listener rather than us reaching into their module.
export interface ConnectionInfo {
  state: 'connected' | 'idle'
  nodeMoniker?: string
  nodeCountry?: string
}
let connectionStateListener: ((info: ConnectionInfo) => void) | null = null

export function onConnectionStateChanged(cb: (info: ConnectionInfo) => void): void {
  connectionStateListener = cb
}

/** Current connection info, for seeding the tray at startup. */
export function getConnectionInfo(): ConnectionInfo {
  return {
    state: getConnectionStatus().connected ? 'connected' : 'idle',
    nodeMoniker: activeNodeInfo?.moniker,
    nodeCountry: activeNodeInfo?.country,
  }
}

function sendStateChange(state: 'connected' | 'idle'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.CONNECTION_STATE_CHANGE, state)
  }
  connectionStateListener?.({ state, nodeMoniker: activeNodeInfo?.moniker, nodeCountry: activeNodeInfo?.country })
}

function sendReconnecting(attempt: number, maxAttempts: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.CONNECTION_RECONNECTING, attempt, maxAttempts)
  }
}

function applySession(
  sessionId: string,
  nodeAddress: string,
  nodeMoniker: string,
  nodeCountry: string,
  nodeType: number,
  result: { protocol: string; configString: string; wgInstance: Wireguard | null; v2rayInstance: V2Ray | null; v2raySummary?: string },
): void {
  activeSessionId = sessionId
  activeNodeInfo = { address: nodeAddress, moniker: nodeMoniker, country: nodeCountry, type: nodeType, v2raySummary: result.v2raySummary }
  activeWg = result.wgInstance
  activeV2ray = result.v2rayInstance
  activeXrayConfig = result.protocol === 'xray' ? result.configString : null
  activeHysteria2Config = result.protocol === 'hysteria2' ? result.configString : null
  activeAmneziaWgConfig = result.protocol === 'amneziawg' ? result.configString : null
}

/**
 * Turn a handshake/resolve failure into a human-readable reason. A node handshake
 * failure surfaces as an axios error whose `.message` collapses to a bare
 * "Request failed with status code 500", hiding the node's actual error body — the
 * one thing that explains WHY the node rejected us. When an HTTP response is present,
 * surface its status plus a snippet of the (possibly nested) error body instead.
 */
function describeHandshakeError(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: unknown } })?.response
  if (response && (response.status !== undefined || response.data !== undefined)) {
    let detail: unknown = response.data
    if (detail && typeof detail === 'object') {
      const obj = detail as Record<string, any>
      detail = obj.error?.message ?? obj.error ?? obj.message ?? JSON.stringify(obj)
    }
    const detailStr = typeof detail === 'string' ? detail.trim().slice(0, 300) : ''
    return `node returned HTTP ${response.status ?? '?'}${detailStr ? ` — ${detailStr}` : ''}`
  }
  return err instanceof Error ? err.message : String(err)
}

const NODE_TYPE_TO_PROTOCOL: Record<number, 'wireguard' | 'v2ray' | 'xray' | 'amneziawg' | 'hysteria2'> = {
  1: 'wireguard', 2: 'v2ray', 4: 'xray', 5: 'amneziawg', 6: 'hysteria2',
}

/**
 * Checks that run BEFORE the paying tx is broadcast, so a mislabeled node or a
 * runtime that can't bring the protocol up costs the user nothing. (Everything
 * after the tx is covered by establishSessionOrRefund, but a refund still burns
 * gas and a block of the user's time.)
 *
 * 1. Can we run this protocol at all — binaries present + integrity-verified,
 *    and for the root protocols, a daemon or the polkit helper to run them with.
 * 2. Does the node agree it runs this protocol? The node list is an aggregator
 *    cache; the node's own service_type is the authority.
 *
 * Throws with an actionable message; never silently downgrades.
 */
async function preflightConnect(nodeType: number, apiField: string): Promise<void> {
  const protocol = NODE_TYPE_TO_PROTOCOL[nodeType]
  if (!protocol) throw new Error(`Unsupported nodeType ${nodeType}`)

  const runtimeError = protocolRuntimeError(protocol)
  if (runtimeError) throw new Error(`Can't connect — not charged. ${runtimeError}`)

  // WireGuard/AmneziaWG go up as root: without the daemon or the helper the
  // bring-up has no way to escalate and would fail after payment.
  if (protocol === 'wireguard' || protocol === 'amneziawg') {
    if (!canEscalatePrivileges()) {
      throw new Error(
        `Can't connect — not charged. The privileged helper isn't installed, so ${protocol === 'wireguard' ? 'WireGuard' : 'AmneziaWG'} can't be brought up. Restart the app and accept the helper setup prompt.`
      )
    }
  }

  let reported: string | number
  try {
    // nodeFetch's own 8s timeout only covers socket inactivity, not the TCP
    // connect — a blackholed node hangs well past it (measured). This gate sits
    // in front of the connect button, so bound the whole wait.
    reported = await withTimeout(fetchNodeServiceType(apiField), NODE_PROTOCOL_CHECK_TIMEOUT_MS, 'node protocol check')
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error'
    throw new Error(`Node is unreachable — not charged (${reason}). Pick another node.`)
  }

  const actualType = serviceTypeToNodeType(reported)
  if (actualType !== nodeType) {
    throw new Error(
      `Node protocol mismatch — not charged. The node reports "${reported}" but the node list says ` +
      `${protocol}. Refresh the node list and pick another node.`
    )
  }
}

/**
 * After a session is created on-chain (funds locked), resolve the node's endpoint
 * and run the handshake. On ANY failure between session creation and a live
 * tunnel — an unresolvable endpoint, a timed-out/garbage handshake, or the V2Ray
 * VLess-none policy rejection — auto-cancel the just-created session (a bounded
 * refund) and throw an actionable, session-id-bearing message instead of orphaning
 * the deposit/allocation (finding H1). `isDeposit` tailors the refund wording (a
 * direct session locks a deposit; a plan session draws on a prepaid allocation).
 */
async function establishSessionOrRefund(params: {
  sessionId: string
  nodeAddress: string
  nodeType: number
  apiField: string
  nodeMoniker: string
  nodeCountry: string
  wallet: NonNullable<ReturnType<typeof getWallet>>
  address: string
  privKey: Uint8Array
  isDeposit: boolean
}): Promise<Awaited<ReturnType<typeof performHandshake>>> {
  const { sessionId, nodeAddress, nodeType, apiField, nodeMoniker, nodeCountry, wallet, address, privKey, isDeposit } = params
  try {
    const remoteUrl = await resolveNodeRemoteUrl(nodeAddress, apiField)
    return await performHandshake({ sessionId, nodeAddress, nodeType, remoteUrl, privKey, nodeMoniker, nodeCountry })
  } catch (err) {
    let refunded = false
    try {
      await withTimeout(endSession({ wallet, address, sessionId }), REFUND_TIMEOUT_MS, 'refund')
      refunded = true
    } catch (refundErr) {
      console.error('[connect] auto-cancel of failed session failed:', refundErr)
    }
    throw new Error(sessionFailureMessage({
      refunded,
      isDeposit,
      sessionId,
      nodeMoniker,
      reason: describeHandshakeError(err),
      policyRejected: err instanceof V2RayPolicyError,
    }))
  }
}

// App-owned marker recording that /etc/resolv.conf may currently hold our DNS
// override (V2Ray/XRAY/Hysteria2 only — WireGuard's wg-quick manages its own).
// Mirrors the kill-switch armed marker: it lets the quit/disconnect path skip a
// (privileged) `dns-restore` when we never overrode DNS, so a clean session never
// touches root — which on the pkexec fallback path (AppImage/dev) means no prompt.
function dnsOverrideMarkerPath(): string {
  return join(app.getPath('userData'), 'dns-override.state')
}

function markDnsOverridden(): void {
  try {
    writeFileAtomic(dnsOverrideMarkerPath(), 'set\n')
  } catch { /* best-effort — marker is only a hint for teardown */ }
}

function isDnsOverridden(): boolean {
  return existsSync(dnsOverrideMarkerPath())
}

function clearDnsOverridden(): void {
  try {
    unlinkSync(dnsOverrideMarkerPath())
  } catch { /* already gone */ }
}

/** Apply DNS and kill switch settings after a successful VPN connection */
async function applyPostConnectSettings(protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2'): Promise<void> {
  // New interface/session — clear the speed baseline (finding M10).
  resetTrafficStats()
  killSwitchFailed = false
  killSwitchTeardownFailed = false

  const settings = loadSettings()

  // DNS handling differs by protocol:
  // - WireGuard: wg-quick already manages /etc/resolv.conf (sets the node's
  //   tunnel-routed DNS and restores the original on `wg-quick down`), and the
  //   kill switch allows DNS out the WG interface. We must NOT touch resolv.conf
  //   here — doing so would snapshot wg-quick's version and strand DNS on the node
  //   resolver after disconnect.
  // - V2Ray: tun2socks does no DNS setup, so we point the resolver through the
  //   tunnel ourselves. Under the kill switch a 'system'/LAN resolver isn't
  //   tunnel-routed (the kill switch drops it), so force a public resolver.
  // xray and hysteria2 use the same tun2socks path as v2ray, so they need the same
  // tunnelled DNS resolver. (hysteria2 gets the dns-set here but NOT the in-config DoH
  // injection — that's v2ray-config-shaped only — so its DNS is plaintext-through-tunnel.)
  const v2rayDnsIp = (protocol === 'v2ray' || protocol === 'xray' || protocol === 'hysteria2')
    ? effectiveV2RayResolverIp(settings) : null

  // Apply DNS override (routes V2Ray DNS through the tunnel via /etc/resolv.conf)
  if (v2rayDnsIp) {
    // Mark BEFORE the override so even a partial/failed dns-set is covered by the
    // teardown gate (mirrors enableKillSwitch's mark-before-arm discipline).
    markDnsOverridden()
    try {
      await runPrivileged(['dns-set', v2rayDnsIp])
    } catch (err) {
      console.error('Failed to set DNS:', err)
    }
  }

  // Enable kill switch
  if (settings.killSwitch) {
    try {
      // AmneziaWG rides the WG branch throughout: same sntl0 iface, same
      // Endpoint= line in its config, and awg-quick owns resolv.conf like
      // wg-quick does (no dns-set — v2rayDnsIp above is already null for it).
      const isWgLike = protocol === 'wireguard' || protocol === 'amneziawg'
      const vpnIface = isWgLike ? 'sntl0' : 'sntl-tun'
      // Whitelist the *real* server endpoint so the tunnel can re-handshake
      // while the kill switch is engaged (was hardcoded to a useless 0.0.0.0
      // for WireGuard — see finding H2).
      const remoteHost = (isWgLike ? getWireGuardRemoteHost() : getV2RayRemoteHost()) || '0.0.0.0'
      const dnsIp = v2rayDnsIp ?? undefined
      await enableKillSwitch(vpnIface, remoteHost, dnsIp)
    } catch (err) {
      console.error('Failed to enable kill switch:', err)
      // Don't silently leave the user thinking they're protected — flag it so
      // the renderer can warn. The connection itself is intentionally not torn
      // down (a transient daemon hiccup shouldn't drop a working tunnel).
      killSwitchFailed = true
    }
  }
}

/** Revert DNS and kill switch on disconnect */
async function revertPostConnectSettings(): Promise<void> {
  killSwitchFailed = false

  // Tear down each thing ONLY when its marker says it may actually be installed —
  // NOT based on the current settings (the user may have toggled the kill switch /
  // DNS off mid-session via SETTINGS_SET, yet the iptables chain / resolv.conf
  // override installed at connect time is still live). The markers are set at
  // arm/override time and cleared after a confirmed teardown, so they reflect real
  // installed state, not the toggle — this is the same invariant healStrandedKillSwitch
  // relies on. Gating this way avoids a privileged no-op on a clean session, which on
  // the pkexec fallback path (AppImage/dev) is what triggered a spurious password
  // prompt on quit. Kill switch first, so DNS-restore traffic can flow. If the kill
  // switch WAS armed and its teardown fails, the DROP-all chain persists until the
  // next-launch self-heal — flag it so the renderer can warn the user (M6).
  if (isKillSwitchArmed()) {
    const teardownOk = await disableKillSwitch()
    killSwitchTeardownFailed = !teardownOk
  } else {
    killSwitchTeardownFailed = false
  }
  if (isDnsOverridden()) {
    try {
      await runPrivileged(['dns-restore'])
      clearDnsOverridden()
    } catch { /* best-effort — marker kept so a later teardown retries */ }
  }
}

/**
 * On startup, clear a kill-switch chain stranded by a crash/OOM mid-teardown (the
 * chain otherwise keeps dropping all traffic with the tunnel down — no internet
 * even after "disconnect"). Gated on the armed marker (so clean launches never
 * touch root / prompt) AND on no active connection (so we never strip the chain
 * while a tunnel legitimately persisted across a restart — getConnectionStatus is
 * true only for a live WG interface or running V2Ray child, not a stale tun).
 * revertPostConnectSettings is idempotent and clears the marker on success.
 */
export async function healStrandedKillSwitch(): Promise<void> {
  if (isKillSwitchArmed() && !getConnectionStatus().connected) {
    await revertPostConnectSettings()
  }
}

/**
 * Snapshot the active session's usage (on-chain baseline + live interface bytes)
 * before the interface is torn down, so WALLET_SESSIONS keeps showing it while
 * the chain catches up. Must run while the tunnel is still up.
 */
function rememberSessionUsage(): void {
  if (!activeSessionId) return
  const live = getTrafficStats()
  const baseline = (lastKnownSessions as { id: string; downloadBytes?: string; uploadBytes?: string }[])
    .find((s) => s?.id === activeSessionId)
  const baseDown = parseInt(baseline?.downloadBytes || '0', 10) || 0
  const baseUp = parseInt(baseline?.uploadBytes || '0', 10) || 0
  lastSessionUsage.set(activeSessionId, {
    downloadBytes: String(baseDown + live.rxBytes),
    uploadBytes: String(baseUp + live.txBytes),
  })
}

/**
 * Tear down the active tunnel and revert DNS/kill-switch. Exported so the tray
 * can disconnect via the same path as the IPC handler (single source of truth
 * for the state cleanup). Broadcasts 'idle', which also refreshes the tray.
 */
export async function performDisconnect(): Promise<void> {
  // Signal intent synchronously — before acquiring the lock — so an in-flight
  // reconnect bails at its next epoch check even while a connect still holds the lock.
  isIntentionalDisconnect = true
  connectionEpoch++
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0

  return withConnectionLock(async () => {
    rememberSessionUsage()

    stopWireGuardMonitor()
    await revertPostConnectSettings()
    await disconnect()
    activeV2ray = null
    activeWg = null
    activeXrayConfig = null
    activeHysteria2Config = null
    activeAmneziaWgConfig = null
    desiredProtocol = null
    desiredMode = 'tunnel'
    activeSessionId = null
    activeNodeInfo = null
    isIntentionalDisconnect = false
    sendStateChange('idle')
  })
}

/**
 * Tear the tunnel down and return to idle. `broadcast` controls whether we emit
 * 'idle' — the give-up / no-config paths do (nothing else told the renderer),
 * but the epoch-drift path does NOT, because the performDisconnect that bumped
 * the epoch already broadcast idle. Don't strand the user behind a DROP-all kill
 * switch / overridden DNS; revert is idempotent.
 */
async function teardownToIdle(broadcast: boolean): Promise<void> {
  reconnectAttempt = 0
  await revertPostConnectSettings()
  await disconnect()
  stopWireGuardMonitor()
  desiredProtocol = null
  if (broadcast) sendStateChange('idle')
}

/**
 * Attempt auto-reconnection using saved session config. The retry/give-up/abort
 * decision is the pure decideReconnect; the timer body is guarded by connectionEpoch
 * so a disconnect during the backoff delay OR mid-bring-up can never leave a tunnel
 * up after the user disconnected (finding H4).
 */
async function attemptReconnect(): Promise<void> {
  const decision = decideReconnect({
    attempt: reconnectAttempt,
    maxAttempts: RECONNECT_MAX_ATTEMPTS,
    autoReconnect: loadSettings().autoReconnect,
    intentional: isIntentionalDisconnect,
    hasSession: !!activeSessionId,
  })

  if (decision.action === 'abort') return
  if (decision.action === 'give-up') {
    console.log('[reconnect] Max attempts reached, giving up')
    await teardownToIdle(true)
    return
  }

  reconnectAttempt = decision.attempt
  const myEpoch = connectionEpoch
  console.log(`[reconnect] Attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${decision.delayMs}ms`)
  sendReconnecting(reconnectAttempt, RECONNECT_MAX_ATTEMPTS)

  // Clear any prior timer before scheduling (guards against a double-schedule from
  // overlapping triggers, e.g. the WG monitor and the v2ray exit callback).
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    // Take the connection lock so the reconnect can't race a user connect/disconnect (M1).
    void withConnectionLock(async () => {
      // Disconnected (or a newer lifecycle began) while queued for the lock or during
      // the backoff delay.
      if (connectionEpoch !== myEpoch) return
      try {
        const savedSessionId = activeSessionId
        if (!savedSessionId) return

        const saved = loadSessionConfig(savedSessionId)
        if (!saved) {
          console.log('[reconnect] No saved config, cannot reconnect')
          await teardownToIdle(true)
          return
        }

        // Re-establish the tunnel
        if (saved.protocol === 'wireguard') {
          await connectWireGuardFromConfig(saved.configString)
        } else if (saved.protocol === 'amneziawg') {
          await connectAmneziaWgFromConfig(saved.configString)
        } else {
          // v2ray, xray and hysteria2 share the child-process + tun2socks bring-up.
          // Replay the mode the user connected with — a proxy-mode session must
          // not silently come back as a full tunnel (that would take root).
          const proxyOnly = desiredMode === 'proxy'
          if (saved.protocol === 'hysteria2') {
            connectHysteria2FromConfig(saved.configString, { proxyOnly }) // no DoH (see connectHysteria2FromConfig)
          } else {
            const dohIp = effectiveV2RayResolverIp(loadSettings())
            if (saved.protocol === 'xray') {
              connectXRayFromConfig(saved.configString, dohIp, { proxyOnly })
            } else {
              connectV2RayFromConfig(saved.configString, dohIp, { proxyOnly })
            }
          }
          await new Promise((r) => setTimeout(r, 1500))
          const status = getConnectionStatus()
          if (!status.connected) {
            throw new Error('Proxy failed to start on reconnect')
          }
          if (!proxyOnly) await bringUpV2RayTunnel()
        }

        // The user disconnected while we were bringing the tunnel up — undo it and
        // stay silent (performDisconnect already broadcast idle). Never resurrect a
        // tunnel the user explicitly tore down.
        if (connectionEpoch !== myEpoch) {
          await teardownToIdle(false)
          return
        }

        // Apply post-connect settings (proxy mode touches no system state — see
        // the CONNECTION_CONNECT branches)
        if (desiredMode !== 'proxy') {
          await applyPostConnectSettings(saved.protocol as 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2')
        }

        desiredProtocol = saved.protocol as 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2'
        if (desiredProtocol === 'wireguard' || desiredProtocol === 'amneziawg') startWireGuardMonitor()

        console.log('[reconnect] Success')
        reconnectAttempt = 0
        sendStateChange('connected')
      } catch (err) {
        console.error('[reconnect] Failed:', err)
        attemptReconnect()
      }
    })
  }, decision.delayMs)
}

async function fetchNodes(): Promise<unknown[]> {
  const response = await net.fetch(NODES_API, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Node API returned ${response.status}`)
  const json = await response.json() as { success: boolean; data: unknown[] }
  if (!json.success || !Array.isArray(json.data)) {
    throw new Error('Invalid response from node API')
  }
  // Cache node metadata for session enrichment
  cachedNodes = (json.data as { address?: string; moniker?: string; country?: string }[])
    .filter((n) => n.address)
    .map((n) => ({ address: n.address!, moniker: n.moniker || '', country: n.country || '' }))
  // Update shared cache: in-memory, disk, and broadcast to all renderer windows
  nodesMemoryCache = { nodes: json.data, fetchedAt: Date.now() }
  saveNodesCache(json.data)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.NODES_UPDATE, json.data)
  }
  return json.data
}

/**
 * Seed the in-memory node cache from disk at app startup so the first IPC call
 * (and session enrichment via getNodeMeta) has data immediately, without waiting
 * for the network. Safe to call before the first BrowserWindow exists.
 */
export function bootstrapNodesCache(): void {
  const disk = loadNodesCache()
  if (!disk) return
  nodesMemoryCache = disk
  cachedNodes = (disk.nodes as { address?: string; moniker?: string; country?: string }[])
    .filter((n) => n.address)
    .map((n) => ({ address: n.address!, moniker: n.moniker || '', country: n.country || '' }))
}

/**
 * Start the background refresh loop. Fires immediately, then every 60s.
 * Failures are silent — renderers keep seeing the last good cache.
 */
export function startNodeRefreshTimer(): void {
  if (nodeRefreshTimer) return
  const tick = () => { fetchNodes().catch(() => { /* silent */ }) }
  tick()
  nodeRefreshTimer = setInterval(tick, 60_000)
}

export function stopNodeRefreshTimer(): void {
  if (nodeRefreshTimer) {
    clearInterval(nodeRefreshTimer)
    nodeRefreshTimer = null
  }
}

async function fetchPublicRpcs(): Promise<PublicRpcEntry[]> {
  if (publicRpcCache && Date.now() - publicRpcCache.fetchedAt < PUBLIC_RPC_TTL_MS) {
    return publicRpcCache.list
  }
  const response = await net.fetch(PUBLIC_RPC_API, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Public RPC API returned ${response.status}`)
  const json = await response.json() as { success: boolean; data?: { publicRPC?: PublicRpcEntry[] } }
  if (!json.success || !Array.isArray(json.data?.publicRPC)) {
    throw new Error('Invalid response from public RPC API')
  }
  publicRpcCache = { list: json.data!.publicRPC!, fetchedAt: Date.now() }
  return publicRpcCache.list
}

function getNodeMeta(nodeAddress: string): { moniker: string; country: string } {
  // First check saved session config
  // Then fall back to cached node list from API
  const node = cachedNodes.find((n) => n.address === nodeAddress)
  return { moniker: node?.moniker || '', country: node?.country || '' }
}

// --- IPC input validation helpers ---

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`)
  }
}

function assertNumber(value: unknown, name: string, min?: number, max?: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: expected number`)
  }
  if (min !== undefined && value < min) throw new Error(`Invalid ${name}: must be >= ${min}`)
  if (max !== undefined && value > max) throw new Error(`Invalid ${name}: must be <= ${max}`)
}

function assertSentAddress(value: unknown, name: string): asserts value is string {
  assertString(value, name)
  if (!/^sent(node|prov)?1[a-z0-9]{38,}$/.test(value as string)) {
    throw new Error(`Invalid ${name}: not a valid wallet address`)
  }
}

function assertIntRange(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: expected integer`)
  }
  if (value < min || value > max) {
    throw new Error(`Invalid ${name}: must be between ${min} and ${max}`)
  }
}

/** Only accept IPC from our own renderer frame (dev server origin or file://). */
function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url || event.sender.getURL() || ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return url.startsWith(process.env['ELECTRON_RENDERER_URL'])
  }
  return url.startsWith('file://')
}

/**
 * ipcMain.handle wrapper that rejects calls from any frame that isn't our own
 * renderer — defense-in-depth so a single renderer-side compromise (or a future
 * sub-frame) can't reach these privileged handlers (finding M2).
 */
function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error(`Rejected IPC ${channel} from untrusted sender`)
    }
    return listener(event, ...args)
  })
}

export function registerIpcHandlers(): void {
  // Wallet
  handle(IPC.WALLET_HAS_STORED, async () => {
    return hasStoredWallet()
  })

  handle(IPC.WALLET_GENERATE, async (_event, wordCount: 12 | 24) => {
    if (wordCount !== 12 && wordCount !== 24) throw new Error('Word count must be 12 or 24')
    return generateMnemonicPhrase(wordCount)
  })

  handle(IPC.WALLET_IMPORT, async (_event, mnemonic: string, name?: string) => {
    assertString(mnemonic, 'mnemonic')
    const words = mnemonic.trim().split(/\s+/)
    if (words.length !== 12 && words.length !== 24) {
      throw new Error('Mnemonic must be 12 or 24 words')
    }
    let cleanName: string | undefined
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string') throw new Error('Invalid name')
      const trimmed = name.trim()
      if (trimmed.length > 100) throw new Error('Wallet name too long')
      cleanName = trimmed || undefined
    }
    const address = await importWallet(mnemonic, cleanName)
    return { address }
  })

  handle(IPC.WALLET_GET_ADDRESS, async () => {
    const stored = hasStoredWallet()
    if (stored && !getAddress()) {
      await restoreWallet()
    }
    return getAddress()
  })

  handle(IPC.WALLET_GET_BALANCE, async () => {
    // Skip RPC calls when VPN tunnel is active — traffic routes through
    // the node and RPC endpoints may be unreachable
    if (isVpnActive()) return lastKnownBalance
    try {
      const balance = await getBalance()
      lastKnownBalance = balance
      return balance
    } catch {
      return lastKnownBalance
    }
  })

  handle(IPC.WALLET_LOGOUT, async () => {
    logout()
  })

  handle(IPC.WALLET_SESSIONS, async () => {
    if (isVpnActive()) return lastKnownSessions
    // On app startup this can run before the wallet is restored (it races the
    // first walletGetAddress); restore it here too so sessions auto-load instead
    // of returning [] until a manual Refresh.
    if (hasStoredWallet() && !getAddress()) await restoreWallet()
    try {
      // Ensure node cache is populated for enrichment
      if (cachedNodes.length === 0) {
        try { await fetchNodes() } catch { /* best-effort */ }
      }
      const sessions = await getActiveSessions()
      // Enrich sessions with node metadata from saved configs or node cache, and
      // bridge the post-disconnect gap: show max(onChain, last-measured) so usage
      // doesn't collapse to ~0 while the chain settles (see lastSessionUsage).
      const enriched = sessions.map((s) => {
        const saved = loadSessionConfig(s.id)
        const nodeMeta = getNodeMeta(s.nodeAddress)
        const remembered = lastSessionUsage.get(s.id)
        return {
          ...s,
          downloadBytes: remembered ? maxUsageBytes(s.downloadBytes, remembered.downloadBytes) : s.downloadBytes,
          uploadBytes: remembered ? maxUsageBytes(s.uploadBytes, remembered.uploadBytes) : s.uploadBytes,
          nodeMoniker: saved?.nodeMoniker || nodeMeta.moniker,
          nodeCountry: saved?.nodeCountry || nodeMeta.country,
        }
      })
      lastKnownSessions = enriched
      return enriched
    } catch {
      return lastKnownSessions
    }
  })

  handle(IPC.WALLET_END_SESSION, async (_event, sessionId: string) => {
    assertString(sessionId, 'sessionId')
    if (!/^\d+$/.test(sessionId)) throw new Error('Invalid session ID')
    const wallet = getWallet()
    const address = getAddress()
    if (!wallet || !address) {
      throw new Error('Wallet not loaded.')
    }
    // Ending a session needs the chain, which is unreachable while our own tunnel is
    // up (traffic routes to the node) — fail fast instead of hanging (finding M2).
    if (isVpnActive()) {
      throw new Error('Disconnect the VPN before ending a session — the chain is unreachable through the tunnel.')
    }
    await endSession({ wallet, address, sessionId })
  })

  handle(IPC.WALLET_LIST, async () => {
    return listWallets()
  })

  handle(IPC.WALLET_SWITCH, async (_event, walletId: string) => {
    assertString(walletId, 'walletId')
    const address = await switchWallet(walletId)
    return { address }
  })

  handle(IPC.WALLET_DELETE, async (_event, walletId: string) => {
    assertString(walletId, 'walletId')
    deleteWalletEntry(walletId)
  })

  handle(IPC.WALLET_RENAME, async (_event, walletId: string, newName: string) => {
    assertString(walletId, 'walletId')
    assertString(newName, 'newName')
    if (newName.length > 100) throw new Error('Wallet name too long')
    renameWallet(walletId, newName)
  })

  handle(IPC.WALLET_DERIVE_SUBACCOUNT, async (_event, params: {
    sourceWalletId: string
    accountIndex: number
    name: string
  }) => {
    assertString(params.sourceWalletId, 'sourceWalletId')
    assertIntRange(params.accountIndex, 'accountIndex', 0, 2147483647)
    assertString(params.name, 'name')
    if (params.name.length > 100) throw new Error('Wallet name too long')
    const address = await deriveSubaccount(params.sourceWalletId, params.accountIndex, params.name)
    return { address }
  })

  // Settings
  handle(IPC.SETTINGS_GET, async () => {
    return loadSettings()
  })

  handle(IPC.SETTINGS_SET, async (_event, settings: Record<string, unknown>) => {
    if (typeof settings !== 'object' || settings === null) throw new Error('Invalid settings')
    // Only allow known setting keys
    const allowed = new Set([
      'rpcEndpoint', 'activeWalletId', 'killSwitch', 'dnsResolver', 'autoReconnect',
      'bookmarkedNodes', 'splitTunnelRoutes',
    ])
    const filtered: Record<string, unknown> = {}
    for (const key of Object.keys(settings)) {
      if (allowed.has(key)) filtered[key] = settings[key]
    }
    if (filtered.rpcEndpoint !== undefined) {
      assertString(filtered.rpcEndpoint, 'rpcEndpoint')
      try { new URL(filtered.rpcEndpoint as string) } catch { throw new Error('Invalid RPC endpoint URL') }
    }
    if (filtered.activeWalletId !== undefined && filtered.activeWalletId !== null) {
      assertString(filtered.activeWalletId, 'activeWalletId')
    }
    if (filtered.killSwitch !== undefined && typeof filtered.killSwitch !== 'boolean') {
      throw new Error('Invalid killSwitch: expected boolean')
    }
    if (filtered.dnsResolver !== undefined) {
      assertString(filtered.dnsResolver, 'dnsResolver')
      const dns = filtered.dnsResolver as string
      if (dns !== 'system' && !isAllowedDnsResolver(dns)) {
        throw new Error('Invalid DNS resolver')
      }
    }
    if (filtered.autoReconnect !== undefined && typeof filtered.autoReconnect !== 'boolean') {
      throw new Error('Invalid autoReconnect: expected boolean')
    }
    if (filtered.bookmarkedNodes !== undefined) {
      if (!Array.isArray(filtered.bookmarkedNodes)) throw new Error('Invalid bookmarkedNodes: expected array')
    }
    if (filtered.splitTunnelRoutes !== undefined) {
      if (!Array.isArray(filtered.splitTunnelRoutes)) throw new Error('Invalid splitTunnelRoutes: expected array')
      if (filtered.splitTunnelRoutes.length > 64) throw new Error('Too many split-tunnel routes (max 64)')
      for (const route of filtered.splitTunnelRoutes as unknown[]) {
        // Reject 0.0.0.0/x and /0 (would swallow the default route) and
        // out-of-range octets/prefixes — see finding H3.
        if (typeof route !== 'string' || !isAllowedBypassCidr(route)) {
          throw new Error(`Invalid CIDR route: ${String(route)}`)
        }
      }
    }
    return saveSettings(filtered as Parameters<typeof saveSettings>[0])
  })

  // Nodes
  handle(IPC.NODES_FETCH, async () => {
    return fetchNodes()
  })

  handle(IPC.NODES_GET_CACHED, async () => {
    return nodesMemoryCache
  })

  handle(IPC.RPC_LIST, async () => {
    return fetchPublicRpcs()
  })

  // Connection: Subscribe
  handle(IPC.CONNECTION_SUBSCRIBE, async (_event, params: {
    nodeAddress: string
    nodeMoniker: string
    nodeCountry: string
    nodeType: number
    apiField: string
    type: 'gigabytes' | 'hours'
    amount: number
    denom: string
    quoteValue: string
  }) => {
    assertSentAddress(params.nodeAddress, 'nodeAddress')
    assertString(params.nodeMoniker, 'nodeMoniker')
    assertString(params.nodeCountry, 'nodeCountry')
    if (params.nodeType !== 1 && params.nodeType !== 2 && params.nodeType !== 4 && params.nodeType !== 5 && params.nodeType !== 6) throw new Error('Unsupported nodeType: only WireGuard (1), V2Ray (2), XRAY (4), AmneziaWG (5) and Hysteria2 (6) are connectable')
    assertString(params.apiField, 'apiField')
    if (params.type !== 'gigabytes' && params.type !== 'hours') throw new Error('Invalid type')
    assertNumber(params.amount, 'amount', 1, 1000)
    assertString(params.denom, 'denom')
    assertString(params.quoteValue, 'quoteValue')
    if (!/^\d+$/.test(params.quoteValue)) throw new Error('Invalid quoteValue')

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) {
      throw new Error('Wallet not loaded. Please re-import your mnemonic.')
    }

    // Verify the node + our runtime BEFORE spending anything (see preflightConnect).
    await preflightConnect(params.nodeType, params.apiField)

    // Pre-check balance (only for udvpn denom)
    if (params.denom === 'udvpn') {
      const balances = await getBalance()
      const udvpn = balances.find((b) => b.denom === 'udvpn')
      const available = udvpn ? parseInt(udvpn.amount, 10) : 0
      const cost = parseInt(params.quoteValue, 10) * params.amount
      if (available < cost + 50000) {
        const needed = ((cost + 50000) / 1e6).toFixed(2)
        const have = (available / 1e6).toFixed(2)
        throw new Error(`Insufficient balance. Need ~${needed} DVPN (cost + gas), have ${have} DVPN.`)
      }
    }

    // Subscribe on-chain
    const sessionId = await subscribeToNode({
      wallet,
      address,
      nodeAddress: params.nodeAddress,
      type: params.type,
      amount: params.amount,
      denom: params.denom,
    })

    // Resolve the node endpoint + handshake. On ANY failure the just-created
    // session is auto-cancelled (refund) instead of orphaning the deposit (H1).
    const result = await establishSessionOrRefund({
      sessionId,
      nodeAddress: params.nodeAddress,
      nodeType: params.nodeType,
      apiField: params.apiField,
      nodeMoniker: params.nodeMoniker,
      nodeCountry: params.nodeCountry,
      wallet,
      address,
      privKey,
      isDeposit: true,
    })

    applySession(sessionId, params.nodeAddress, params.nodeMoniker, params.nodeCountry, params.nodeType, result)

    // Pre-cache sessions now (RPC is still reachable before tunnel goes up)
    try {
      const sessions = await getActiveSessions()
      lastKnownSessions = sessions.map((s) => {
        const saved = loadSessionConfig(s.id)
        const nodeMeta = getNodeMeta(s.nodeAddress)
        return { ...s, nodeMoniker: saved?.nodeMoniker || nodeMeta.moniker, nodeCountry: saved?.nodeCountry || nodeMeta.country }
      })
    } catch { /* best-effort */ }

    return {
      sessionId,
      protocol: result.protocol,
      configString: result.configString,
    }
  })

  // Connection: Reconnect to existing session using saved config
  handle(IPC.CONNECTION_RECONNECT, async (_event, params: {
    sessionId: string
  }) => {
    assertString(params.sessionId, 'sessionId')
    if (!/^\d+$/.test(params.sessionId)) throw new Error('Invalid session ID')
    const saved = loadSessionConfig(params.sessionId)
    if (!saved) {
      throw new Error(
        'No saved config for this session. The handshake config was not preserved — ' +
        'this session cannot be reconnected. You will need to create a new subscription.'
      )
    }

    activeSessionId = saved.sessionId
    // Populate node info from saved config; fall back to cached node list
    const nodeMeta = getNodeMeta(saved.nodeAddress)
    activeNodeInfo = {
      address: saved.nodeAddress,
      moniker: saved.nodeMoniker || nodeMeta.moniker || '',
      country: saved.nodeCountry || nodeMeta.country || '',
      type: saved.protocol === 'wireguard' ? 1 : saved.protocol === 'xray' ? 4 : saved.protocol === 'hysteria2' ? 6 : saved.protocol === 'amneziawg' ? 5 : 2,
    }

    return {
      sessionId: saved.sessionId,
      protocol: saved.protocol,
      configString: saved.configString,
    }
  })

  // Network: public IP lookup with geolocation (see override below)

  // Connection: Check for other active VPNs
  handle(IPC.CONNECTION_CHECK_VPN, async () => {
    return detectOtherVpn()
  })

  // Connection: Connect (establish tunnel — from SDK instance or raw config)
  handle(IPC.CONNECTION_CONNECT, async (_event, params: {
    protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2'
    configString?: string
    dnsFallback?: boolean
    mode?: 'tunnel' | 'proxy'
  }) => {
    if (params.mode !== undefined && params.mode !== 'tunnel' && params.mode !== 'proxy') {
      throw new Error('Invalid mode: must be tunnel or proxy')
    }
    // Local-proxy mode = the child core's SOCKS5 listener only: no TUN, no root,
    // no routing change. WireGuard/AmneziaWG have no such listener — they ARE the
    // routing change — so the mode is meaningless (and unimplementable) for them.
    const proxyOnly = params.mode === 'proxy'
    if (proxyOnly && (params.protocol === 'wireguard' || params.protocol === 'amneziawg')) {
      throw new Error('Local-proxy mode is not available for WireGuard or AmneziaWG — they route the whole device.')
    }
    if (params.protocol !== 'wireguard' && params.protocol !== 'amneziawg' && params.protocol !== 'v2ray' && params.protocol !== 'xray' && params.protocol !== 'hysteria2') {
      throw new Error('Invalid protocol: must be wireguard, amneziawg, v2ray, xray or hysteria2')
    }
    if (params.configString !== undefined && typeof params.configString !== 'string') {
      throw new Error('Invalid configString')
    }
    // User-consented retry after a resolvconf-missing bring-up failure: drop the
    // tunnel's DNS= lines so wg-quick/awg-quick never touch resolvconf. Only the
    // root protocols provision DNS this way, and only an explicit user action
    // sets this — auto-reconnect never silently downgrades DNS.
    const dnsFallback = params.dnsFallback === true &&
      (params.protocol === 'wireguard' || params.protocol === 'amneziawg')
    // Serialize tunnel bring-up against disconnect/reconnect so overlapping ops
    // can't orphan a child process (finding M1).
    return withConnectionLock(async () => {
      if (params.protocol === 'wireguard') {
        if (dnsFallback) {
          // Same config, minus DNS. config-guard still validates it (DNS is an
          // optional key in the allow-list).
          const base = params.configString ?? activeWg?.buildConfigString()
          if (!base) throw new Error('No WireGuard instance or config available')
          await connectWireGuardFromConfig(stripDnsLines(base))
        } else if (activeWg) {
          await connectWireGuard(activeWg)
        } else if (params.configString) {
          await connectWireGuardFromConfig(params.configString)
        } else {
          throw new Error('No WireGuard instance or config available')
        }

        // Apply DNS and kill switch if enabled
        await applyPostConnectSettings('wireguard')

        desiredProtocol = 'wireguard'
        desiredMode = 'tunnel'
        startWireGuardMonitor()
        sendStateChange('connected')
        return { protocol: 'wireguard' }
      }

      if (params.protocol === 'amneziawg') {
        // The config is the one built during the handshake (activeAmneziaWgConfig)
        // or a saved config replayed by a manual reconnect.
        const awgConfig = params.configString ?? activeAmneziaWgConfig
        if (!awgConfig) {
          throw new Error('No AmneziaWG config available')
        }
        await connectAmneziaWgFromConfig(dnsFallback ? stripDnsLines(awgConfig) : awgConfig)

        await applyPostConnectSettings('amneziawg')

        desiredProtocol = 'amneziawg'
        desiredMode = 'tunnel'
        startWireGuardMonitor()
        sendStateChange('connected')
        return { protocol: 'amneziawg' }
      }

      if (params.protocol === 'v2ray') {
        // Resolve the DoH resolver up front so it's injected into the v2ray config
        // (same value applyPostConnectSettings uses for resolv.conf + kill switch).
        const dohIp = effectiveV2RayResolverIp(loadSettings())
        if (activeV2ray) {
          connectV2Ray(activeV2ray, dohIp, { proxyOnly })
        } else if (params.configString) {
          connectV2RayFromConfig(params.configString, dohIp, { proxyOnly })
        } else {
          throw new Error('No V2Ray instance or config available')
        }

        // Wait briefly and verify the v2ray process didn't crash on startup
        await new Promise((r) => setTimeout(r, 1500))
        const status = getConnectionStatus()
        if (!status.connected) {
          const errMsg = getV2RayError()
          // When replaying a saved config (reconnect), a failure to start usually
          // means the node changed its configuration (e.g. switched protocols) or
          // went offline since the config was saved — point the user at the fix.
          const fromSavedConfig = !activeV2ray && !!params.configString
          const hint = fromSavedConfig
            ? '\n\nThis node may have changed its configuration or gone offline since you last connected. Remove this session and subscribe again to pick a working node.'
            : ''
          throw new Error(
            'V2Ray process exited immediately after starting.' + hint +
            (errMsg ? `\n\nV2Ray error:\n${errMsg.slice(0, 500)}` : '\n\nNo error output captured.')
          )
        }

        // V2Ray is running — bring up the TUN interface. If this fails the child is
        // still running, so tear it down rather than orphan a SOCKS proxy (finding M4).
        // In local-proxy mode there is no TUN and no system state to change: the
        // kill switch and dns-set are deliberately skipped, so proxy mode leaks by
        // design (only apps pointed at the SOCKS address are tunneled) and the
        // kill-switch setting is intentionally ignored.
        if (!proxyOnly) {
          try {
            await bringUpV2RayTunnel()
          } catch (err) {
            await disconnect()
            throw err
          }

          // Apply DNS and kill switch if enabled
          await applyPostConnectSettings('v2ray')
        }

        desiredProtocol = 'v2ray'
        desiredMode = proxyOnly ? 'proxy' : 'tunnel'
        sendStateChange('connected')
        return { protocol: 'v2ray' }
      }

      if (params.protocol === 'xray') {
        // Xray reuses the v2ray tunnel path (child process + tun2socks). The config
        // is the one built during the handshake (activeXrayConfig), or a saved config
        // on manual reconnect (params.configString).
        const dohIp = effectiveV2RayResolverIp(loadSettings())
        const xrayConfig = params.configString ?? activeXrayConfig
        if (!xrayConfig) {
          throw new Error('No Xray config available')
        }
        connectXRayFromConfig(xrayConfig, dohIp, { proxyOnly })

        // Wait briefly and verify the xray process didn't crash on startup
        await new Promise((r) => setTimeout(r, 1500))
        const status = getConnectionStatus()
        if (!status.connected) {
          const errMsg = getV2RayError()
          const fromSavedConfig = !activeXrayConfig && !!params.configString
          const hint = fromSavedConfig
            ? '\n\nThis node may have changed its configuration or gone offline since you last connected. Remove this session and subscribe again to pick a working node.'
            : ''
          throw new Error(
            'Xray process exited immediately after starting.' + hint +
            (errMsg ? `\n\nXray error:\n${errMsg.slice(0, 500)}` : '\n\nNo error output captured.')
          )
        }

        // Xray is running — bring up the TUN interface (same tun2socks path as v2ray),
        // unless this is local-proxy mode (see the v2ray branch).
        if (!proxyOnly) {
          try {
            await bringUpV2RayTunnel()
          } catch (err) {
            await disconnect()
            throw err
          }

          await applyPostConnectSettings('xray')
        }

        desiredProtocol = 'xray'
        desiredMode = proxyOnly ? 'proxy' : 'tunnel'
        sendStateChange('connected')
        return { protocol: 'xray' }
      }

      if (params.protocol === 'hysteria2') {
        // Hysteria2 reuses the v2ray tunnel path (child process + tun2socks). The config
        // is the one built during the handshake (activeHysteria2Config), or a saved
        // config on manual reconnect (params.configString). No DoH — hysteria2's DNS is
        // plaintext-through-tunnel (see connectHysteria2FromConfig).
        const hysteria2Config = params.configString ?? activeHysteria2Config
        if (!hysteria2Config) {
          throw new Error('No Hysteria2 config available')
        }
        connectHysteria2FromConfig(hysteria2Config, { proxyOnly })

        // Wait briefly and verify the hysteria process didn't crash on startup
        await new Promise((r) => setTimeout(r, 1500))
        const status = getConnectionStatus()
        if (!status.connected) {
          const errMsg = getV2RayError()
          const fromSavedConfig = !activeHysteria2Config && !!params.configString
          const hint = fromSavedConfig
            ? '\n\nThis node may have changed its configuration or gone offline since you last connected. Remove this session and subscribe again to pick a working node.'
            : ''
          throw new Error(
            'Hysteria2 process exited immediately after starting.' + hint +
            (errMsg ? `\n\nHysteria2 error:\n${errMsg.slice(0, 500)}` : '\n\nNo error output captured.')
          )
        }

        // Hysteria2 is running — bring up the TUN interface (same tun2socks path as
        // v2ray), unless this is local-proxy mode (see the v2ray branch).
        if (!proxyOnly) {
          try {
            await bringUpV2RayTunnel()
          } catch (err) {
            await disconnect()
            throw err
          }

          await applyPostConnectSettings('hysteria2')
        }

        desiredProtocol = 'hysteria2'
        desiredMode = proxyOnly ? 'proxy' : 'tunnel'
        sendStateChange('connected')
        return { protocol: 'hysteria2' }
      }

      throw new Error('No active VPN instance')
    })
  })

  // Connection: Disconnect
  handle(IPC.CONNECTION_DISCONNECT, async () => {
    await performDisconnect()
  })

  // Connection: Status
  handle(IPC.CONNECTION_STATUS, async () => {
    const vpnStatus = getConnectionStatus()
    const state = reconnectAttempt > 0 ? 'reconnecting' : vpnStatus.connected ? 'connected' : 'idle'
    return {
      state,
      nodeAddress: activeNodeInfo?.address,
      nodeMoniker: activeNodeInfo?.moniker,
      nodeCountry: activeNodeInfo?.country,
      nodeType: activeNodeInfo?.type,
      v2raySummary: activeNodeInfo?.v2raySummary,
      killSwitchFailed: killSwitchFailed || undefined,
      killSwitchTeardownFailed: killSwitchTeardownFailed || undefined,
      sessionId: activeSessionId,
      proxyMode: vpnStatus.proxyMode || undefined,
      socksAddr: vpnStatus.socksAddr,
      reconnectAttempt: reconnectAttempt > 0 ? reconnectAttempt : undefined,
      reconnectMaxAttempts: reconnectAttempt > 0 ? RECONNECT_MAX_ATTEMPTS : undefined,
    }
  })

  // Traffic Stats
  handle(IPC.TRAFFIC_STATS, async () => {
    return getTrafficStats()
  })

  // Bookmarks
  handle(IPC.BOOKMARK_TOGGLE, async (_event, nodeAddress: string) => {
    assertString(nodeAddress, 'nodeAddress')
    const settings = loadSettings()
    const bookmarks = settings.bookmarkedNodes || []
    const idx = bookmarks.indexOf(nodeAddress)
    if (idx >= 0) {
      bookmarks.splice(idx, 1)
    } else {
      bookmarks.push(nodeAddress)
    }
    saveSettings({ bookmarkedNodes: bookmarks })
    return bookmarks
  })

  handle(IPC.BOOKMARK_LIST, async () => {
    const settings = loadSettings()
    return settings.bookmarkedNodes || []
  })

  // RPC health check
  handle(IPC.RPC_CHECK, async (_event, endpoint: string) => {
    assertString(endpoint, 'endpoint')
    try { new URL(endpoint) } catch { throw new Error('Invalid RPC endpoint URL') }
    const start = Date.now()
    const response = await net.fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(10000) })
    const latencyMs = Date.now() - start
    if (!response.ok) throw new Error(`RPC returned ${response.status}`)
    const json = await response.json() as { result?: { node_info?: { network?: string } } }
    const chainId = json?.result?.node_info?.network || 'unknown'
    return { latencyMs, chainId }
  })

  // Binary check — checks bundled binaries first, then system PATH
  handle(IPC.BINARY_CHECK, async () => {
    return {
      wireguard: binaryExists('wg-quick'),
      v2ray: isBinaryAvailable('v2ray'),
      tun2socks: isBinaryAvailable('tun2socks'),
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

  // Network: public IP lookup. includeGeo=true (default) hits ipapi.co for
  // country/city/ASN/org; includeGeo=false uses icanhazip.com only (no rate
  // limits) — intended for polled refreshes so we don't burn the 1000/day
  // free tier on ipapi.co.
  handle(IPC.NETWORK_GET_IP, async (_event, includeGeo?: boolean) => {
    const geo = includeGeo !== false
    if (geo) {
      try {
        const response = await net.fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error(`IP lookup failed: ${response.status}`)
        const json = await response.json() as {
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
        // fall through
      }
    }
    const response = await net.fetch('https://icanhazip.com', { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`IP lookup failed: ${response.status}`)
    const ip = (await response.text()).trim()
    return { ip, country: '', city: '', asn: '', org: '' }
  })

  // Plan Discovery
  handle(IPC.PLAN_DISCOVER, async (_event, maxCount: number) => {
    assertIntRange(maxCount, 'maxCount', 100, 1000)
    // A fresh on-chain rescan needs RPC, which is unreachable while our own
    // tunnel is up (traffic routes to the node). The renderer disables Rescan
    // when connected; this is the backstop — return cached plans instead of
    // throwing a raw error, matching how the other RPC handlers degrade.
    if (isVpnActive()) return listCachedPlans().plans
    return discoverPlans(maxCount)
  })

  handle(IPC.PLAN_LIST_CACHED, async () => {
    return listCachedPlans()
  })

  handle(IPC.PLAN_ALLOCATIONS, async () => {
    const address = getAddress()
    if (!address) return []
    if (isVpnActive()) return []
    try {
      return await queryPlanAllocations(address)
    } catch {
      return []
    }
  })

  handle(IPC.PLAN_SUBSCRIBE, async (_event, params: {
    planId: string
    denom: string
    nodeAddress: string
    nodeMoniker: string
    nodeCountry: string
    nodeType: number
    apiField: string
    renewalPolicy?: number
  }) => {
    assertString(params.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    assertString(params.denom, 'denom')
    if (params.renewalPolicy !== undefined) assertNumber(params.renewalPolicy, 'renewalPolicy', 0, 7)
    assertSentAddress(params.nodeAddress, 'nodeAddress')
    assertString(params.nodeMoniker, 'nodeMoniker')
    assertString(params.nodeCountry, 'nodeCountry')
    if (params.nodeType !== 1 && params.nodeType !== 2 && params.nodeType !== 4 && params.nodeType !== 5 && params.nodeType !== 6) throw new Error('Unsupported nodeType')
    assertString(params.apiField, 'apiField')

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) throw new Error('Wallet not loaded')

    await preflightConnect(params.nodeType, params.apiField)

    const { sessionId, subscriptionId } = await subscribeToPlan({
      wallet,
      address,
      planId: params.planId,
      denom: params.denom,
      nodeAddress: params.nodeAddress,
      renewalPricePolicy: params.renewalPolicy,
    })

    const result = await establishSessionOrRefund({
      sessionId,
      nodeAddress: params.nodeAddress,
      nodeType: params.nodeType,
      apiField: params.apiField,
      nodeMoniker: params.nodeMoniker,
      nodeCountry: params.nodeCountry,
      wallet,
      address,
      privKey,
      isDeposit: false,
    })

    applySession(sessionId, params.nodeAddress, params.nodeMoniker, params.nodeCountry, params.nodeType, result)

    return {
      sessionId,
      subscriptionId,
      protocol: result.protocol,
      configString: result.configString,
    }
  })

  handle(IPC.PLAN_START_SESSION_FROM_SUB, async (_event, params: {
    subscriptionId: string
    nodeAddress: string
    nodeMoniker: string
    nodeCountry: string
    nodeType: number
    apiField: string
  }) => {
    assertString(params.subscriptionId, 'subscriptionId')
    if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    assertSentAddress(params.nodeAddress, 'nodeAddress')
    assertString(params.nodeMoniker, 'nodeMoniker')
    assertString(params.nodeCountry, 'nodeCountry')
    if (params.nodeType !== 1 && params.nodeType !== 2 && params.nodeType !== 4 && params.nodeType !== 5 && params.nodeType !== 6) throw new Error('Unsupported nodeType')
    assertString(params.apiField, 'apiField')

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) throw new Error('Wallet not loaded')

    await preflightConnect(params.nodeType, params.apiField)

    const { sessionId, subscriptionId } = await startSessionWithExistingSubscription({
      wallet,
      address,
      subscriptionId: params.subscriptionId,
      nodeAddress: params.nodeAddress,
    })

    const result = await establishSessionOrRefund({
      sessionId,
      nodeAddress: params.nodeAddress,
      nodeType: params.nodeType,
      apiField: params.apiField,
      nodeMoniker: params.nodeMoniker,
      nodeCountry: params.nodeCountry,
      wallet,
      address,
      privKey,
      isDeposit: false,
    })

    applySession(sessionId, params.nodeAddress, params.nodeMoniker, params.nodeCountry, params.nodeType, result)

    return {
      sessionId,
      subscriptionId,
      protocol: result.protocol,
      configString: result.configString,
    }
  })

  handle(IPC.PLAN_NODES, async (_event, params: { planId: string }) => {
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    if (isVpnActive()) return []
    try {
      return await listNodesForPlan(params.planId)
    } catch {
      return []
    }
  })

  handle(IPC.PLAN_LIST_FOR_NODE, async (_event, params: { nodeAddress: string }) => {
    assertString(params?.nodeAddress, 'nodeAddress')
    if (isVpnActive()) return []
    try {
      return await listPlansForNode(params.nodeAddress)
    } catch {
      return []
    }
  })

  handle(IPC.SUBSCRIPTION_LIST, async () => {
    const address = getAddress()
    if (!address) throw new Error('Wallet not loaded')
    // RPC is unreachable through the tunnel; there's no cache for this list, so
    // the UI hides the section while connected rather than showing stale rows.
    if (isVpnActive()) return []
    return await querySubscriptions(address)
  })

  handle(IPC.SUBSCRIPTION_CANCEL, async (_event, params: { subscriptionId: string }) => {
    assertString(params?.subscriptionId, 'subscriptionId')
    if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    const wallet = getWallet()
    const address = getAddress()
    if (!wallet || !address) throw new Error('Wallet not loaded')
    await cancelSubscription({ wallet, address, subscriptionId: params.subscriptionId })
  })

  handle(IPC.SUBSCRIPTION_UPDATE_POLICY, async (_event, params: { subscriptionId: string; policy: number }) => {
    assertString(params?.subscriptionId, 'subscriptionId')
    if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    // RenewalPricePolicy enum range (0 UNSPECIFIED … 7 ALWAYS); the hub rejects
    // anything outside it, so don't waste a tx finding out.
    assertNumber(params.policy, 'policy', 0, 7)
    const wallet = getWallet()
    const address = getAddress()
    if (!wallet || !address) throw new Error('Wallet not loaded')
    await updateSubscriptionPolicy({ wallet, address, subscriptionId: params.subscriptionId, policy: params.policy })
  })

  handle(IPC.PROVIDER_GET, async (_event, params: { address: string }) => {
    assertString(params?.address, 'address')
    assertSentAddress(params.address, 'address')
    try {
      return await getProvider(params.address)
    } catch {
      const cached = getCachedProviders().providers
      return cached.find((p) => p.address === params.address) ?? null
    }
  })

  handle(IPC.PROVIDER_LIST, async () => {
    try {
      return await listProviders()
    } catch {
      return getCachedProviders().providers
    }
  })

  // Register V2Ray unexpected exit handler for auto-reconnect
  onV2RayUnexpectedExit(() => {
    if (!isIntentionalDisconnect && activeSessionId) {
      console.log('[vpn] V2Ray exited unexpectedly, attempting reconnect...')
      attemptReconnect()
    }
  })
}

export async function cleanupOnQuit(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopWireGuardMonitor()
  await revertPostConnectSettings()
  await disconnect()
}
