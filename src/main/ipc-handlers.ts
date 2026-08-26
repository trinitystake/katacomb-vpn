import { ipcMain, net, BrowserWindow, Notification, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '../shared/ipc-channels'
import { INSUFFICIENT_FUNDS, RPC_UNREACHABLE } from '../shared/error-markers'
import { checkFunds, insufficientFundsMessage, udvpnOf } from '../shared/funds'
import { isRpcConnectivityError, rpcHostLabel } from '../shared/rpc-health'
import { DERIVE_PREVIEW_MAX_COUNT } from '../shared/hd-path'
import {
  getRpcHealth,
  onRpcEndpointChanged,
  onChainPathChanged,
  probeFeedCandidates,
  reportRpcFailure,
  runAutoRpcSelection,
  runAutoRpcSelectionReport,
} from './rpc-monitor'
import { writeFileAtomic } from './fs-utils'
import {
  hasStoredWallet,
  generateMnemonicPhrase,
  importWallet,
  restoreWallet,
  switchWallet,
  deriveSubaccount,
  previewDerivations,
  getAddress,
  getBalance,
  getBalanceForAddress,
  getActiveSessions,
  getSessionsForAddress,
  getActiveWalletId,
  loadWalletCredentials,
  findTransferBetween,
  getWallet,
  getPrivKey,
  logout,
  type SessionInfo,
} from './wallet'
import { subscribeToNode, performHandshake, handshakeChainEntry, handshakeChainExit, finalizeChain, sendChainHopProgress, sendPlanProgress, chainHopRoleOf, resolveNodeRemoteUrl, loadSessionConfig, listSessionsOwnedByOtherWallets, endSession, V2RayPolicyError } from './chain-service'
import { openChainFlow } from './chain-clients'
import type { SentinelClient } from '@sentinel-official/sentinel-js-sdk'
import type https from 'node:https'
import { get as httpsGet } from 'node:https'
import { withTimeout } from './async-utils'
import { sessionFailureMessage, chainFailureMessage, refundEachInTurn, decideReconnect, evaluateQuota, serviceTypeToNodeType, stripDnsLines, replaceDnsLines, isTunnelOneWay, usageAccruesWithoutTunnelInterface, prunableUsageIds, describeNodeApiError, deadTunnelMessage, decideFirewallAction, shouldRetrySessionHandshake, HANDSHAKE_RETRY_DELAY_MS, REFUND_FAILED_TAIL, type QuotaVerdict } from './connect-decisions'
import { discoverPlans, listCachedPlans, listNodesForPlan, invalidatePlanNodes, listPlansForNode, subscribeToPlan, startSessionWithExistingSubscription, cancelSubscription, renewSubscription, updateSubscriptionPolicy, getPlanOverview, getCachedPlanNodes, TX_TIMEOUT_MESSAGE as PLAN_TX_TIMEOUT_MESSAGE, type PlanOverview } from './plan-service'
import { rankPlanCandidates, shouldTryNextCandidate, ladderNextTx, smartConnectFailureSummary, type PlanNodeCandidate, type SmartConnectFailure } from './plan-connect'
import {
  getMyProvider,
  getProviderDeposit,
  getNodeHourlyPrice,
  getPlanSubscriberStats,
  getProviderEconomics,
  listMyPlans,
  registerProvider,
  updateProviderDetails,
  setProviderStatus,
  createPlan,
  setPlanStatus,
  linkNode,
  unlinkNode,
  startLease,
  endLease,
} from './provider-console'
import { listLeasesForProvider, getLeaseParams } from './lease-query'
import { getTokenPrice } from './price-service'
import { assertValidLeaseHours, leaseDepositNumber, leaseDepositUdvpn, toProviderAddress } from './provider-msgs'
import { getProvider, listProviders } from './provider-service'
import { getCachedProviders } from './provider-cache'
import { getCachedPlans } from './plan-cache'
import { loadSettings, saveSettings, listWallets, deleteWalletEntry, renameWallet, canUnlockWallet, getWalletMnemonic, clearRetainedSeed, setWalletProviderMode, type AppSettings } from './settings'
import { loadNodesCache, saveNodesCache, type NodesCacheFile } from './nodes-cache'
import { normalizeNodes, parseNodesPage, type NodesPage } from './node-normalize'
import {
  connectV2Ray,
  connectWireGuard,
  connectWireGuardFromConfig,
  connectAmneziaWgFromConfig,
  connectOpenVpnFromConfig,
  connectV2RayFromConfig,
  connectXRayFromConfig,
  connectHysteria2FromConfig,
  disconnect,
  getConnectionStatus,
  isProxyChildAlive,
  waitForChildProxyListener,
  isVpnActive,
  detectOtherVpn,
  getV2RayError,
  bringUpV2RayTunnel,
  getV2RayRemoteHost,
  getWireGuardRemoteHost,
  getOpenVpnRemoteHost,
  isWireGuardUp,
  isOpenVpnUp,
  hasDefaultRouteChanged,
  startProvisioningProxy,
  PROVISION_SOCKS_PORT,
  type ProvisioningProxy,
  binaryExists,
  isBinaryAvailable,
  protocolRuntimeError,
  getActiveProxyPort,
} from './vpn-manager'
import { runPrivileged, canEscalatePrivileges } from './privileged'
import { isAllowedBypassCidr, isAllowedDnsResolver, isSafeNodeApiUrl } from './config-guard'
import { enableKillSwitch, disableKillSwitch, isKillSwitchArmed } from './kill-switch'
import { getTrafficStats, resetTrafficStats, maxUsageBytes, readTunnelBytes } from './traffic-stats'
import { probeNode, startBatch, cancelBatch, speedTest, getAllCachedResults, fetchNodeServiceType, fetchNodeServiceMetadata } from './node-tester'
import { classifyHopEligibility, buildEntryOnlyConfig, type HopMetadataEntry } from './multihop-config'
import { SocksHttpsAgent } from './socks-agent'
import { onV2RayUnexpectedExit, reapOrphanedProxyChildren } from './vpn-manager'
import type { Wireguard, V2Ray } from '@sentinel-official/sentinel-js-sdk'

const NODES_API = 'https://api.sentnodes.com/v2/nodes'
// Ceiling on the paginated node feed: 200 entries/page, ~10 pages for today's
// ~1,830 nodes. Bounds the fan-out if the aggregator ever reports a silly
// lastPage, at 5x room to grow.
const MAX_NODE_PAGES = 50
const RECONNECT_MAX_ATTEMPTS = 5
// Bound the refund (endSession) so a slow RPC during the failure path can't itself
// hang the connect flow — see establishSessionOrRefund (finding H1). Generous on
// purpose: one cancel is an RPC connect (up to RPC_CONNECT_TIMEOUT_MS on its own),
// a gas simulation, a broadcast and a wait for inclusion at ~3.6s per block, so the
// old 10s could expire on a cancel that was going to succeed — and this is the path
// that protects money the user has already spent. Refunds run sequentially, so a
// two-hop chain can spend up to twice this before giving up.
const REFUND_TIMEOUT_MS = 30_000
// Bound the pre-payment protocol check — it blocks the connect button.
const NODE_PROTOCOL_CHECK_TIMEOUT_MS = 10_000
// The same check for a chain's EXIT hop, which is asked THROUGH the entry: one more hop
// each way, and a timeout here strands an entry session that is already bought.
const NODE_CHECK_VIA_PROXY_TIMEOUT_MS = 25_000
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

/**
 * The resolver a WireGuard/AmneziaWG tunnel should use, or null to keep the node's.
 *
 * These protocols never take the `dns-set` path (wg-quick owns resolv.conf, and
 * overriding it here would strand DNS on the node resolver after disconnect), so
 * the chosen resolver has to reach the tunnel as a `DNS =` line in the config
 * instead. Until this existed the setting was silently ignored on the whole WG
 * family: the UI offered a resolver and the node's own list was used regardless.
 *
 * 'system' deliberately stays "whatever the node pushed" rather than borrowing
 * effectiveV2RayResolverIp's kill-switch fallback. The kill switch accepts
 * everything out the tunnel interface, so a node resolver is reachable under it
 * and needs no public substitute.
 */
function wireguardResolverIp(settings: AppSettings): string | null {
  return settings.dnsResolver === 'system' ? null : settings.dnsResolver
}

let activeWg: Wireguard | null = null
let activeV2ray: V2Ray | null = null
// Xray/Hysteria2 have no SDK instance (we build their configs ourselves), so we hold
// the built config string across the subscribe→connect handoff, like activeWg/activeV2ray.
let activeXrayConfig: string | null = null
let activeHysteria2Config: string | null = null
let activeAmneziaWgConfig: string | null = null
let activeOpenVpnConfig: string | null = null
let activeSessionId: string | null = null
let activeNodeInfo: { address: string; moniker: string; country: string; type: number; v2raySummary?: string } | null = null
// MULTIHOP: the chain's second (exit) session and node, when a two-hop chain is up.
// `activeSessionId`/`activeNodeInfo` deliberately stay the ENTRY hop, so every existing
// reader (status, reconnect, usage, extractV2RayRemoteHost's whitelist) keeps its
// current meaning — the entry is the hop this host actually dials. The chained config
// is saved under BOTH session ids, so a reconnect from either rebuilds the whole chain.
let activeExitSessionId: string | null = null
let activeExitNodeInfo: { address: string; moniker: string; country: string; type: number } | null = null
// Did the node mint a peer for the config we are about to build a tunnel from, or is
// that config a replayed saved one? Only deadTunnelMessage cares, and only when the
// tunnel turns out to carry nothing — at which point the answer is the difference
// between "retry, it may be local" and "this session is over" (see that function).
// Set by applySession (every fresh handshake goes through it) and cleared by the one
// path that replays a saved config. Optimistic default: mislabelling a live session
// dead is the worse error of the two.
let nodeIssuedFreshPeer = true
// True when the user enabled the kill switch but arming it failed — surfaced to
// the renderer so "protected" is never silently a lie.
let killSwitchFailed = false
// What the LIVE kill-switch chain was actually built with, recorded at arm time so
// a mid-session re-arm replays the same endpoint instead of re-deriving the
// protocol. Deliberately NOT cleared by standDownSession — that leaves the chain
// armed on purpose, and the user must still be able to toggle LAN sharing (or turn
// the kill switch off) in that state.
let armedWith: { iface: string; remoteHost: string; dnsIp?: string; lanSharing: boolean } | null = null
// True when a kill-switch TEARDOWN failed while it was armed — the DROP-all chain may
// still be blocking traffic until the next-launch self-heal. Surfaced so the renderer
// can warn even in the idle state (finding M6).
let killSwitchTeardownFailed = false
// True when this launch closed a tunnel left behind by a previous run (see
// healOrphanedTunnel). Set once at startup and never cleared in main: the banner it
// drives is dismissed in the renderer, and a per-launch fact has no reason to expire.
let orphanedTunnelClosed = false

// Cached values returned when VPN is active and RPC is unreachable. Balance stays
// null until a fetch actually succeeds: the renderer's affordability check must be
// able to tell "wallet is empty" from "we couldn't read the balance" — reading an
// unreachable RPC as 0 would grey out the pay buttons of a funded wallet.
let lastKnownBalance: { denom: string; amount: string }[] | null = null
let lastKnownSessions: unknown[] = []
interface CachedNodeMeta {
  address: string
  moniker: string
  country: string
  type: number
  /** '' when the aggregator has no usable API base for the node. */
  api: string
  isActive: boolean
  isHealthy: boolean
}
let cachedNodes: CachedNodeMeta[] = []

/** The one projection from aggregator rows to cachedNodes, shared by both feed points. */
function toCachedNodeMeta(nodes: unknown[]): CachedNodeMeta[] {
  return (nodes as { address?: string; moniker?: string; country?: string; type?: number; api?: string; isActive?: boolean; isHealthy?: boolean }[])
    .filter((n) => n.address)
    .map((n) => ({
      address: n.address!,
      moniker: n.moniker || '',
      country: n.country || '',
      type: n.type ?? 0,
      api: n.api || '',
      isActive: n.isActive === true,
      isHealthy: n.isHealthy === true,
    }))
}
// Last successful PLAN_OVERVIEW chain read, served with stale: true while the
// tunnel is up. Wallet-scoped, so WALLET_SWITCH clears it.
let lastPlanOverview: PlanOverview | null = null

/**
 * Everything a session row carries that the chain itself doesn't: the node's name,
 * and — for a multihop chain — which end this hop is and what its partner's id is.
 *
 * Every writer of `lastKnownSessions` reaches this through `primeSessionsCache`
 * below. WALLET_SESSIONS returns that cache verbatim while a tunnel is up, so a
 * writer that skips the chain fields makes the Sessions tab forget it is looking
 * at a chain for exactly as long as the chain is connected — it offers "End" on
 * one hop, which tears the tunnel down and leaves the other hop paid for.
 * Verified against a live chain (#55112370 -> #55112373) after the connect
 * handlers were missed the first time.
 */
function decorateSessionRow<T extends { id: string; nodeAddress: string }>(session: T): T & {
  nodeMoniker: string
  nodeCountry: string
  chainPeerSessionId?: string
  chainRole?: 'entry' | 'exit'
} {
  const saved = loadSessionConfig(session.id)
  const nodeMeta = getNodeMeta(session.nodeAddress)
  return {
    ...session,
    nodeMoniker: saved?.nodeMoniker || nodeMeta.moniker,
    nodeCountry: saved?.nodeCountry || nodeMeta.country,
    chainPeerSessionId: saved?.chainPeerSessionId,
    chainRole: saved?.chainRole,
  }
}

/**
 * THE writer of `lastKnownSessions`: decorate every row (see decorateSessionRow)
 * and floor its usage at the last live measurement (see lastSessionUsage), so a
 * fresh read can never march a gauge backwards while the chain settles. Feed it
 * `readAllSessions()` output, never `getActiveSessions()` — the exit hop of a
 * per-hop-wallet chain only exists in the former. Returns the enriched rows so
 * WALLET_SESSIONS can answer with exactly what it cached.
 */
function primeSessionsCache(sessions: SessionInfo[]) {
  const enriched = sessions.map((s) => {
    const remembered = lastSessionUsage.get(s.id)
    return {
      ...decorateSessionRow(s),
      downloadBytes: remembered ? maxUsageBytes(s.downloadBytes, remembered.downloadBytes) : s.downloadBytes,
      uploadBytes: remembered ? maxUsageBytes(s.uploadBytes, remembered.uploadBytes) : s.uploadBytes,
      durationSeconds: remembered
        ? Math.max(s.durationSeconds ?? 0, remembered.durationSeconds)
        : s.durationSeconds,
    }
  })
  lastKnownSessions = enriched
  return enriched
}

interface RememberedUsage {
  downloadBytes: string
  uploadBytes: string
  durationSeconds: number
}

// Per-session usage measured live during the last connect (on-chain baseline +
// interface bytes). After disconnect the on-chain counter lags, so WALLET_SESSIONS
// shows max(onChain, remembered) to keep the Session tab from collapsing to ~0
// until the chain settles.
//
// Persisted, because the lag outlives the process: quit the app after using a
// session and the next launch had nothing but the chain's not-yet-settled figure,
// which reads as the gauge resetting itself. It is only ever a FLOOR — the chain
// overtakes it and wins automatically (see maxUsageBytes), so a stale entry can
// never inflate usage past what was actually settled.
const lastSessionUsage = new Map<string, RememberedUsage>()

function usageStorePath(): string {
  return join(app.getPath('userData'), 'session-usage.json')
}

/** Load the remembered usage written by a previous run. Best-effort by design. */
function loadSessionUsage(): void {
  try {
    const raw = JSON.parse(readFileSync(usageStorePath(), 'utf-8')) as Record<string, RememberedUsage>
    for (const [id, u] of Object.entries(raw)) {
      if (typeof u?.durationSeconds === 'number' && typeof u.downloadBytes === 'string') {
        lastSessionUsage.set(id, u)
      }
    }
  } catch { /* absent or corrupt — the chain is still authoritative */ }
}

function saveSessionUsage(): void {
  try {
    writeFileAtomic(usageStorePath(), JSON.stringify(Object.fromEntries(lastSessionUsage), null, 2))
  } catch { /* best-effort — losing this only costs display accuracy */ }
}

// Shared in-memory cache for the full node list. Seeded from disk on startup,
// refreshed on a 60s timer in main, broadcast to all renderer windows on update.
let nodesMemoryCache: NodesCacheFile | null = null
let nodeRefreshTimer: ReturnType<typeof setInterval> | null = null

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
let desiredProtocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn' | null = null
// Tunnel vs. local-proxy for the current session — a runtime choice, so it is
// deliberately NOT persisted in SavedSessionConfig (a session-tab reconnect is
// always full-tunnel). Auto-reconnect replays whatever the user picked.
let desiredMode: 'tunnel' | 'proxy' = 'tunnel'
let wgMonitorTimer: ReturnType<typeof setInterval> | null = null

/**
 * Root-tunnel liveness. WireGuard, AmneziaWG and OpenVPN all bring their tunnel up
 * through the privileged helper, so there is no child process to watch (the
 * child-proxy protocols use onV2RayUnexpectedExit instead) — poll the interface.
 * AmneziaWG shares WireGuard's sntl0; OpenVPN has its own sntl-ovpn.
 */
function isRootTunnelProtocol(p: typeof desiredProtocol): boolean {
  return p === 'wireguard' || p === 'amneziawg' || p === 'openvpn'
}

/**
 * Tunnel liveness, on one timer for every protocol. Two different things are watched,
 * because the two families fail differently:
 *
 *  - root protocols (wg/awg/openvpn): the interface itself can vanish, and there is no
 *    child process to notice it for us.
 *  - child-proxy protocols (v2ray/xray/hysteria2, so every multihop chain): the process
 *    stays alive and the TUN stays up, but tun2socks' bypass route to the node is
 *    pinned to the gateway and interface that existed at bring-up. Switch from Wi-Fi to
 *    wired, or resume onto a different network, and that route points at a gateway that
 *    is no longer there: traffic dies inside the tunnel with nothing reporting it. The
 *    only thing that used to catch it was checkTunnelStalled, 64 KB and 90 s later, and
 *    only if the user kept generating traffic. Nothing leaks (the packets die in the
 *    TUN), but the UI says "connected" for up to two minutes.
 *
 * Proxy mode is excluded: it changes no routing, so the default route means nothing
 * to it.
 */
function startRootTunnelMonitor(): void {
  if (wgMonitorTimer) return
  wgMonitorTimer = setInterval(() => {
    if (isIntentionalDisconnect || reconnectAttempt > 0) return
    if (!activeSessionId) return
    if (isRootTunnelProtocol(desiredProtocol)) {
      const up = desiredProtocol === 'openvpn' ? isOpenVpnUp() : isWireGuardUp()
      if (!up) {
        console.log(`[vpn] ${desiredProtocol} interface dropped, attempting reconnect...`)
        attemptReconnect()
      }
      return
    }
    if (desiredProtocol !== null && desiredMode === 'tunnel' && hasDefaultRouteChanged()) {
      console.log('[vpn] default route changed under the tunnel, attempting reconnect...')
      attemptReconnect()
    }
  }, 5000)
}

function stopRootTunnelMonitor(): void {
  if (wgMonitorTimer) {
    clearInterval(wgMonitorTimer)
    wgMonitorTimer = null
  }
}

// The paid quota of the session we're connected to. Nothing else in the app tracks
// it: the liveness monitor above watches whether the INTERFACE exists, and a node
// whose quota is exhausted stops forwarding while the interface stays up — so
// without this the tunnel sits there dead and the Sessions tab extrapolates a time
// bar past 100% off a snapshot taken before the connect.
interface ActiveQuota {
  // Pinned to the session it was read for, so a stale quota can never be applied
  // to the next one.
  sessionId: string
  maxDurationSeconds: number | null
  // What the chain had already metered when we captured it. Time and bytes are
  // BOTH baseline-plus-live — see evaluateQuota for why time must not be wall-clock.
  baselineDurationSeconds: number
  maxBytes: number
  baselineBytes: number
}
let activeQuota: ActiveQuota | null = null
// MULTIHOP: the exit hop's quota. Both hops carry the SAME byte stream and the same
// wall-clock — one stream crosses both nodes — so both are scored against the same
// live counters, which is exact rather than conservative. Whichever runs out first
// stands the chain down (see currentQuotaVerdict).
let activeExitQuota: ActiveQuota | null = null
let quotaWarned = false
let quotaTimer: ReturnType<typeof setInterval> | null = null
// When the CURRENT tunnel came up. The quota watchdog measures elapsed session time
// as "what the chain metered before this connect + how long we've been up", so this
// is the second half of that sum. Deliberately not reset per auto-reconnect attempt:
// an outage is bounded to about a minute by the backoff ladder, which is noise at
// hour/GB granularity and not worth a second accumulator.
let connectedAtMs: number | null = null
// Why the last session ended, kept after teardown so the renderer can explain the
// disconnect (and offer Restore when the kill switch is still blocking). Cleared by
// the next connect and by performDisconnect. 'stalled' is not an expiry — the session
// is usually still live on chain — so the banner words it differently and points at
// reconnecting rather than re-buying.
let lastExpiry: {
  sessionId: string
  nodeMoniker: string
  reason: 'time' | 'data' | 'stalled' | 'dropped'
  trafficBlocked: boolean
  /** MULTIHOP: which end of the chain ran out. Absent for an ordinary session. */
  chainRole?: 'entry' | 'exit'
} | null = null

// Quota is coarse — the 5s interface poll is not a useful cadence for it.
const QUOTA_POLL_MS = 15_000
// A reconnect that exhausted its attempts this close to the cap didn't fail, it ran
// out: the node cut the tunnel slightly before our own estimate said it would.
const QUOTA_GIVE_UP_PCT = 95

/** Read the quota off a chain session row, or null when it carries no cap at all. */
function quotaFromSessionRow(row: SessionInfo): ActiveQuota | null {
  const maxBytes = parseInt(row.maxBytes, 10) || 0
  const hasTimeCap = row.maxDurationSeconds !== null && row.maxDurationSeconds > 0
  if (maxBytes <= 0 && !hasTimeCap) return null
  return {
    sessionId: row.id,
    maxDurationSeconds: hasTimeCap ? row.maxDurationSeconds : null,
    // What the chain has already metered before this connect; the watchdog adds the
    // live tunnel's own usage on top (see evaluateQuota). `duration` is metered from
    // the node's proofs, NOT from wall-clock since startAt — an idle session accrues
    // nothing, so startAt is useless as a quota measure.
    baselineDurationSeconds: row.durationSeconds ?? 0,
    maxBytes,
    baselineBytes: parseInt(row.downloadBytes, 10) || 0,
  }
}

function setQuota(row: SessionInfo | undefined): void {
  activeQuota = row ? quotaFromSessionRow(row) : null
  quotaWarned = false
  if (!activeQuota) return
  console.log(
    `[quota] session #${activeQuota.sessionId}: ` +
    `${activeQuota.maxDurationSeconds ? `${activeQuota.maxDurationSeconds}s` : 'no time cap'}, ` +
    `${activeQuota.maxBytes || 'no'} byte cap`,
  )
}

/** Rank a quota verdict so the worst of several can be picked. */
const QUOTA_LEVEL_RANK = { ok: 0, warn: 1, expired: 2 } as const
/** An 'expired' verdict carries no pct — it is already past the cap, so treat it as 100. */
const quotaPct = (v: QuotaVerdict): number => ('pct' in v ? v.pct : 100)

function verdictFor(quota: ActiveQuota) {
  return evaluateQuota({
    maxDurationSeconds: quota.maxDurationSeconds,
    baselineDurationSeconds: quota.baselineDurationSeconds,
    connectedSeconds: connectedSecondsAlive(),
    maxBytes: quota.maxBytes,
    baselineBytes: quota.baselineBytes,
    liveRxBytes: getTrafficStats().rxBytes,
  })
}

/**
 * The binding quota verdict, and WHICH session produced it. With a multihop chain
 * there are two paid sessions and the tunnel dies when EITHER runs out, so the worst
 * verdict wins — by level first, then by how far through the cap it is.
 *
 * The session id travels with the verdict because the two hops are different nodes:
 * reporting an expiry against the entry when it was the exit that ran out names the
 * wrong node to replace.
 */
function currentQuotaVerdict(): { verdict: QuotaVerdict; sessionId: string } | null {
  const scored = [activeQuota, activeExitQuota]
    .filter((q): q is ActiveQuota => q !== null)
    .map((q) => ({ verdict: verdictFor(q), sessionId: q.sessionId }))
  if (scored.length === 0) return null
  return scored.reduce((worst, s) =>
    QUOTA_LEVEL_RANK[s.verdict.level] > QUOTA_LEVEL_RANK[worst.verdict.level] ||
    (QUOTA_LEVEL_RANK[s.verdict.level] === QUOTA_LEVEL_RANK[worst.verdict.level] &&
      quotaPct(s.verdict) > quotaPct(worst.verdict))
      ? s
      : worst,
  )
}

/**
 * Watch the paid quota for as long as the tunnel is up. Unconditional on protocol —
 * every one of the six burns the same on-chain session — and deliberately NOT
 * skipped in proxy mode: a proxy-mode session expires exactly the same way, only
 * the teardown differs. (Proxy mode has no interface, so its rx counter is 0 and
 * only a time cap can fire; see evaluateQuota.)
 */
function startQuotaWatchdog(): void {
  // A reconnect from the Sessions tab creates no new session, so nothing captured a
  // quota for it — take it from lastKnownSessions, which is authoritative there.
  if (activeSessionId && activeQuota?.sessionId !== activeSessionId) {
    setQuota((lastKnownSessions as SessionInfo[]).find((s) => s?.id === activeSessionId))
  }
  // MULTIHOP: the exit hop needs the identical repair, and for a stronger reason.
  // The chain branch of CONNECTION_RECONNECT restores activeExitSessionId but has no
  // quota to restore (the purchase that captured one was an earlier run), so without
  // this a reconnected chain is scored on the ENTRY alone — currentQuotaVerdict reads
  // 'ok' while the exit is exhausted, and the only thing left to notice is
  // checkTunnelStalled, 64 KB and 90 s later. That is the whole "worst verdict wins"
  // rule sitting inert on the path it matters most on.
  if (activeExitSessionId && activeExitQuota?.sessionId !== activeExitSessionId) {
    const exitRow = (lastKnownSessions as SessionInfo[]).find((s) => s?.id === activeExitSessionId)
    activeExitQuota = exitRow ? quotaFromSessionRow(exitRow) : null
  }
  // Before the timer guard: an auto-reconnect re-enters here with the timer already
  // running, and the clock still has to start on the first bring-up of the session.
  connectedAtMs ??= Date.now()
  // max(), not assignment: an auto-reconnect re-enters here with connectedAtMs still
  // at the ORIGINAL bring-up, so assigning would rewind the alive clock and discard
  // usage already accrued. A fresh connect has a stale (older) aliveUntilMs, so the
  // max is connectedAtMs — correct in both cases.
  aliveUntilMs = Math.max(aliveUntilMs, connectedAtMs)
  resetOneWayTracking()
  if (quotaTimer) return
  quotaTimer = setInterval(() => {
    if (isIntentionalDisconnect || reconnectAttempt > 0 || !activeSessionId) return
    const failure = checkTunnelStalled()
    if (failure) {
      void standDownSession(failure)
      return
    }
    const scored = currentQuotaVerdict()
    if (!scored) return
    const verdict = scored.verdict
    if (verdict.level === 'expired') {
      void standDownSession(verdict.reason, scored.sessionId)
      return
    }
    if (verdict.level === 'warn' && !quotaWarned) {
      quotaWarned = true
      notify('Katacomb VPN', `About ${describeRemaining(verdict.reason, verdict.remaining)} of your session left.`)
      // Nudge the renderer to re-poll so the Sessions gauges catch up with the warning.
      sendStateChange('connected')
    }
  }, QUOTA_POLL_MS)
}

function stopQuotaWatchdog(): void {
  connectedAtMs = null
  if (quotaTimer) {
    clearInterval(quotaTimer)
    quotaTimer = null
  }
  resetOneWayTracking()
}

// Interface counters as of the last moment anything came IN, and when that was.
// Tracked here rather than through getTrafficStats(), which mutates the speed
// baseline as a side effect and would corrupt every reading if sampled on this loop.
let lastRxBytes = 0
let lastTxAtRx = 0
let lastRxMovedAtMs = 0
// The last moment the tunnel was known to be carrying traffic. Time after this point
// is NOT counted as session usage: on a tunnel the node has stopped answering, the
// chain meters nothing, and neither should we.
let aliveUntilMs = 0
// The interface counters as of that same moment. /proc/net/dev stops existing with
// the interface, so getTrafficStats() reads a flat ZERO once the tunnel is gone —
// the exact mirror of the clock problem above, and in the opposite direction. A
// stand-down triggered BY the interface vanishing would otherwise record this
// connect's traffic as nothing, dropping the byte floor back to the chain's
// not-yet-settled figure, which is the collapse lastSessionUsage exists to prevent.
let aliveBytes = { rx: 0, tx: 0 }

function resetOneWayTracking(): void {
  lastRxBytes = 0
  lastTxAtRx = 0
  lastRxMovedAtMs = 0
  aliveBytes = { rx: 0, tx: 0 }
}

/**
 * Is the tunnel transmitting with nothing coming back? The interface-presence monitor
 * cannot see this: `wg-quick up` succeeds whether or not the node ever answers a
 * handshake, so a node that has dropped our peer leaves sntl0 up forever. Mainnet
 * #53647217 sat in exactly that state for hours — ~3 KB out, 0 bytes in, the UI
 * saying "Connected" and this very watchdog counting the paid hour down against a
 * tunnel that moved nothing.
 *
 * Runs on the quota loop rather than the root-tunnel monitor so it covers all six
 * protocols, including the tun2socks ones. In local-proxy mode there is no interface,
 * readTunnelBytes() returns null, and the check correctly abstains.
 *
 * The stand-down deliberately does NOT go through attemptReconnect's autoReconnect
 * gate: with auto-reconnect off that returns silently and leaves the dead tunnel up,
 * which is the very state being detected.
 */
function checkTunnelStalled(): 'stalled' | 'dropped' | null {
  const now = Date.now()
  const bytes = readTunnelBytes()
  if (!bytes) {
    // Local-proxy mode has no interface to judge — abstain, and keep the clock
    // running (the session is being spent either way).
    if (usageAccruesWithoutTunnelInterface(desiredMode)) {
      aliveUntilMs = now
      return null
    }
    // Tunnel mode: the interface IS the tunnel, so its absence is not "cannot tell",
    // it is gone. aliveUntilMs deliberately stays where the last tick that still saw
    // the interface left it — the node stops metering when the tunnel drops, so
    // advancing it here billed the user for every second of a tunnel that no longer
    // existed, and wrote that figure into lastSessionUsage as a permanent floor.
    console.error('[vpn] the tunnel interface is gone — the tunnel is down')
    return 'dropped'
  }
  aliveBytes = bytes
  if (lastRxMovedAtMs === 0 || bytes.rx > lastRxBytes) {
    lastRxBytes = bytes.rx
    lastTxAtRx = bytes.tx
    lastRxMovedAtMs = now
  }
  if (!isTunnelOneWay(bytes.tx - lastTxAtRx, now - lastRxMovedAtMs)) {
    // Includes the genuinely idle tunnel: nothing out, nothing back, nothing wrong.
    aliveUntilMs = now
    return null
  }
  // Stalled. The tunnel was last useful when something last came back, so that — not
  // now — is where usage stops accruing.
  aliveUntilMs = lastRxMovedAtMs
  console.error(
    `[vpn] tunnel is one-way — ${bytes.tx - lastTxAtRx} bytes sent with no reply for ` +
    `${Math.round((now - lastRxMovedAtMs) / 1000)}s. The node has stopped forwarding.`,
  )
  return 'stalled'
}

/** "10 minutes" / "1.2 GB" — the remaining-quota phrase for the warning notification. */
function describeRemaining(reason: 'time' | 'data', remaining: number): string {
  if (reason === 'time') {
    const mins = Math.max(1, Math.round(remaining / 60))
    return mins >= 60 ? `${(mins / 60).toFixed(1)} hours` : `${mins} minutes`
  }
  const gb = remaining / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(remaining / 1024 ** 2))} MB`
}

/**
 * Desktop notification. The tray-minimised case is the whole point of this feature —
 * an in-app-only warning reaches nobody — so clicking one brings the window back.
 * The show logic is repeated rather than imported from index.ts's showWindow (that
 * would be a circular import); the three lines are enough here because the close
 * handler only ever HIDES the window, so there is never one to re-create.
 */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({ title, body })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  } catch (err) {
    console.error('[notify] failed:', err)
  }
}

/**
 * End the tunnel for a reason of our own, rather than the user's. Two callers, and
 * they need identical teardown: the session ran out of what it was paid for
 * ('time'/'data'), or the tunnel stopped carrying traffic ('stalled'). Only the log
 * line, the notification and the banner wording differ — the stand-down itself is
 * one path so the two can never drift apart.
 *
 * Modelled on performDisconnect so it inherits the same serialization invariants
 * (epoch bumped synchronously before the lock, reconnect machinery stood down
 * first), because the one thing that must not happen here is the reconnect timer
 * resurrecting a tunnel we have just decided to end.
 *
 * The tunnel ALWAYS comes down; the kill-switch preference decides what happens to
 * internet access. On → the DROP-all chain stays armed and the user is told traffic
 * is blocked, with a Restore button. Off → full revert, exactly like a manual
 * disconnect. That holds for 'stalled' too: a tunnel that has stopped forwarding is
 * precisely the case the kill switch exists for, so it stays armed and the user
 * chooses when to drop the protection. Never auto-renew: on-chain spending stays
 * user-initiated.
 *
 * KNOWN LIMITATION: the "expired, traffic blocked" state does not survive an app
 * restart. healStrandedKillSwitch() reverts an armed-but-disconnected kill switch at
 * next launch, by design — that self-heal is load-bearing (it is what rescues a user
 * from a chain stranded by a crash) and must NOT be weakened to preserve this state.
 */
async function standDownSession(
  reason: 'time' | 'data' | 'stalled' | 'dropped',
  /**
   * MULTIHOP: the hop whose quota actually ran out, when that is known. Both hops are
   * separate nodes on separate deposits, so reporting the entry's name for an exit
   * expiry sends the user off to replace the wrong one. Absent for a stall, which
   * nothing can attribute to an end: the report then falls back to the entry (the
   * only hop a single-hop session has) and claims no role.
   */
  endedSessionId?: string,
): Promise<void> {
  if (!activeSessionId) return
  const isExitHop = endedSessionId !== undefined && endedSessionId === activeExitSessionId
  const sessionId = isExitHop ? endedSessionId : activeSessionId
  const nodeMoniker = (isExitHop ? activeExitNodeInfo?.moniker : activeNodeInfo?.moniker) || ''
  // Only claim a hop when one was actually identified. A stall carries no session id
  // (nothing can attribute it to one end), and naming a hop there would be a guess
  // dressed up as a fact.
  const chainRole: 'entry' | 'exit' | undefined =
    activeExitSessionId === null || endedSessionId === undefined
      ? undefined
      : isExitHop ? 'exit' : 'entry'
  console.log(
    reason === 'stalled' || reason === 'dropped'
      ? `[vpn] session #${sessionId} tunnel ${reason === 'stalled' ? 'stopped carrying traffic' : 'closed unexpectedly'} — disconnecting`
      : `[quota] session #${sessionId} exhausted its ${reason} quota — disconnecting`,
  )

  // Same synchronous stand-down performDisconnect does, and for the same reason:
  // an in-flight reconnect must bail at its next epoch check even while another op
  // still holds the lock.
  isIntentionalDisconnect = true
  connectionEpoch++
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0

  await withConnectionLock(async () => {
    rememberSessionUsage()
    stopRootTunnelMonitor()
    stopQuotaWatchdog()

    if (loadSettings().killSwitch) {
      // Leave the kill-switch chain armed — that preference IS the user's stated
      // intent for "no tunnel". Only DNS goes back, so the machine isn't left
      // pointing at a resolver that no longer exists.
      await restoreDnsOverride()
    } else {
      await revertPostConnectSettings()
    }
    await disconnect()

    activeV2ray = null
    activeWg = null
    activeXrayConfig = null
    activeHysteria2Config = null
    activeAmneziaWgConfig = null
    activeOpenVpnConfig = null
    desiredProtocol = null
    desiredMode = 'tunnel'
    activeSessionId = null
    activeNodeInfo = null
    activeExitSessionId = null
    activeExitNodeInfo = null
    activeQuota = null
    activeExitQuota = null
    // The marker is written BEFORE arming, so a failed arm still reads as "armed".
    // This is deliberate: we bias toward over-reporting traffic as blocked (one
    // idempotent click to clear) rather than under-reporting it (user stranded). If
    // arming truly failed, the Restore button runs killswitch-off (idempotent) and
    // everything self-corrects.
    lastExpiry = { sessionId, nodeMoniker, reason, trafficBlocked: isKillSwitchArmed(), chainRole }
    isIntentionalDisconnect = false
    sendStateChange('idle')
  })

  const blocked = lastExpiry?.trafficBlocked
  // 'stalled' is an accusation and 'dropped' is not: the first has evidence against
  // the node (traffic left, nothing came back), the second only means the tunnel is
  // gone, which a local failure explains just as well.
  const why =
    reason === 'stalled' ? 'The tunnel stopped carrying traffic, so it was disconnected.'
      : reason === 'dropped' ? 'The VPN tunnel closed unexpectedly, so it was disconnected.'
        : 'Session ended, VPN disconnected.'
  notify(
    'Katacomb VPN',
    blocked ? `${why} The kill switch is still blocking all traffic.` : why,
  )
}

// Reachability probe for a freshly-built tunnel. Small response, plain HTTPS, and
// already contacted by NETWORK_GET_IP — no new third party is introduced.
const TUNNEL_PROBE_URL = 'https://icanhazip.com'
/**
 * A second probe target dialled by IP, so it needs NO DNS.
 *
 * The hostname probe above resolves THROUGH the tunnel, which makes its failure
 * ambiguous on exactly the tunnels worth catching: a dead tunnel breaks DNS, and
 * broken DNS breaks the probe, so "probe failed" looks identical to "the probe host
 * is down" — the reason the byte fallback exists at all. Removing DNS from one of the
 * two targets is what tells those apart. Two independent targets also mean a node
 * blocking one of them cannot cause a working tunnel to be torn down.
 */
const TUNNEL_PROBE_IP_URL = 'https://1.1.1.1'
/**
 * How many bytes must come BACK before the byte evidence alone is believed.
 *
 * `now.rx > before.rx` was not a test. When xray cannot reach the exit hop of a chain
 * it fails each relay locally, and tun2socks writes the resulting connection resets
 * back into the tun — so rx ticks upward while the tunnel carries nothing, and a
 * completely dead chain reported "connected". Measured on that failure: ~92 KB out
 * against ~28 KB back over two minutes, none of it real. Sized like
 * ONE_WAY_TX_FLOOR_BYTES: comfortably above teardown noise, far below a real reply.
 */
const TUNNEL_PROBE_MIN_RX_BYTES = 16 * 1024
const TUNNEL_PROBE_TIMEOUT_MS = 6000
const TUNNEL_PROBE_ATTEMPTS = 3

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
function fetchFreshSocket(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
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

/**
 * Does the tunnel we just built actually carry traffic? An interface existing does
 * not mean it does: `wg-quick up` reports success whether or not the node ever
 * answers a handshake, so a node that has dropped our peer yields a perfectly
 * healthy-looking sntl0 that will never move a byte. That is how mainnet #53647217
 * spent hours reporting "Connected" while the public IP never changed — the only
 * honest signal on screen was the IP lookup failing, which nothing acted on.
 *
 * Two independent ways to pass, because either one alone has a false negative:
 *  - the probe fetch succeeds — the path works end to end, including DNS;
 *  - inbound bytes appear on the interface — protocol-agnostic proof the far end is
 *    answering, and the verdict when it is the probe HOST that is down rather than
 *    the tunnel.
 * Only both failing, repeatedly, is a verdict.
 */
async function tunnelCarriesTraffic(): Promise<boolean> {
  const before = readTunnelBytes()
  for (let attempt = 0; attempt < TUNNEL_PROBE_ATTEMPTS; attempt++) {
    // Both targets at once, first success wins: by name (proves the whole path,
    // DNS included) and by IP (proves routing even when DNS is what is broken).
    // Either succeeding was already a pass when they ran in sequence — racing
    // them just stops a node that blackholes one target from costing that
    // target's whole timeout before the other gets its turn. Fresh sockets on
    // purpose (see fetchFreshSocket): a probe that reuses a pooled socket from
    // BEFORE this tunnel existed is measuring the kill switch, not the tunnel.
    // Promise.any resolves on the first success, rejects only when both failed
    // (and swallows the individual rejections either way); the loser closes
    // itself at its own timeout, holding no pooled state.
    const passed = await Promise.any(
      [TUNNEL_PROBE_URL, TUNNEL_PROBE_IP_URL].map(async (url) => {
        const res = await fetchFreshSocket(url, TUNNEL_PROBE_TIMEOUT_MS)
        if (res.status < 200 || res.status >= 300) throw new Error(`${url} answered ${res.status}`)
      }),
    ).then(() => true, () => false)
    if (passed) return true
    const now = readTunnelBytes()
    if (before && now && now.rx - before.rx >= TUNNEL_PROBE_MIN_RX_BYTES) return true
  }
  return false
}

/**
 * Gate a bring-up on the tunnel actually working, and tear it down if it doesn't.
 * Runs AFTER applyPostConnectSettings deliberately: the kill switch is part of what
 * can strangle a tunnel (arming it against a hostname endpoint is exactly what broke
 * #53647217), so what gets verified has to be the final state, not an intermediate one.
 *
 * Failure leaves main's stashed session config alone, so the connect modals still
 * offer "Retry connection" rather than resetting to the subscribe form — the session
 * is paid for and still live on chain.
 */
async function assertTunnelCarriesTraffic(): Promise<void> {
  if (await tunnelCarriesTraffic()) return
  console.error(
    '[vpn] tunnel came up but carries no traffic — tearing it down ' +
    `(peer ${nodeIssuedFreshPeer ? 'freshly issued by the node' : 'replayed from the saved config'})`,
  )
  await revertPostConnectSettings()
  await disconnect()
  throw new Error(deadTunnelMessage(nodeIssuedFreshPeer, activeExitSessionId !== null))
}

// Main-process listeners (e.g. the tray) for connection-state changes. Mirrors
// the onV2RayUnexpectedExit pattern: ipc-handlers owns the state and notifies on
// change — callers register a listener rather than us reaching into their module.
export interface ConnectionInfo {
  state: 'connected' | 'connecting' | 'idle'
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
  // The chain is queried only while the tunnel is down, so the RPC pill's state
  // is a function of this transition — publish it now instead of leaving the
  // old one up for the rest of the 30s poll window.
  onChainPathChanged()
  // Same reasoning for the chain-backed lists: every overview served while the
  // tunnel was up is stale: true, and PlansContext's other refresh triggers are
  // chain events plus a 300s backstop — so without this push, the Plans tab's
  // Connect buttons (gated on !stale) stayed dead for up to five minutes after
  // a disconnect. Reported from a live run.
  if (state === 'idle') notifySessionsChanged()
  connectionStateListener?.({ state, nodeMoniker: activeNodeInfo?.moniker, nodeCountry: activeNodeInfo?.country })
}

/**
 * Tray-only: a bring-up is in flight. Deliberately NOT part of sendStateChange —
 * the renderer drives its own progress UI off the CONNECTION_CONNECT promise and
 * the CONNECTION_RECONNECTING broadcast, and there is no chain-path change to
 * publish because no tunnel exists yet.
 *
 * Every path that calls this MUST end at notifyTraySettled() (or a
 * sendStateChange), or the tray sits on a stale "connecting" badge forever.
 */
function notifyTrayConnecting(): void {
  connectionStateListener?.({ state: 'connecting', nodeMoniker: activeNodeInfo?.moniker, nodeCountry: activeNodeInfo?.country })
}

/** Tray-only: republish whatever is actually true now. Idempotent. */
function notifyTraySettled(): void {
  connectionStateListener?.(getConnectionInfo())
}

function sendReconnecting(attempt: number, maxAttempts: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.CONNECTION_RECONNECTING, attempt, maxAttempts)
  }
  // The tunnel is down but nothing has broadcast 'idle' yet — without this the
  // tray keeps claiming "Connected" for the whole retry ladder.
  notifyTrayConnecting()
}

/**
 * Refuse to start a second connection while one is active. Covers every state the
 * app can be carrying traffic in: a root tunnel interface (WG/AWG/OpenVPN), a
 * child-proxy tunnel (v2ray/xray/hysteria2 + tun2socks), local-proxy mode (where
 * isVpnActive() is deliberately false because routing is untouched, but a paid
 * session is live all the same), and the auto-reconnect window (tunnel briefly
 * down but about to be resurrected). Without this, a second purchase clobbered the
 * tracked session (applySession) and brought a second tunnel up over the first,
 * leaving the old session active on chain with nothing watching its quota.
 * The renderer greys these actions out; this is the trust-boundary backstop.
 */
function assertNotConnected(): void {
  if (reconnectAttempt > 0 || getConnectionStatus().connected) {
    const name = activeNodeInfo?.moniker || activeNodeInfo?.address
    throw new Error(
      `Already connected${name ? ` to ${name}` : ''}. Disconnect the current session before starting a new connection.`,
    )
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
  activeOpenVpnConfig = result.protocol === 'openvpn' ? result.configString : null
  // Every caller reached here through a handshake the node answered, so the peer
  // behind this config is as fresh as it gets.
  nodeIssuedFreshPeer = true
}

/**
 * Stash a freshly-bought multihop chain. The chained config runs on the xray binary
 * (see performChainHandshake), so it goes in `activeXrayConfig` and the connect path
 * needs no new branch. Entry is the primary session/node for every existing reader;
 * the exit is held alongside so both quotas are watched, both usages are floored and
 * both are visible to the renderer.
 *
 * Unlike two applySession calls — which would silently clobber the first hop and
 * leave its deposit untracked — this writes both halves in one step.
 */
function applyChainSession(
  entry: ChainHopInput,
  exit: ChainHopInput,
  configString: string,
): void {
  activeSessionId = entry.sessionId
  activeNodeInfo = {
    address: entry.nodeAddress, moniker: entry.nodeMoniker,
    country: entry.nodeCountry, type: entry.nodeType,
  }
  activeExitSessionId = exit.sessionId
  activeExitNodeInfo = {
    address: exit.nodeAddress, moniker: exit.nodeMoniker,
    country: exit.nodeCountry, type: exit.nodeType,
  }
  activeWg = null
  activeV2ray = null
  activeXrayConfig = configString
  activeHysteria2Config = null
  activeAmneziaWgConfig = null
  activeOpenVpnConfig = null
  nodeIssuedFreshPeer = true
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
    return `node returned HTTP ${response.status ?? '?'}${detailStr ? `: ${detailStr}` : ''}`
  }
  return err instanceof Error ? err.message : String(err)
}

const NODE_TYPE_TO_PROTOCOL: Record<number, 'wireguard' | 'v2ray' | 'xray' | 'amneziawg' | 'hysteria2' | 'openvpn'> = {
  1: 'wireguard', 2: 'v2ray', 3: 'openvpn', 4: 'xray', 5: 'amneziawg', 6: 'hysteria2',
}

// Smart connect (PLAN_SMART_CONNECT): how many top-ranked candidates get a live
// probe, how long the probe batch may run, and how fresh a cached probe result
// must be to count as a measurement.
const SMART_PROBE_TOP_N = 6
const SMART_PROBE_WINDOW_MS = 4_000
const SMART_LATENCY_FRESH_MS = 10 * 60 * 1000

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
async function preflightConnect(
  nodeType: number,
  apiField: string,
  /**
   * Ask the node through this proxy instead of directly. Set for a chain's EXIT hop, so
   * the question arrives from the entry node rather than from the user (see
   * establishChainOrRefund).
   */
  agent?: https.Agent,
): Promise<void> {
  const protocol = NODE_TYPE_TO_PROTOCOL[nodeType]
  if (!protocol) throw new Error(`Unsupported nodeType ${nodeType}`)

  const runtimeError = protocolRuntimeError(protocol)
  if (runtimeError) throw new Error(`Can't connect, not charged. ${runtimeError}`)

  // WireGuard/AmneziaWG/OpenVPN go up as root: without the daemon or the helper the
  // bring-up has no way to escalate and would fail after payment.
  if (protocol === 'wireguard' || protocol === 'amneziawg' || protocol === 'openvpn') {
    if (!canEscalatePrivileges()) {
      const label = protocol === 'wireguard' ? 'WireGuard' : protocol === 'amneziawg' ? 'AmneziaWG' : 'OpenVPN'
      throw new Error(
        `Can't connect, not charged. The privileged helper isn't installed, so ${label} can't be brought up. Restart the app and accept the helper setup prompt.`
      )
    }
  }

  let reported: string | number
  try {
    // nodeFetch's own 8s timeout only covers socket inactivity, not the TCP
    // connect — a blackholed node hangs well past it (measured). This gate sits
    // in front of the connect button, so bound the whole wait.
    reported = await withTimeout(
      fetchNodeServiceType(apiField, agent),
      agent ? NODE_CHECK_VIA_PROXY_TIMEOUT_MS : NODE_PROTOCOL_CHECK_TIMEOUT_MS,
      'node protocol check',
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error'
    throw new Error(`Node is unreachable, not charged (${reason}). Pick another node.`)
  }

  const actualType = serviceTypeToNodeType(reported)
  if (actualType !== nodeType) {
    throw new Error(
      `Node protocol mismatch, not charged. The node reports "${reported}" but the node list says ` +
      `${protocol}. Refresh the node list and pick another node.`
    )
  }
}

/**
 * The multihop counterpart to preflightConnect, run BEFORE either purchase.
 *
 * preflightConnect answers "does this node run the protocol the directory claims";
 * this answers "can this node be THIS END of a chain", which is a different and
 * stricter question: TLS or Reality on both ends, plus a plain-TCP inbound on the
 * exit. The picker already greys out nodes that fail it, but the picker works from
 * a cache and cannot be the guarantee — this is the gate that runs against the
 * node's own listing at the moment the money would move.
 *
 * A node too old to publish a listing is refused here rather than bought and
 * refunded: pre-9.0.0 nodes publish nothing to check and almost none of them offer
 * TLS, so buying one is a near-certain refund.
 */
async function assertChainEligible(
  hop: { nodeAddress: string; nodeMoniker: string; nodeType: number; apiField: string },
  role: 'entry' | 'exit',
  /** Ask through this proxy rather than directly. Set for the EXIT hop. */
  agent?: https.Agent,
): Promise<void> {
  const name = hop.nodeMoniker || hop.nodeAddress
  let metadata: HopMetadataEntry[]
  try {
    metadata = (await withTimeout(
      fetchNodeServiceMetadata(hop.apiField, agent),
      agent ? NODE_CHECK_VIA_PROXY_TIMEOUT_MS : NODE_PROTOCOL_CHECK_TIMEOUT_MS,
      'node inbound listing',
    )) as HopMetadataEntry[]
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error'
    throw new Error(
      `Can't build the chain, not charged. The ${role} node "${name}" did not publish the ` +
      `inbound list needed to check it (${reason}), so there is no way to confirm it can be ` +
      'wrapped in TLS before paying for it. Pick a node running 9.0.0 or later.',
    )
  }
  const graded = classifyHopEligibility(hop.nodeType === 4 ? 'xray' : 'v2ray', metadata)
  if (role === 'exit' ? graded.exit : graded.entry) return
  throw new Error(
    `Can't build the chain, not charged. The ${role} node "${name}" serves ` +
    `${graded.transports.join(', ') || 'nothing usable'}, which does not meet the rule for a ` +
    `chain ${role}: ${role === 'exit'
      ? 'a plain-TCP inbound wrapped in TLS or Reality'
      : 'an inbound wrapped in TLS or Reality'}. This node is still fine for an ordinary ` +
    'single-hop connection. Pick a different one.',
  )
}

/**
 * Refuse to broadcast when the wallet can't cover `costUdvpn` plus gas. Pass 0 for
 * a gas-only tx. The renderer runs the same check to disable its pay buttons, but
 * its balance is polled and can be minutes stale — this one reads it fresh.
 *
 * Fails OPEN: if the balance can't be read (RPC down, or a tunnel is up and RPC is
 * unreachable through it) we let the tx proceed and let the chain decide. Blocking
 * someone from ending a session because we couldn't reach an RPC is worse than the
 * on-chain failure, which `assertTxSucceeded` now reports readably anyway.
 */
async function assertSufficientFunds(costUdvpn: number, client?: SentinelClient): Promise<void> {
  let balances: { denom: string; amount: string }[]
  try {
    balances = await getBalance(client)
  } catch {
    reportRpcFailure()
    return
  }
  const check = checkFunds(udvpnOf(balances), costUdvpn)
  if (!check.ok) throw new Error(`${INSUFFICIENT_FUNDS}: ${insufficientFundsMessage(check)}`)
}

/**
 * The same check against a specific account, for the second wallet of a per-hop
 * chain. Fails OPEN on an unreadable balance for the same reason as above: blocking
 * a purchase because an RPC was briefly unreachable is worse than letting the chain
 * reject it, which `assertTxSucceeded` reports readably.
 */
async function assertSufficientFundsFor(address: string, costUdvpn: number): Promise<void> {
  let balances: { denom: string; amount: string }[]
  try {
    balances = await getBalanceForAddress(address)
  } catch {
    reportRpcFailure()
    return
  }
  const check = checkFunds(udvpnOf(balances), costUdvpn)
  if (!check.ok) {
    throw new Error(
      `${INSUFFICIENT_FUNDS}: the wallet paying for the exit hop is short. ` +
      insufficientFundsMessage(check),
    )
  }
}

/**
 * Report a failed chain call to the health monitor and rethrow it. When the
 * message says we never reached the endpoint, tag it so the renderer can offer
 * the network settings instead of showing a raw `RPC connect timed out`.
 *
 * Wraps chain-only calls, never node calls — a node's own `ECONNREFUSED` would
 * otherwise be blamed on the RPC. The message deliberately makes no claim about
 * whether a transaction landed: `broadcastOrTimeout`'s own timeout text (which
 * this never matches) is what covers that case, carefully.
 */
function noteChainError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  if (isRpcConnectivityError(message)) {
    reportRpcFailure()
    throw new Error(
      `${RPC_UNREACHABLE}: Couldn't reach the blockchain at ${rpcHostLabel(getRpcHealth().endpoint || 'the RPC endpoint')}. ` +
      `Check your internet connection, or switch to another RPC endpoint in Settings → Network. (${message})`,
    )
  }
  throw err
}

/**
 * What a plan costs, in udvpn, from main's own plan cache — so the pre-check never
 * has to trust a renderer-supplied price. Returns 0 (i.e. "check gas only") when
 * the plan isn't cached or doesn't quote this denom; the chain is the backstop.
 */
function cachedPlanCost(planId: string, denom: string): number {
  const plan = getCachedPlans().plans.find((p) => p.id === planId)
  const price = plan?.prices.find((p) => p.denom === denom)
  if (!price) return 0
  const parsed = parseInt(price.quoteValue, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Tell the renderer its session list is stale, so it re-queries now instead of at
 * the next poll.
 *
 * The Sessions tab polls every 120s and otherwise refreshes only when the VPN
 * connects — and a failed purchase never connects. So a session main had just
 * cancelled sat there for up to two minutes looking live, with an enabled Connect
 * button on a session no node will honour. A user who has just read "both sessions
 * were cancelled and your deposits refunded" and then sees the session still listed
 * reasonably concludes the refund did not happen. Reported from a live run.
 *
 * Safe to send the moment `endSession` resolves: it waits for tx inclusion, so the
 * chain already reports `inactive_pending` by the time the renderer asks.
 */
function notifySessionsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.SESSIONS_CHANGED)
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
  /** Already-resolved handshake endpoint (the purchase fetched the node row anyway). */
  remoteUrl?: string
}): Promise<Awaited<ReturnType<typeof performHandshake>>> {
  const { sessionId, nodeAddress, nodeType, apiField, nodeMoniker, nodeCountry, wallet, address, privKey, isDeposit } = params
  try {
    const remoteUrl = params.remoteUrl ?? await resolveNodeRemoteUrl(nodeAddress, apiField)
    // A 404 here is usually the node's own RPC not having our session's block
    // yet, not a dead node — the handshake handler validates the session against
    // the chain LIVE (see shouldRetrySessionHandshake). Bounded retries keep a
    // healthy purchase out of the refund path; anything else fails immediately.
    // A fresh keypair per attempt is fine: 404 means the node registered nothing.
    for (let attempt = 0; ; attempt++) {
      try {
        return await performHandshake({ sessionId, nodeAddress, nodeType, remoteUrl, privKey, nodeMoniker, nodeCountry })
      } catch (err) {
        if (!shouldRetrySessionHandshake(describeNodeApiError(err).status, attempt)) throw err
        console.log(`[connect] node cannot see session #${sessionId} yet (chain lag), retrying in ${HANDSHAKE_RETRY_DELAY_MS}ms`)
        await new Promise((r) => setTimeout(r, HANDSHAKE_RETRY_DELAY_MS))
      }
    }
  } catch (err) {
    let refunded = false
    try {
      await withTimeout(endSession({ wallet, address, sessionId }), REFUND_TIMEOUT_MS, 'refund')
      refunded = true
      notifySessionsChanged()
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

/** One hop's purchase inputs for a multihop chain. */
interface ChainHopInput {
  sessionId: string
  nodeAddress: string
  nodeType: number
  apiField: string
  nodeMoniker: string
  nodeCountry: string
}

/**
 * Cancel every session in `sessionIds`, independently and best-effort, reporting
 * which ones actually came back. Each cancel is its own transaction, and one
 * failing must never stop the others from being attempted — a single flaky
 * broadcast must not strand the user's other deposit too.
 *
 * SEQUENTIAL, not Promise.all. Every cancel is a tx signed by the SAME account, so
 * broadcasting two at once makes them read the same account sequence number and the
 * chain rejects the loser — which is the identical constraint establishChainOrRefund
 * documents for the two purchases. Racing them here cost a live refund: cancelling a
 * failed chain, entry #55122441 landed and exit #55122449 was rejected, leaving a
 * paid session the user had to cancel by hand. Awaiting each in turn is what makes
 * the second cancel see the sequence the first consumed.
 */
async function refundSessions(
  paid: { sessionId: string; signer: ChainSigner }[],
): Promise<{ sessionId: string; refunded: boolean }[]> {
  const byId = new Map(paid.map((p) => [p.sessionId, p.signer]))
  return refundEachInTurn(paid.map((p) => p.sessionId), async (sessionId) => {
    const signer = byId.get(sessionId)!
    try {
      // x/session only accepts a cancel signed by the session's OWN account, so a
      // per-hop-wallet chain must cancel each hop with the wallet that bought it.
      await withTimeout(
        endSession({ wallet: signer.wallet, address: signer.address, sessionId }),
        REFUND_TIMEOUT_MS,
        'refund',
      )
      // Per hop, not once at the end: the two cancels are sequential and each is a
      // block apart, so telling the renderer after the first means the list stops
      // showing a refunded hop as live while the second is still broadcasting.
      notifySessionsChanged()
    } catch (err) {
      console.error(`[connect] auto-cancel of session ${sessionId} failed:`, err)
      throw err
    }
  })
}

/** The account that pays for, handshakes and can cancel one hop. */
interface ChainSigner {
  wallet: NonNullable<ReturnType<typeof getWallet>>
  address: string
  privKey: Uint8Array
  /**
   * Which wallet this is. Recorded on BOTH hops, including the active one: a saved
   * record with no walletId means "whichever wallet is active", and that changes the
   * moment the user switches — after which listSessionsOwnedByOtherWallets cannot see
   * the hop the old wallet paid for, so it drops off the Sessions tab and its cancel
   * is signed by an account x/session will reject, stranding the deposit. Only
   * undefined when the active wallet has no id at all (no wallet loaded), which the
   * caller has already ruled out.
   */
  walletId?: string
}

/**
 * The multihop analogue of establishSessionOrRefund, and the reason a chain can be
 * bought at all: TWO sessions are paid for here, so a failure at ANY point must
 * refund BOTH — including the case where the exit purchase itself fails after the
 * entry session is already on chain. bluecli's equivalent just prints an "orphan
 * session" notice; that is the behaviour this exists to avoid.
 *
 * Ordering is deliberate, and it is NOT "buy both, then handshake both" any more.
 * The exit hop must never be contacted from this device: its grade, its preflight and
 * above all its signed handshake are session-bound and are followed seconds later by
 * the user's traffic, so an exit that records who asked can join the two and the chain
 * protects nothing (audit finding S1). So the entry is stood up FIRST, as a bare
 * loopback proxy, and everything the exit ever hears comes through it.
 *
 *   buy entry -> handshake entry -> entry-only proxy -> [check + buy + handshake exit,
 *   the node calls through the proxy] -> stop proxy -> build the chained config
 *
 * What that costs, accepted knowingly: the exit's eligibility gate now runs AFTER the
 * entry is paid for, so a bad exit costs an entry refund rather than nothing. The
 * picker already refuses an exit without positive evidence, so this gate is a backstop
 * against a node that changed since it was graded, not the primary check.
 *
 * The exit PURCHASE is deliberately broadcast directly rather than through the proxy:
 * it is a public on-chain transaction that tells the exit nothing its own session row
 * does not already, and keeping CosmJS off the proxy keeps the blast radius small.
 *
 * The two purchases MUST stay sequential (awaited, not raced) when they share a wallet:
 * parallel broadcasts collide on the account sequence number and the second is
 * rejected. With per-hop wallets they are two accounts, but the order below is
 * sequential anyway because the entry has to be LIVE before the exit is bought.
 *
 * `startSession` is injected so this stays agnostic about how each hop is funded;
 * today both hops are direct per-GB/per-hour purchases.
 */
async function establishChainOrRefund(params: {
  entry: Omit<ChainHopInput, 'sessionId'>
  exit: Omit<ChainHopInput, 'sessionId'>
  startSession: (hop: Omit<ChainHopInput, 'sessionId'>, signer: ChainSigner) => Promise<string>
  /** Signers per hop. The same object for both when the chain is on one wallet. */
  entrySigner: ChainSigner
  exitSigner: ChainSigner
}): Promise<{ protocol: 'xray'; configString: string; entrySessionId: string; exitSessionId: string }> {
  const { entry, exit, startSession, entrySigner, exitSigner } = params
  // Sessions paid for so far, in creation order, each with the account that can
  // cancel it. Everything in here is refunded on any throw below — including a
  // throw from the exit purchase itself.
  const paid: { sessionId: string; signer: ChainSigner }[] = []
  let failedRole: 'entry' | 'exit' | null = null
  let proxy: ProvisioningProxy | null = null

  try {
    failedRole = 'entry'
    sendChainHopProgress('entry', 'buy')
    const entrySessionId = await startSession(entry, entrySigner)
    paid.push({ sessionId: entrySessionId, signer: entrySigner })

    const entryUrl = await resolveNodeRemoteUrl(entry.nodeAddress, entry.apiField)
    const entryHop = { ...entry, sessionId: entrySessionId, remoteUrl: entryUrl, walletId: entrySigner.walletId }
    const entrySpec = await handshakeChainEntry(entryHop, entrySigner.privKey)

    // From here on the exit hears only from the entry node.
    failedRole = null
    sendChainHopProgress('exit', 'provision')
    proxy = await startProvisioningProxy(JSON.stringify(buildEntryOnlyConfig(entrySpec, PROVISION_SOCKS_PORT), null, 2))
    const agent = new SocksHttpsAgent(proxy.port)

    failedRole = 'exit'
    // Same two pre-purchase checks the single-hop path makes, asked through the entry.
    await preflightConnect(exit.nodeType, exit.apiField, agent)
    await assertChainEligible(exit, 'exit', agent)

    sendChainHopProgress('exit', 'buy')
    const exitSessionId = await startSession(exit, exitSigner)
    paid.push({ sessionId: exitSessionId, signer: exitSigner })

    const exitUrl = await resolveNodeRemoteUrl(exit.nodeAddress, exit.apiField)
    const exitHop = { ...exit, sessionId: exitSessionId, remoteUrl: exitUrl, walletId: exitSigner.walletId }
    const exitSpec = await handshakeChainExit(exitHop, exitSigner.privKey, agent)

    failedRole = null
    const result = await finalizeChain({ entry: entryHop, exit: exitHop, entrySpec, exitSpec })
    return { ...result, entrySessionId, exitSessionId }
  } catch (err) {
    const refunds = await refundSessions(paid)
    // The handshake tags its own errors with the hop they came from; failedRole only
    // ever covers the purchases and the two endpoint resolves. Taking the tag first is
    // what stops an exit-hop failure being reported against the entry node's name.
    const brokenRole = chainHopRoleOf(err) ?? failedRole
    const moniker = (brokenRole === 'exit' ? exit.nodeMoniker : entry.nodeMoniker) || ''
    throw new Error(chainFailureMessage({
      reason: describeHandshakeError(err),
      policyRejected: err instanceof V2RayPolicyError,
      failedRole: brokenRole,
      nodeMoniker: moniker,
      refunds,
    }))
  } finally {
    // Always, on every path: this is an unregistered child process holding a listener,
    // so nothing else in the app knows to clean it up.
    proxy?.stop()
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

/**
 * Arm the kill switch for a live tunnel and remember what it was armed with.
 * Returns false when there is no endpoint IP to whitelist, so the caller can flag
 * killSwitchFailed: `-d 0.0.0.0/32 -j ACCEPT` matches nothing, so the DROP-all
 * rule would swallow the tunnel's OWN outer packets and the connection would die
 * with the interface still up and reporting "connected".
 */
async function armKillSwitch(
  protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn',
  dnsIp: string | undefined,
  lanSharing: boolean,
): Promise<boolean> {
  // AmneziaWG rides the WG branch throughout: same sntl0 iface, same Endpoint=
  // line in its config, and awg-quick owns resolv.conf like wg-quick does.
  const isWgLike = protocol === 'wireguard' || protocol === 'amneziawg'
  // OpenVPN has its own interface and its own `remote` line; the kill switch
  // itself is protocol-agnostic (`-d host -j ACCEPT`), so it needs no changes.
  const isOpenVpn = protocol === 'openvpn'
  const iface = isWgLike ? 'sntl0' : isOpenVpn ? 'sntl-ovpn' : 'sntl-tun'
  // Whitelist the *real* server endpoint so the tunnel can re-handshake while the
  // kill switch is engaged.
  const remoteHost =
    isWgLike ? getWireGuardRemoteHost() : isOpenVpn ? getOpenVpnRemoteHost() : getV2RayRemoteHost()
  if (!remoteHost) {
    console.error(`[killswitch] no endpoint IP for ${protocol} — not arming (traffic would be blackholed)`)
    return false
  }
  await enableKillSwitch(iface, remoteHost, { dnsIp, lanSharing })
  armedWith = { iface, remoteHost, dnsIp, lanSharing }
  return true
}

/** Apply DNS and kill switch settings after a successful VPN connection */
async function applyPostConnectSettings(protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'): Promise<void> {
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
  // - OpenVPN: joins the dns-set group. Applying the server's pushed DNS would need
  //   an --up script, which is exactly the root-exec vector config-guard rejects, so
  //   we provision the resolver ourselves. redirect-gateway sends it through the
  //   tunnel; like WG/hysteria2 it is plaintext-in-tunnel (no DoH — not v2ray-shaped).
  const v2rayDnsIp = (protocol === 'v2ray' || protocol === 'xray' || protocol === 'hysteria2' || protocol === 'openvpn')
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
      const dnsIp = v2rayDnsIp ?? undefined
      if (!(await armKillSwitch(protocol, dnsIp, settings.lanSharing))) killSwitchFailed = true
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
    if (teardownOk) armedWith = null
  } else {
    killSwitchTeardownFailed = false
    armedWith = null
  }
  await restoreDnsOverride()
}

/**
 * Re-apply the firewall after a mid-session Kill Switch / Local Network Sharing
 * toggle, so the toggles mean what they say instead of taking effect at the next
 * connect. `killswitch-on` flushes and rebuilds the chain, so a re-arm is one
 * idempotent call. Runs under the connection lock: arming reads the endpoint that
 * connect/disconnect are concurrently setting.
 */
async function reapplyFirewall(): Promise<void> {
  const settings = loadSettings()
  const action = decideFirewallAction({
    killSwitch: settings.killSwitch,
    lanSharing: settings.lanSharing,
    armed: isKillSwitchArmed(),
    armedLanSharing: armedWith?.lanSharing ?? false,
    tunnelActive: isVpnActive(),
  })
  if (action === 'none') return
  try {
    if (action === 'disarm') {
      const ok = await disableKillSwitch()
      killSwitchTeardownFailed = !ok
      if (ok) {
        armedWith = null
        // The kill switch is intentionally off now, so there is no pending arm
        // failure left to warn about.
        killSwitchFailed = false
      }
      return
    }
    if (action === 'rearm') {
      // Needs the endpoint recorded at arm time. A chain stranded across a restart
      // has none (startup self-heal normally reverts it), so leave it alone —
      // turning the kill switch off still disarms.
      if (!armedWith) return
      await enableKillSwitch(armedWith.iface, armedWith.remoteHost, {
        dnsIp: armedWith.dnsIp,
        lanSharing: settings.lanSharing,
      })
      armedWith = { ...armedWith, lanSharing: settings.lanSharing }
      killSwitchFailed = false
      return
    }
    // 'arm' — a tunnel is up and the kill switch was just switched on.
    if (!desiredProtocol) {
      // A live tunnel with no known protocol (e.g. adopted from a running interface
      // after a restart) means there is nothing to derive an endpoint from — the
      // setting reads ON with no chain installed, so flag it rather than returning
      // silently.
      killSwitchFailed = true
      return
    }
    // Mirror applyPostConnectSettings' DNS decision for the dns-set protocols:
    // arming without a tunnel-routed resolver leaves DNS pointing at one the
    // chain now drops. effectiveV2RayResolverIp reads the (now true) killSwitch
    // setting, so a 'system' resolver becomes the public fallback.
    const needsDns = desiredProtocol === 'v2ray' || desiredProtocol === 'xray'
      || desiredProtocol === 'hysteria2' || desiredProtocol === 'openvpn'
    const dnsIp = needsDns ? effectiveV2RayResolverIp(settings) ?? undefined : undefined
    if (dnsIp && !isDnsOverridden()) {
      markDnsOverridden()
      try {
        await runPrivileged(['dns-set', dnsIp])
      } catch (err) {
        console.error('Failed to set DNS:', err)
      }
    }
    killSwitchFailed = !(await armKillSwitch(desiredProtocol, dnsIp, settings.lanSharing))
  } catch (err) {
    console.error('Failed to re-apply firewall settings:', err)
    killSwitchFailed = true
  }
}

/**
 * The DNS half of the teardown on its own. Split out for the quota-expiry path,
 * which puts the resolver back but deliberately LEAVES the kill switch armed.
 */
async function restoreDnsOverride(): Promise<void> {
  if (isDnsOverridden()) {
    try {
      await runPrivileged(['dns-restore'])
      clearDnsOverridden()
    } catch { /* best-effort — marker kept so a later teardown retries */ }
  }
}

/**
 * On startup, tear down a tunnel that outlived the process that was supervising it.
 *
 * The tunnel survives a crash by construction: WG/AWG/OpenVPN interfaces are created
 * by root and live in the kernel, tun2socks is spawned detached by the helper, and the
 * daemon has no notion of whether a GUI is alive (its socket close carries no meaning —
 * daemon-client opens one connection per request by design). detectExistingConnection()
 * then adopts the interface, so getConnectionStatus() reports connected and the UI says
 * so.
 *
 * What does NOT come back is the supervision. `activeSessionId` is only ever assigned
 * on the connect/reconnect paths, so an adopted tunnel has no session behind it, and
 * therefore no startQuotaWatchdog (the only thing that watches the paid quota, and the
 * only caller of checkTunnelStalled) and no startRootTunnelMonitor (gated on the same
 * id). connectedAtMs is null, so nothing accrues usage either. The kill switch cannot
 * even be armed against it: armedWith is null, so a re-arm is skipped, and there is no
 * endpoint recorded to whitelist, so turning it on just sets killSwitchFailed.
 *
 * A tunnel in that state is worse than no tunnel: it carries traffic and bills a paid
 * session that nothing will stand down at its cap. So we close it, and let the user
 * reconnect from the Sessions tab, which restores the session id and the watchdog
 * properly. The chain session is untouched (cancel is not a refund) and is still listed
 * there.
 *
 * Traffic is deliberately NOT left blocked afterwards: revertPostConnectSettings is the
 * full revert, matching the rule that the "expired, traffic blocked" state must not
 * survive a restart. Same order as performDisconnect: firewall first, then the tunnel.
 *
 * Must run AFTER detectExistingConnection (which sets activeProtocol, so disconnect()
 * picks the matching teardown verb) and BEFORE healStrandedKillSwitch (which would
 * otherwise see connected: true and skip). It leaves nothing for that heal to do on
 * this path, but the heal still covers the case where no tunnel survived at all.
 */
export async function healOrphanedTunnel(): Promise<void> {
  // Always runs, including on a launch that finds no interface: a crash in local-proxy
  // mode leaves a core and no interface at all, and in tunnel mode the stale sntl-tun
  // is torn down by detectExistingConnection before we get here, which takes the
  // interface away but not the process behind it.
  const reapedProxyChild = await reapOrphanedProxyChildren()

  if (getConnectionStatus().connected && !activeSessionId) {
    console.log('[startup] Tunnel survived a previous run with no session behind it — closing it')
    await revertPostConnectSettings()
    await disconnect()
    orphanedTunnelClosed = true
  } else if (reapedProxyChild) {
    // A reaped core is the same story from the user's side: a tunnel a previous run
    // left running is now closed.
    orphanedTunnelClosed = true
  }

  // The tray must be told, explicitly. createTrayIcon() builds its icon from
  // getConnectionStatus() and runs BEFORE this finishes (the teardown waits on a
  // privileged round-trip, which on the pkexec path is a password dialog), so it
  // caches "connected" off the very interface we are about to delete. Nothing else
  // corrects it: the tray only ever updates on a push, unlike the renderer, which
  // re-polls every 3s and settles on its own. Observed live 2026-08-26 as an idle
  // window, the orphan banner, and a green tray dot, all at the same time.
  // Idempotent, and harmlessly a no-op when the listener is not registered yet —
  // that ordering means createTrayIcon() reads the settled state for itself.
  notifyTraySettled()
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
  // Both hops of a chain carry the same stream, so both accrue the same usage and
  // both need a floor — otherwise the exit hop's gauge collapses to the lagging
  // chain figure the moment the tunnel goes down.
  for (const id of [activeSessionId, activeExitSessionId]) {
    if (id) rememberUsageFor(id)
  }
  if (activeSessionId || activeExitSessionId) saveSessionUsage()
}

function rememberUsageFor(sessionId: string): void {
  // readTunnelBytes(), not getTrafficStats(): the latter mutates the speed baseline
  // as a side effect, and only this one returns null instead of a misleading zero
  // when the interface has already gone. Bytes are clamped at the last confirmed
  // sign of life exactly as the duration below is — same rule, same reason.
  const live = readTunnelBytes() ?? aliveBytes
  const baseline = (lastKnownSessions as SessionInfo[]).find((s) => s?.id === sessionId)
  const baseDown = parseInt(baseline?.downloadBytes || '0', 10) || 0
  const baseUp = parseInt(baseline?.uploadBytes || '0', 10) || 0
  lastSessionUsage.set(sessionId, {
    downloadBytes: String(baseDown + live.rx),
    uploadBytes: String(baseUp + live.tx),
    // Duration lags the same way bytes do — the node's final proof lands after we
    // disconnect — so remember it too, or the time gauge jumps backwards.
    //
    // Counted only up to `aliveUntilMs`, the last moment the tunnel was seen carrying
    // traffic. The chain meters `duration` from the node's proofs, and a node that has
    // stopped answering submits none, so counting wall-clock past that point would
    // record time the user was never charged for — and, since this value is a floor
    // under the quota gauge, would end a session that still had paid time on it.
    durationSeconds: (baseline?.durationSeconds ?? 0) + connectedSecondsAlive(),
  })
}

/**
 * How long the CURRENT tunnel has been up AND working, in seconds. Clamped at the
 * last confirmed sign of life so a stalled tunnel stops accruing usage; see
 * checkTunnelStalled for how that moment is established.
 */
function connectedSecondsAlive(): number {
  if (!connectedAtMs) return 0
  const until = Math.max(aliveUntilMs, connectedAtMs)
  return Math.max(0, (Math.min(Date.now(), until) - connectedAtMs) / 1000)
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

    stopRootTunnelMonitor()
    stopQuotaWatchdog()
    await revertPostConnectSettings()
    await disconnect()
    activeV2ray = null
    activeWg = null
    activeXrayConfig = null
    activeHysteria2Config = null
    activeAmneziaWgConfig = null
    activeOpenVpnConfig = null
    desiredProtocol = null
    desiredMode = 'tunnel'
    activeSessionId = null
    activeNodeInfo = null
    activeExitSessionId = null
    activeExitNodeInfo = null
    activeQuota = null
    activeExitQuota = null
    // This is also what the expiry banner's "Restore internet" button calls, so
    // clearing the notice here is what dismisses it once traffic is back.
    lastExpiry = null
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
  stopRootTunnelMonitor()
  stopQuotaWatchdog()
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

  if (decision.action === 'abort') {
    // Auto-reconnect is off and the tunnel dropped on its own: nothing else is going
    // to clean up after it. Returning here left main believing it was still
    // connected — activeSessionId set, connectedAtMs running, the quota watchdog
    // ticking against an interface that no longer existed — so every second until
    // the user next pressed Disconnect was recorded as session usage and persisted
    // as a floor the chain can never undercut. Stand it down the way a stall does,
    // which remembers the usage and leaves the kill switch to the user's setting.
    if (decision.reason === 'auto-reconnect-off') {
      console.log('[reconnect] Auto-reconnect is off and the tunnel dropped — standing the session down')
      await standDownSession('dropped')
      return
    }
    // Nothing else broadcasts here, so a ladder that aborts mid-flight (e.g. the
    // user switched auto-reconnect off between attempts) would strand the tray on
    // its "connecting" badge. give-up doesn't need this — both its exits below end
    // in a sendStateChange.
    notifyTraySettled()
    return
  }
  if (decision.action === 'give-up') {
    console.log('[reconnect] Max attempts reached, giving up')
    // When the node cut the tunnel slightly before our own estimate said it would,
    // the interface monitor fires first and burns through the attempts — so a
    // give-up this close to the cap is an expiry, and the user deserves the honest
    // reason rather than a generic connection failure.
    const scored = currentQuotaVerdict()
    if (scored && (scored.verdict.level === 'expired' ||
      (scored.verdict.level === 'warn' && scored.verdict.pct >= QUOTA_GIVE_UP_PCT))) {
      await standDownSession(scored.verdict.reason, scored.sessionId)
      return
    }
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
        // Replayed verbatim — no handshake here, deliberately (auto-reconnect must
        // not renew anything on its own). So the peer behind it is unconfirmed, the
        // same as the manual fallback path.
        nodeIssuedFreshPeer = false

        // Re-establish the tunnel
        if (saved.protocol === 'wireguard') {
          await connectWireGuardFromConfig(saved.configString)
        } else if (saved.protocol === 'openvpn') {
          await connectOpenVpnFromConfig(saved.configString)
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
          // A reconnect replays a saved config, so the detailed failure + the
          // "node may have changed configuration" hint apply here too (this
          // used to say only 'Proxy failed to start on reconnect').
          await assertProxyChildStarted(
            saved.protocol === 'hysteria2' ? 'Hysteria2' : saved.protocol === 'xray' ? 'Xray' : 'V2Ray',
            true,
          )
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
          await applyPostConnectSettings(saved.protocol as 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn')
          // An auto-reconnect that brings up a tunnel the node won't answer is worse
          // than one that fails: it stops the retry ladder and parks the user on a
          // dead connection labelled "connected". Throwing feeds the catch below,
          // which schedules the next attempt.
          await assertTunnelCarriesTraffic()
        }

        console.log('[reconnect] Success')
        reconnectAttempt = 0
        // desiredMode is replayed, not overwritten: passing it back through
        // keeps a proxy-mode session in proxy mode.
        finalizeTunnelConnect(saved.protocol as ConnectProtocol, desiredMode)
      } catch (err) {
        console.error('[reconnect] Failed:', err)
        // Tear the half-built tunnel down before the next attempt. Every failure
        // above this point can leave a spawned core (and its SOCKS listener)
        // behind, and the next attempt spawns another one on top: N failed
        // attempts leak N cores. Measured live 2026-08-20 by killing v2ray with
        // the kill switch armed - four v2ray processes all bound to
        // 127.0.0.1:1080, of which main still tracked only the last, so the
        // user's Disconnect reaped one of four and the rest kept serving the
        // port. The connect path has always done this at its own bring-up
        // failure (finishChildProxyConnect); the retry ladder never did.
        // disconnect(), NOT teardownToIdle(): the latter resets reconnectAttempt,
        // which would stop the ladder from ever giving up.
        try {
          await disconnect()
        } catch (cleanupErr) {
          // Best effort: a failed teardown must not become an unhandled
          // rejection and must not stop the retry ladder.
          console.error('[reconnect] Cleanup after a failed attempt failed:', cleanupErr)
        }
        attemptReconnect()
      }
    })
  }, decision.delayMs)
}

// ---- Shared bring-up helpers ----------------------------------------------

type ConnectProtocol = 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'

/**
 * The invariant tail of every successful bring-up: record intent
 * (desiredProtocol/desiredMode), start the root-tunnel monitor and the quota
 * watchdog, publish 'connected'. All six protocol branches, proxy mode and the
 * reconnect success path end here — funneling the tail through one function is
 * what enforces "every tunnel bring-up calls startQuotaWatchdog()" structurally
 * instead of by hand-counted call sites.
 */
function finalizeTunnelConnect(protocol: ConnectProtocol, mode: 'tunnel' | 'proxy'): void {
  desiredProtocol = protocol
  desiredMode = mode
  // Watches the interface for the root protocols and the default route for the
  // tun2socks ones; a no-op in proxy mode, which changes no routing.
  if (mode !== 'proxy') startRootTunnelMonitor()
  startQuotaWatchdog()
  sendStateChange('connected')
}

const CHILD_PROXY_STARTUP_MS = 1500
const SAVED_CONFIG_HINT =
  '\n\nThis node may have changed its configuration or gone offline since you last connected. Remove this session and subscribe again to pick a working node.'

/**
 * Wait out core startup and throw a detailed error if the child died. Every
 * spawn-wait site goes through here, and the predicate MUST stay
 * isProxyChildAlive() — pointed at the traffic predicate this fails every
 * tunnel-mode connect while the tun-up polkit dialog is open (see CLAUDE.md).
 *
 * The wait is a readiness poll, not a flat sleep: it returns the moment the
 * core's SOCKS listener accepts (typically a few hundred ms) and only a core
 * that never listens waits out the full window — same cap, so a config the
 * core rejects still gets caught by the liveness check below.
 */
async function assertProxyChildStarted(
  label: 'V2Ray' | 'Xray' | 'Hysteria2',
  fromSavedConfig: boolean,
): Promise<void> {
  await waitForChildProxyListener(CHILD_PROXY_STARTUP_MS)
  if (isProxyChildAlive()) return
  const errMsg = getV2RayError()
  // When replaying a saved config (reconnect), a failure to start usually means
  // the node changed its configuration (e.g. switched protocols) or went
  // offline since the config was saved — point the user at the fix.
  const hint = fromSavedConfig ? SAVED_CONFIG_HINT : ''
  throw new Error(
    `${label} process exited immediately after starting.` + hint +
    (errMsg ? `\n\n${label} error:\n${errMsg.slice(0, 500)}` : '\n\nNo error output captured.')
  )
}

/**
 * Everything after the core has been spawned, shared by the v2ray/xray/
 * hysteria2 CONNECTION_CONNECT branches: verify the child survived startup,
 * then (tunnel mode only) bring up tun2socks + post-connect settings and prove
 * the tunnel carries traffic. In local-proxy mode there is no TUN and no
 * system state to change: the kill switch and dns-set are deliberately
 * skipped, so proxy mode leaks by design (only apps pointed at the SOCKS
 * address are tunneled) and the kill-switch setting is intentionally ignored.
 */
async function finishChildProxyConnect(opts: {
  protocol: 'v2ray' | 'xray' | 'hysteria2'
  label: 'V2Ray' | 'Xray' | 'Hysteria2'
  proxyOnly: boolean
  fromSavedConfig: boolean
}): Promise<void> {
  await assertProxyChildStarted(opts.label, opts.fromSavedConfig)
  if (!opts.proxyOnly) {
    // The core is running — bring up the TUN interface. If this fails the
    // child is still running, so tear it down rather than orphan a SOCKS proxy.
    try {
      await bringUpV2RayTunnel()
    } catch (err) {
      await disconnect()
      throw err
    }
    await applyPostConnectSettings(opts.protocol)
    await assertTunnelCarriesTraffic()
  }
  finalizeTunnelConnect(opts.protocol, opts.proxyOnly ? 'proxy' : 'tunnel')
}

async function fetchNodesPage(page: number): Promise<NodesPage> {
  const url = page === 1 ? NODES_API : `${NODES_API}?page=${page}`
  const response = await net.fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Node API returned ${response.status}`)
  return parseNodesPage(await response.json())
}

async function fetchNodes(): Promise<unknown[]> {
  // The feed is paginated at a fixed 200/page (no perPage/limit override is
  // honoured), so the whole list is ~10 requests. Page 1 tells us how many
  // there are; the rest go out together, because sequentially they'd take
  // longer than the 60s refresh interval they run on.
  const first = await fetchNodesPage(1)
  const rest = await Promise.all(
    Array.from({ length: Math.min(first.lastPage, MAX_NODE_PAGES) - 1 }, (_, i) => fetchNodesPage(i + 2)),
  )
  const nodes = normalizeNodes([first, ...rest].flatMap((p) => p.nodes))
  // Cache node metadata for session enrichment and the smart-connect join
  cachedNodes = toCachedNodeMeta(nodes)
  // Update shared cache: in-memory, disk, and broadcast to all renderer windows
  nodesMemoryCache = { nodes, fetchedAt: Date.now() }
  saveNodesCache(nodes)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.NODES_UPDATE, nodes)
  }
  return nodes
}

/**
 * Seed the in-memory node cache from disk at app startup so the first IPC call
 * (and session enrichment via getNodeMeta) has data immediately, without waiting
 * for the network. Safe to call before the first BrowserWindow exists.
 */
export function bootstrapNodesCache(): void {
  const disk = loadNodesCache()
  if (!disk) return
  // Normalized again on the way in: a cache file written before this existed
  // still has the nulls.
  disk.nodes = normalizeNodes(disk.nodes)
  nodesMemoryCache = disk
  cachedNodes = toCachedNodeMeta(disk.nodes)
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

/**
 * Sessions this app bought from a wallet that is NOT the active one — i.e. the exit
 * hop of a per-hop-wallet chain. Queried per foreign account and filtered back down
 * to the ids we recorded, so the tab never shows unrelated sessions that happen to
 * exist on the user's other wallets.
 *
 * Best-effort: an account we cannot read simply contributes nothing, exactly as an
 * unreachable RPC does for the active wallet.
 */
async function readAllSessions(client?: SentinelClient): Promise<SessionInfo[]> {
  return [...await getActiveSessions(client), ...await getOtherWalletSessions()]
}

/**
 * Every session this app holds, across every wallet that paid for one.
 *
 * EVERY writer of `lastKnownSessions` must use `readAllSessions`, not
 * `getActiveSessions`. WALLET_SESSIONS returns that cache verbatim while a tunnel is
 * up, so a writer that only reads the active wallet primes it without the exit hop of
 * a per-hop-wallet chain — and the tab then shows one lonely row badged "partner
 * gone" for as long as the chain is connected, with no way to see or end the other
 * half. Live: entry #55268780 (wallet Test) showed, exit #55268795 (wallet Third) did
 * not, both ACTIVE on chain throughout. Same trap as decorateSessionRow, one layer down.
 */
async function getOtherWalletSessions(): Promise<SessionInfo[]> {
  const owned = listSessionsOwnedByOtherWallets()
  if (owned.length === 0) return []
  const activeId = getActiveWalletId()
  const wanted = new Set(owned.filter((o) => o.walletId !== activeId).map((o) => o.sessionId))
  if (wanted.size === 0) return []

  const entries = listWallets()
  const addresses = new Set(
    owned
      .filter((o) => o.walletId !== activeId)
      .map((o) => entries.find((w) => w.id === o.walletId)?.address)
      .filter((a): a is string => typeof a === 'string' && a !== ''),
  )
  const perAccount = await Promise.all(
    [...addresses].map((a) => getSessionsForAddress(a).catch(() => [] as SessionInfo[])),
  )
  return perAccount.flat().filter((s) => wanted.has(s.id))
}

function getNodeMeta(nodeAddress: string): { moniker: string; country: string; type: number } {
  // First check saved session config
  // Then fall back to cached node list from API
  const node = cachedNodes.find((n) => n.address === nodeAddress)
  // type 0 = unknown, the same tag the feed uses for a node whose protocol it
  // doesn't know. Callers must treat it as "no answer", not as a protocol.
  return { moniker: node?.moniker || '', country: node?.country || '', type: node?.type ?? 0 }
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
  // Bring forward what the last run measured, so the Sessions gauges don't reset to
  // a not-yet-settled chain figure on relaunch. Pruned on the first sessions read.
  loadSessionUsage()

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
      reportRpcFailure()
      return lastKnownBalance
    }
  })

  handle(IPC.WALLET_LOGOUT, async () => {
    logout()
  })

  handle(IPC.WALLET_SESSIONS, async () => {
    // While a tunnel is up the chain is often unreachable through it, so the
    // cache is the answer. An EMPTY cache is not an answer, though: it renders
    // a live paid session as "No active sessions" for the whole connection, and
    // the tab's Refresh is deliberately disabled while connected (chainFrozen),
    // so nothing can correct it until the user disconnects. Reported live
    // 2026-08-20 on an active mainnet session with ~800MB of quota left, after
    // a startup read failed and cached []. Falling through costs one query we
    // would otherwise skip and cannot make things worse - the alternative is
    // showing nothing - and the chain does answer through a tunnel often enough
    // to be worth asking (verified through a live v2ray node the same day).
    if (isVpnActive() && lastKnownSessions.length > 0) return lastKnownSessions
    // On app startup this can run before the wallet is restored (it races the
    // first walletGetAddress); restore it here too so sessions auto-load instead
    // of returning [] until a manual Refresh.
    if (hasStoredWallet() && !getAddress()) await restoreWallet()
    try {
      // Ensure node cache is populated for enrichment
      if (cachedNodes.length === 0) {
        try { await fetchNodes() } catch { /* best-effort */ }
      }
      const sessions = await readAllSessions()
      const enriched = primeSessionsCache(sessions)
      // The chain DELETES settled sessions, so a remembered entry with no row left is
      // a session that is over — drop it rather than let the store grow forever.
      // NOT on an empty read, though: getSessionsForAddress swallows a failed query
      // and returns [], so this try/catch never sees an unreachable chain. See
      // prunableUsageIds for the live case that erased a session's whole usage.
      if (lastSessionUsage.size > 0) {
        const prunable = prunableUsageIds(
          [...lastSessionUsage.keys()],
          sessions.map((s) => s.id),
          activeSessionId,
        )
        for (const id of prunable) lastSessionUsage.delete(id)
        if (prunable.length > 0) saveSessionUsage()
      }
      return enriched
    } catch {
      // Only blame the endpoint when the path is not ours to explain: this can
      // now run with a tunnel up (the empty-cache fall-through above), and our
      // own tunnel or kill switch failing the query is not an RPC fault.
      if (!isVpnActive()) reportRpcFailure()
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
      throw new Error('Disconnect the VPN before ending a session. The chain is unreachable through the tunnel.')
    }
    // A per-hop-wallet chain's exit session belongs to a SECOND account, and
    // x/session only accepts a cancel signed by the session's own account — so
    // "End both" on such a chain has to switch signer for the second hop or the
    // cancel is rejected and the deposit is stranded.
    const saved = loadSessionConfig(sessionId)
    const ownerId = saved?.walletId
    const foreign = ownerId !== undefined && ownerId !== getActiveWalletId()
    const owner: ChainSigner = foreign
      ? { ...(await loadWalletCredentials(ownerId)), walletId: ownerId }
      : { wallet, address, privKey: new Uint8Array() }
    try {
      // Gas only — but a wallet drained to zero can't afford even that, and this is
      // the action that reclaims the deposit. Say so plainly rather than failing on chain.
      if (foreign) await assertSufficientFundsFor(owner.address, 0)
      else await assertSufficientFunds(0)
      await endSession({ wallet: owner.wallet, address: owner.address, sessionId }).catch(noteChainError)
    } finally {
      if (foreign) owner.privKey.fill(0)
      // Unconditional: a cancel that reported an error may still have landed, and a
      // re-query is how the renderer finds out either way.
      notifySessionsChanged()
    }
  })

  handle(IPC.WALLET_LIST, async () => {
    return listWallets()
  })

  // Multihop: is the wallet the user picked for the exit hop visibly funded from the
  // active one? Per-hop wallets only unlink a chain when the second account's coins
  // did not come from the first, and topping it up from the main wallet is both the
  // obvious way to fund one and the thing that undoes the entire feature.
  handle(IPC.WALLET_LINK_CHECK, async (_event, walletId: string) => {
    assertString(walletId, 'walletId')
    const active = getAddress()
    const other = listWallets().find((w) => w.id === walletId)?.address
    if (!active || !other) return { checked: false, linked: false }
    return findTransferBetween(active, other)
  })

  handle(IPC.WALLET_SWITCH, async (_event, walletId: string) => {
    assertString(walletId, 'walletId')
    const address = await switchWallet(walletId)
    // The plan overview's chain half is wallet-scoped: a stale answer must
    // never show the previous wallet's subscriptions.
    lastPlanOverview = null
    return { address }
  })

  // `keepSeed` only applies to the last wallet: it leaves the encrypted seed on
  // disk so new wallets can be derived from it without retyping the phrase.
  handle(IPC.WALLET_DELETE, async (_event, walletId: string, keepSeed?: boolean) => {
    assertString(walletId, 'walletId')
    deleteWalletEntry(walletId, { keepSeed: keepSeed === true })
  })

  handle(IPC.WALLET_DELETE_ALL, async (_event, keepSeed?: boolean) => {
    // "Start fresh" from the wallet picker, and "Remove seed" from Settings. One
    // round-trip rather than N invokes from the renderer, so a destructive op
    // can't be left half-done by a mid-loop failure in the caller. App settings
    // are deliberately untouched.
    const wallets = listWallets()
    // `keepSeed` keeps the phrase behind the ACTIVE wallet — the one the user is
    // looking at. deleteWalletEntry only retains when it's deleting the final
    // entry, so that one has to go last.
    const activeId = loadSettings().activeWalletId
    const retainId = keepSeed === true
      ? (wallets.find((w) => w.id === activeId)?.id ?? wallets[0]?.id ?? null)
      : null

    for (const wallet of wallets) {
      if (wallet.id !== retainId) deleteWalletEntry(wallet.id)
    }
    if (retainId) deleteWalletEntry(retainId, { keepSeed: true })
    if (keepSeed !== true) clearRetainedSeed()
    logout()
  })

  // What's on disk, regardless of whether a wallet is currently active — the
  // wallet picker's source of truth. `unlockable` is false for a seed encrypted
  // under the app's previous name (safeStorage keys its entry by app name), so
  // the picker can say so instead of offering a switch that will fail.
  handle(IPC.WALLET_STORE_STATUS, async () => {
    return {
      wallets: listWallets().map((w) => ({ ...w, unlockable: canUnlockWallet(w.id) })),
      activeWalletId: loadSettings().activeWalletId,
      retainedSeedId: loadSettings().retainedSeedId,
    }
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
    addressIndex: number
    name: string
  }) => {
    assertString(params.sourceWalletId, 'sourceWalletId')
    assertIntRange(params.accountIndex, 'accountIndex', 0, 2147483647)
    assertIntRange(params.addressIndex, 'addressIndex', 0, 2147483647)
    assertString(params.name, 'name')
    if (params.name.length > 100) throw new Error('Wallet name too long')
    const address = await deriveSubaccount(
      params.sourceWalletId,
      params.accountIndex,
      params.addressIndex,
      params.name,
    )
    return { address }
  })

  // Read-only: what the seed WOULD derive at a run of address indices, so the
  // derive modal can grey out the paths already stored. `count` is bounded
  // because each entry is a full key derivation.
  handle(IPC.WALLET_DERIVE_PREVIEW, async (_event, params: {
    sourceWalletId: string
    accountIndex: number
    startIndex: number
    count: number
  }) => {
    assertString(params.sourceWalletId, 'sourceWalletId')
    assertIntRange(params.accountIndex, 'accountIndex', 0, 2147483647)
    assertIntRange(params.startIndex, 'startIndex', 0, 2147483647)
    assertIntRange(params.count, 'count', 1, DERIVE_PREVIEW_MAX_COUNT)
    return previewDerivations(params.sourceWalletId, params.accountIndex, params.startIndex, params.count)
  })

  // Hands the seed phrase to the renderer for the user to write down. Safe only
  // because the renderer is contextIsolated + sandboxed and handle() rejects any
  // frame that isn't ours. Never log the result, and never cache it here.
  handle(IPC.WALLET_REVEAL_MNEMONIC, async (_event, walletId: string) => {
    assertString(walletId, 'walletId')
    return { mnemonic: getWalletMnemonic(walletId) }
  })

  // Settings
  handle(IPC.SETTINGS_GET, async () => {
    return loadSettings()
  })

  handle(IPC.SETTINGS_SET, async (_event, settings: Record<string, unknown>) => {
    if (typeof settings !== 'object' || settings === null) throw new Error('Invalid settings')
    // Only allow known setting keys
    const allowed = new Set([
      'rpcEndpoint', 'rpcMode', 'activeWalletId', 'killSwitch', 'lanSharing', 'dnsResolver', 'autoReconnect',
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
    if (filtered.rpcMode !== undefined && filtered.rpcMode !== 'auto' && filtered.rpcMode !== 'manual') {
      throw new Error('Invalid rpcMode')
    }
    if (filtered.activeWalletId !== undefined && filtered.activeWalletId !== null) {
      assertString(filtered.activeWalletId, 'activeWalletId')
    }
    if (filtered.killSwitch !== undefined && typeof filtered.killSwitch !== 'boolean') {
      throw new Error('Invalid killSwitch: expected boolean')
    }
    if (filtered.lanSharing !== undefined && typeof filtered.lanSharing !== 'boolean') {
      throw new Error('Invalid lanSharing: expected boolean')
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
    const saved = saveSettings(filtered as Parameters<typeof saveSettings>[0])
    // Every chain call reads the endpoint fresh, so the switch is already live —
    // re-probe now so the indicator reflects the new endpoint immediately
    // instead of up to 30s later.
    if (filtered.rpcEndpoint !== undefined) onRpcEndpointChanged()
    // Flipping to auto runs the selection right away. This also covers the case
    // where the endpoint in use is already published as down: no new fault
    // transition will ever fire for it, so this flip is its only trigger.
    if (filtered.rpcMode === 'auto') void runAutoRpcSelection()
    // Apply the firewall change now rather than at the next connect. Fire-and-
    // forget under the lock so the toggle returns immediately instead of queueing
    // behind an in-flight connect; failures surface through killSwitchFailed on
    // the connection status, the same path the connect-time arm uses.
    if (filtered.killSwitch !== undefined || filtered.lanSharing !== undefined) {
      // Arming/disarming changes whether anything reaches the chain at all, so the
      // RPC indicator is a function of it — notably when the user turns the kill
      // switch off to end an "expired, traffic blocked" state.
      void withConnectionLock(reapplyFirewall).then(onChainPathChanged)
    }
    return saved
  })

  // Nodes
  handle(IPC.NODES_FETCH, async () => {
    return fetchNodes()
  })

  handle(IPC.NODES_GET_CACHED, async () => {
    return nodesMemoryCache
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
    if (params.nodeType !== 1 && params.nodeType !== 2 && params.nodeType !== 3 && params.nodeType !== 4 && params.nodeType !== 5 && params.nodeType !== 6) throw new Error('Unsupported nodeType: only WireGuard (1), V2Ray (2), OpenVPN (3), XRAY (4), AmneziaWG (5) and Hysteria2 (6) are connectable')
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
    // A live connection means this purchase would orphan it (see assertNotConnected).
    assertNotConnected()

    // Phase A — everything that must hold BEFORE money moves, in parallel: the
    // node's own protocol check (see preflightConnect), a fresh balance read,
    // and the one RPC connection the rest of the flow shares. Any failure
    // aborts with nothing spent and the connection closed.
    const flowPromise = openChainFlow(wallet)
    try {
      await Promise.all([
        preflightConnect(params.nodeType, params.apiField),
        // The deposit is only priced in udvpn for the udvpn denom; for any other the
        // cost is unknown here, so check the gas reserve alone and let the chain judge.
        flowPromise.then((f) => assertSufficientFunds(
          params.denom === 'udvpn' ? parseInt(params.quoteValue, 10) * params.amount : 0,
          f.query,
        )),
      ])
    } catch (err) {
      flowPromise.then((f) => f.disconnect(), () => {})
      throw err
    }
    const flow = await flowPromise

    try {
      // Subscribe on-chain. The purchase resolves the handshake endpoint from
      // the node row it fetches for prices anyway.
      const { sessionId, remoteUrl } = await subscribeToNode({
        wallet,
        address,
        nodeAddress: params.nodeAddress,
        apiField: params.apiField,
        type: params.type,
        amount: params.amount,
        denom: params.denom,
        clients: { query: flow.query, signing: flow.signing },
      }).catch(noteChainError)

      // Pre-cache sessions CONCURRENTLY with the handshake: the row exists from
      // the moment the tx commits, and RPC is still reachable (the tunnel goes
      // up in the follow-up connect call). Applied only after the handshake
      // succeeds, so a refunded session never primes the cache or the quota.
      const sessionsPromise = readAllSessions(flow.query).catch(() => null)

      // Handshake. On ANY failure the just-created session is auto-cancelled
      // (refund) instead of orphaning the deposit (H1).
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
        remoteUrl,
      })

      applySession(sessionId, params.nodeAddress, params.nodeMoniker, params.nodeCountry, params.nodeType, result)

      const sessions = await sessionsPromise
      if (sessions) {
        primeSessionsCache(sessions)
        setQuota(sessions.find((s) => s.id === sessionId))
      }

      // The chain row was unreadable or hadn't appeared yet — fall back to what the
      // user just bought. A session created seconds ago has metered nothing, so both
      // baselines are 0.
      if (!activeQuota) {
        activeQuota = {
          sessionId,
          maxDurationSeconds: params.type === 'hours' ? params.amount * 3600 : null,
          baselineDurationSeconds: 0,
          maxBytes: params.type === 'gigabytes' ? params.amount * 1024 ** 3 : 0,
          baselineBytes: 0,
        }
        quotaWarned = false
      }

      return {
        sessionId,
        protocol: result.protocol,
        configString: result.configString,
      }
    } finally {
      flow.disconnect()
    }
  })

  // Connection: buy and handshake a two-hop (multihop) chain.
  //
  // Both hops are direct per-GB/per-hour purchases of the SAME size — a chain is only
  // as long-lived as its shorter half, so buying asymmetric halves would just waste
  // the larger one. Everything after the two purchases is establishChainOrRefund's
  // job, including cancelling BOTH deposits if anything fails.
  handle(IPC.CONNECTION_SUBSCRIBE_CHAIN, async (_event, params: {
    entry: { nodeAddress: string; nodeMoniker: string; nodeCountry: string; nodeType: number; apiField: string; quoteValue: string }
    exit: { nodeAddress: string; nodeMoniker: string; nodeCountry: string; nodeType: number; apiField: string; quoteValue: string }
    type: 'gigabytes' | 'hours'
    amount: number
    denom: string
    /** Pay for the exit hop from this wallet instead of the active one. */
    exitWalletId?: string
  }) => {
    if (params.type !== 'gigabytes' && params.type !== 'hours') throw new Error('Invalid type')
    if (params.exitWalletId !== undefined) assertString(params.exitWalletId, 'exitWalletId')
    assertNumber(params.amount, 'amount', 1, 1000)
    assertString(params.denom, 'denom')

    for (const [role, hop] of [['entry', params.entry], ['exit', params.exit]] as const) {
      if (!hop || typeof hop !== 'object') throw new Error(`Missing ${role} hop`)
      assertSentAddress(hop.nodeAddress, `${role}.nodeAddress`)
      assertString(hop.nodeMoniker, `${role}.nodeMoniker`)
      assertString(hop.nodeCountry, `${role}.nodeCountry`)
      assertString(hop.apiField, `${role}.apiField`)
      assertString(hop.quoteValue, `${role}.quoteValue`)
      if (!/^\d+$/.test(hop.quoteValue)) throw new Error(`Invalid ${role}.quoteValue`)
      // Chaining is a v2ray-core feature (proxySettings.tag); no other protocol can do it.
      if (hop.nodeType !== 2 && hop.nodeType !== 4) {
        throw new Error(`Multihop ${role} must be a V2Ray (2) or XRAY (4) node. No other protocol can be chained.`)
      }
    }
    if (params.entry.nodeAddress === params.exit.nodeAddress) {
      throw new Error('Multihop entry and exit must be different nodes')
    }

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) {
      throw new Error('Wallet not loaded. Please re-import your mnemonic.')
    }
    // Two purchases would orphan the live connection just the same as one.
    assertNotConnected()

    // Verify the ENTRY and our runtime before spending anything.
    //
    // The EXIT's two checks are deliberately NOT here any more: asking the exit node
    // anything from this device is the leak the chain exists to prevent, so they run
    // inside establishChainOrRefund, through the entry hop, once it is live. The cost
    // is that a bad exit is discovered after the entry is paid for rather than before;
    // the picker already refuses an exit without positive evidence, so what remains is
    // a backstop against a node that changed since it was graded.
    await preflightConnect(params.entry.nodeType, params.entry.apiField)
    // ...and the CHAIN policy too, which preflightConnect knows nothing about: it
    // checks that a node runs the protocol the directory claims, not that the node can
    // be an end of a chain. Without this a node that cannot be wrapped in TLS is bought
    // first and refused at the handshake, which is a refund the user should never have
    // needed. That is not hypothetical — a v8.3.1 entry did exactly this, and the
    // refund of the pair then failed on its own bug.
    await assertChainEligible(params.entry, 'entry')

    const hopCost = (quoteValue: string): number =>
      params.denom === 'udvpn' ? parseInt(quoteValue, 10) * params.amount : 0

    const activeSigner: ChainSigner = { wallet, address, privKey, walletId: getActiveWalletId() ?? undefined }
    // Per-hop wallets: paying for the two hops from two accounts is what stops
    // either node reading `Session.accAddress` and finding the other half of the
    // chain via the public SessionsForAccount query. The second wallet is only ever
    // one the user already has — the app never creates or funds one, because an
    // in-app transfer between them is itself a public on-chain link and would put
    // the pairing straight back.
    let exitSigner: ChainSigner = activeSigner
    if (params.exitWalletId && params.exitWalletId !== getActiveWalletId()) {
      const creds = await loadWalletCredentials(params.exitWalletId)
      exitSigner = { ...creds, walletId: params.exitWalletId }
    }
    const separateWallets = exitSigner !== activeSigner

    try {
      // Each account pays only for its own hop, so they are checked separately —
      // summing them against one balance would pass a wallet that cannot afford the
      // hop it is actually buying.
      if (separateWallets) {
        await assertSufficientFunds(hopCost(params.entry.quoteValue))
        await assertSufficientFundsFor(exitSigner.address, hopCost(params.exit.quoteValue))
      } else {
        await assertSufficientFunds(hopCost(params.entry.quoteValue) + hopCost(params.exit.quoteValue))
      }

    const toHop = (h: typeof params.entry) => ({
      nodeAddress: h.nodeAddress, nodeType: h.nodeType, apiField: h.apiField,
      nodeMoniker: h.nodeMoniker, nodeCountry: h.nodeCountry,
    })

    const result = await establishChainOrRefund({
      entry: toHop(params.entry),
      exit: toHop(params.exit),
      startSession: (hop, signer) =>
        subscribeToNode({
          wallet: signer.wallet, address: signer.address, nodeAddress: hop.nodeAddress,
          apiField: hop.apiField,
          type: params.type, amount: params.amount, denom: params.denom,
        }).then((r) => r.sessionId).catch(noteChainError),
      entrySigner: activeSigner,
      exitSigner,
    })

    const entryHop: ChainHopInput = { ...toHop(params.entry), sessionId: result.entrySessionId }
    const exitHop: ChainHopInput = { ...toHop(params.exit), sessionId: result.exitSessionId }
    applyChainSession(entryHop, exitHop, result.configString)

    // Same best-effort quota baseline as the single-hop path, for both sessions.
    try {
      const sessions = await readAllSessions()
      primeSessionsCache(sessions)
      setQuota(sessions.find((s) => s.id === result.entrySessionId))
      const exitRow = sessions.find((s) => s.id === result.exitSessionId)
      activeExitQuota = exitRow ? quotaFromSessionRow(exitRow) : null
    } catch { /* best-effort */ }

    // Fall back to what was just bought when the chain rows aren't readable yet.
    const purchasedQuota = (sessionId: string): ActiveQuota => ({
      sessionId,
      maxDurationSeconds: params.type === 'hours' ? params.amount * 3600 : null,
      baselineDurationSeconds: 0,
      maxBytes: params.type === 'gigabytes' ? params.amount * 1024 ** 3 : 0,
      baselineBytes: 0,
    })
    if (!activeQuota) {
      activeQuota = purchasedQuota(result.entrySessionId)
      quotaWarned = false
    }
    if (!activeExitQuota) activeExitQuota = purchasedQuota(result.exitSessionId)

      return {
        sessionId: result.entrySessionId,
        exitSessionId: result.exitSessionId,
        protocol: result.protocol,
        configString: result.configString,
      }
    } finally {
      // The second wallet's key is derived here and tracked by nothing, so unlike the
      // active wallet's (which setPrivKey owns) there is no other code that will ever
      // wipe it. Zero it on every path, including the refund path.
      if (separateWallets) exitSigner.privKey.fill(0)
    }
  })

  // Connection: Reconnect to existing session using saved config
  handle(IPC.CONNECTION_RECONNECT, async (_event, params: {
    sessionId: string
  }) => {
    assertString(params.sessionId, 'sessionId')
    if (!/^\d+$/.test(params.sessionId)) throw new Error('Invalid session ID')
    // Before any state is mutated: reconnecting one session while another is
    // carrying traffic would clobber the live session's tracking below.
    assertNotConnected()
    const saved = loadSessionConfig(params.sessionId)
    if (!saved) {
      throw new Error(
        'No saved config for this session. The handshake config was not preserved, so ' +
        'this session cannot be reconnected. You will need to create a new subscription.'
      )
    }
    // A record with no config string is a TOMBSTONE left by retireSessionConfig: the
    // session was ended and its credentials cleared, keeping only the chain pairing
    // so the Sessions tab can still draw the two hops as one card while they settle.
    // The UI hides the action on an ended session, so reaching here means something
    // raced the chain — say what happened rather than bringing up an empty config.
    if (!saved.configString) {
      throw new Error(
        'This session has ended and its credentials were cleared, so it cannot be ' +
        'reconnected. Buy a new session to connect again.'
      )
    }

    activeSessionId = saved.sessionId
    // Populate node info from saved config; fall back to cached node list
    const nodeMeta = getNodeMeta(saved.nodeAddress)
    const nodeType = saved.protocol === 'wireguard' ? 1 : saved.protocol === 'openvpn' ? 3 : saved.protocol === 'xray' ? 4 : saved.protocol === 'hysteria2' ? 6 : saved.protocol === 'amneziawg' ? 5 : 2
    activeNodeInfo = {
      address: saved.nodeAddress,
      moniker: saved.nodeMoniker || nodeMeta.moniker || '',
      country: saved.nodeCountry || nodeMeta.country || '',
      type: nodeType,
    }

    // A multihop chain must NEVER take the single-hop renewal path below: that would
    // re-handshake this one node, build a one-hop config from it and connect with it
    // while both sessions were still paid — dropping a hop without saying so. On the
    // exit hop's record it would connect straight to the exit node, giving it the real
    // IP the chain existed to hide. There is also nothing useful to renew: a chain's
    // peers live on two nodes, and the 409 rule below means neither would re-issue one.
    // So replay the saved chained config and restore BOTH halves of the runtime state.
    if (saved.chainPeerSessionId) {
      const peer = loadSessionConfig(saved.chainPeerSessionId)
      if (!peer) {
        throw new Error(
          `This session is one hop of a two-hop chain, but the other hop ` +
          `(#${saved.chainPeerSessionId}) has no saved config, so the chain cannot be ` +
          'rebuilt. End both sessions and build a new chain.',
        )
      }
      // The chained config is stored identically under both ids, so whichever hop the
      // user clicked, entry must stay entry — take that from the recorded role.
      const entrySaved = saved.chainRole === 'exit' ? peer : saved
      const exitSaved = saved.chainRole === 'exit' ? saved : peer
      // `type` here is the NODE's own protocol, which is not the same thing as the
      // binary the chain runs on. A chain is always executed by xray (it is a strict
      // superset of what we emit), but both hops are usually plain V2Ray nodes —
      // hardcoding 4 here put "XRAY" in the connected bar for a chain of two V2Ray
      // nodes. The saved record carries the real tag; a record written before it did
      // falls back to the node directory, and only then to V2Ray.
      const hopType = (saved: { nodeAddress: string; nodeType?: number }): number =>
        saved.nodeType ?? (getNodeMeta(saved.nodeAddress).type || 2)
      activeSessionId = entrySaved.sessionId
      activeNodeInfo = {
        address: entrySaved.nodeAddress,
        moniker: entrySaved.nodeMoniker || getNodeMeta(entrySaved.nodeAddress).moniker || '',
        country: entrySaved.nodeCountry || getNodeMeta(entrySaved.nodeAddress).country || '',
        type: hopType(entrySaved),
      }
      activeExitSessionId = exitSaved.sessionId
      activeExitNodeInfo = {
        address: exitSaved.nodeAddress,
        moniker: exitSaved.nodeMoniker || getNodeMeta(exitSaved.nodeAddress).moniker || '',
        country: exitSaved.nodeCountry || getNodeMeta(exitSaved.nodeAddress).country || '',
        type: hopType(exitSaved),
      }
      activeXrayConfig = saved.configString
      // Same reasoning as the fallback return below: this config was minted earlier and
      // has not been reconfirmed by either node.
      nodeIssuedFreshPeer = false
      return {
        sessionId: entrySaved.sessionId,
        protocol: 'xray' as const,
        configString: saved.configString,
      }
    }

    // Ask for a fresh peer before falling back to the saved config. The saved config
    // is only valid for as long as the NODE keeps the peer it created at handshake
    // time, and it does not keep it forever: mainnet #53647217 was verified — by
    // sending a well-formed WireGuard initiation with the saved config's own keys —
    // to get no answer at all, hours after the node had stopped reporting usage.
    //
    // Read the 409 branch below before touching this: a dvpnx node will NOT re-issue
    // a peer for a session it still has a record for, and it only deletes that record
    // once the CHAIN has deleted the session (workers/session.go deleteSessionFunc
    // fires on `session == nil` alone). Every session we offer a reconnect for is
    // chain-active, so the usual answer here is a conflict and the saved config.
    // The renewal therefore only wins in the narrow case where the node lost its own
    // record — a reset or a rebuilt database — while the session lived on. It is kept
    // for that case and because it is cheap; the actual dead-peer safety net is
    // assertTunnelCarriesTraffic, which refuses to report a tunnel nothing comes back
    // through, whichever config built it.
    //
    // One HTTPS call for a session already paid for. No tx, so deliberately NOT
    // wrapped in establishSessionOrRefund — there is no new session to refund, and
    // cancelling the user's live session because a node was briefly unreachable
    // would be the opposite of the intent.
    const privKey = getPrivKey()
    if (privKey) {
      try {
        const fresh = await performHandshake({
          sessionId: saved.sessionId,
          nodeAddress: saved.nodeAddress,
          nodeType,
          // '' → resolve from the chain's remoteAddrs, which is where a reconnect's
          // endpoint has to come from (there is no renderer-supplied apiField here).
          remoteUrl: await resolveNodeRemoteUrl(saved.nodeAddress, ''),
          privKey,
          nodeMoniker: saved.nodeMoniker,
          nodeCountry: saved.nodeCountry,
        })
        applySession(saved.sessionId, saved.nodeAddress, saved.nodeMoniker || '', saved.nodeCountry || '', nodeType, fresh)
        return {
          sessionId: saved.sessionId,
          protocol: fresh.protocol,
          configString: fresh.configString,
        }
      } catch (err) {
        const { status, message } = describeNodeApiError(err)
        if (status === 409) {
          // Expected, and not a failure by itself. A dvpnx node's handshake handler
          // looks its own database up by session id before doing anything else and
          // answers 409 Conflict if a record exists (api/handshake/handlers.go: error
          // codes 1 "maximum peer limit", 3 "session already exists in database" and
          // 4 "session already exists for peer request" are all 409). It never
          // re-issues a peer for a session it already holds.
          //
          // A conflict says the node still holds the RECORD. It says nothing about
          // the PEER — do not read it as one implying the other, which is what this
          // comment used to claim. workers/session.go drops the peer on four triggers
          // (max bytes, max duration, chain session nil, chain status not active) and
          // deletes the record on the last of those alone, so "record, no peer" is an
          // ordinary steady state and a permanent one: no route on the node clears
          // that record while the chain session lives. Replaying the saved config is
          // then the only move available, but it may well be a dead one — see the
          // nodeIssuedFreshPeer note on the fallback return below.
          console.log(`[reconnect] node still holds session #${saved.sessionId} (${message}) — replaying the saved config`)
        } else {
          // A node that won't handshake usually won't tunnel either, but the saved
          // config is still the best remaining shot (the node's API and its data plane
          // can fail independently) — and the tunnel check now catches it if it is dead.
          console.error(
            `[reconnect] handshake renewal failed${status ? ` (HTTP ${status})` : ''}: ${message} — ` +
            'falling back to the saved config',
          )
        }
      }
    }

    // Every way of getting here — 409, a node that never answered, no wallet key to
    // sign a renewal with — replays a config the node minted at some earlier point
    // and has NOT reconfirmed. If the tunnel it builds then carries nothing, that is
    // the unrecoverable dead-peer case rather than something a retry can fix, and
    // deadTunnelMessage needs to know which of the two it is talking about.
    nodeIssuedFreshPeer = false
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
    protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'
    configString?: string
    dnsFallback?: boolean
    mode?: 'tunnel' | 'proxy'
  }) => {
    if (params.mode !== undefined && params.mode !== 'tunnel' && params.mode !== 'proxy') {
      throw new Error('Invalid mode: must be tunnel or proxy')
    }
    // Local-proxy mode = the child core's SOCKS5 listener only: no TUN, no root,
    // no routing change. WireGuard/AmneziaWG/OpenVPN have no such listener — they ARE
    // the routing change — so the mode is meaningless (and unimplementable) for them.
    const proxyOnly = params.mode === 'proxy'
    if (proxyOnly && (params.protocol === 'wireguard' || params.protocol === 'amneziawg' || params.protocol === 'openvpn')) {
      throw new Error('Local-proxy mode is not available for WireGuard, AmneziaWG or OpenVPN: they route the whole device.')
    }
    if (params.protocol !== 'wireguard' && params.protocol !== 'amneziawg' && params.protocol !== 'v2ray' && params.protocol !== 'xray' && params.protocol !== 'hysteria2' && params.protocol !== 'openvpn') {
      throw new Error('Invalid protocol: must be wireguard, amneziawg, openvpn, v2ray, xray or hysteria2')
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
    // Badge the tray before taking the lock: a connect queued behind a disconnect
    // is still a connect the user asked for, and this is the slow part (on-chain
    // tx, handshake, possibly a polkit prompt).
    notifyTrayConnecting()
    // Serialize tunnel bring-up against disconnect/reconnect so overlapping ops
    // can't orphan a child process (finding M1).
    return withConnectionLock(async () => {
      // Inside the lock, so a connect queued behind an in-flight one sees the
      // first one's tunnel and is refused instead of stacking a second on top.
      assertNotConnected()
      // A new connect supersedes whatever the last session ended as.
      lastExpiry = null
      if (params.protocol === 'wireguard') {
        const wgDns = wireguardResolverIp(loadSettings())
        if (dnsFallback || wgDns) {
          // Same config, minus DNS (the resolvconf-missing retry), or with the
          // node's DNS list swapped for the user's resolver. config-guard still
          // validates it either way (DNS is an optional key in the allow-list).
          const base = params.configString ?? activeWg?.buildConfigString()
          if (!base) throw new Error('No WireGuard instance or config available')
          await connectWireGuardFromConfig(
            // dnsFallback wins: it exists because resolvconf is missing, so ANY
            // DNS line fails the bring-up, including one we chose.
            dnsFallback || !wgDns ? stripDnsLines(base) : replaceDnsLines(base, wgDns),
          )
        } else if (activeWg) {
          await connectWireGuard(activeWg)
        } else if (params.configString) {
          await connectWireGuardFromConfig(params.configString)
        } else {
          throw new Error('No WireGuard instance or config available')
        }

        // Apply DNS and kill switch if enabled
        await applyPostConnectSettings('wireguard')
        await assertTunnelCarriesTraffic()

        finalizeTunnelConnect('wireguard', 'tunnel')
        return { protocol: 'wireguard' }
      }

      if (params.protocol === 'amneziawg') {
        // The config is the one built during the handshake (activeAmneziaWgConfig)
        // or a saved config replayed by a manual reconnect.
        const awgConfig = params.configString ?? activeAmneziaWgConfig
        if (!awgConfig) {
          throw new Error('No AmneziaWG config available')
        }
        // dnsFallback wins: it exists because resolvconf is missing, so ANY DNS
        // line fails the bring-up, including one we chose.
        const awgDns = wireguardResolverIp(loadSettings())
        const awgWithDns = dnsFallback ? stripDnsLines(awgConfig)
          : awgDns ? replaceDnsLines(awgConfig, awgDns)
          : awgConfig
        await connectAmneziaWgFromConfig(awgWithDns)

        await applyPostConnectSettings('amneziawg')
        await assertTunnelCarriesTraffic()

        finalizeTunnelConnect('amneziawg', 'tunnel')
        return { protocol: 'amneziawg' }
      }

      if (params.protocol === 'openvpn') {
        // The config is the one built during the handshake (activeOpenVpnConfig) or
        // a saved config replayed by a manual reconnect. No dnsFallback branch:
        // OpenVPN never touches resolvconf (that would need an --up script), so the
        // resolvconf-missing failure mode doesn't exist for it.
        const ovpnConfig = params.configString ?? activeOpenVpnConfig
        if (!ovpnConfig) {
          throw new Error('No OpenVPN config available')
        }
        await connectOpenVpnFromConfig(ovpnConfig)

        await applyPostConnectSettings('openvpn')
        await assertTunnelCarriesTraffic()

        finalizeTunnelConnect('openvpn', 'tunnel')
        return { protocol: 'openvpn' }
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
        await finishChildProxyConnect({
          protocol: 'v2ray', label: 'V2Ray', proxyOnly,
          fromSavedConfig: !activeV2ray && !!params.configString,
        })
        return { protocol: 'v2ray' }
      }

      if (params.protocol === 'xray') {
        // Xray reuses the v2ray tunnel path (child process + tun2socks). The config
        // is the one built during the handshake (activeXrayConfig), or a saved
        // config on manual reconnect (params.configString).
        const dohIp = effectiveV2RayResolverIp(loadSettings())
        const xrayConfig = params.configString ?? activeXrayConfig
        if (!xrayConfig) {
          throw new Error('No Xray config available')
        }
        connectXRayFromConfig(xrayConfig, dohIp, { proxyOnly })
        await finishChildProxyConnect({
          protocol: 'xray', label: 'Xray', proxyOnly,
          fromSavedConfig: !activeXrayConfig && !!params.configString,
        })
        return { protocol: 'xray' }
      }

      if (params.protocol === 'hysteria2') {
        // Hysteria2 reuses the v2ray tunnel path (child process + tun2socks). The
        // config is the one built during the handshake (activeHysteria2Config), or
        // a saved config on manual reconnect (params.configString). No DoH —
        // hysteria2's DNS is plaintext-through-tunnel (see connectHysteria2FromConfig).
        const hysteria2Config = params.configString ?? activeHysteria2Config
        if (!hysteria2Config) {
          throw new Error('No Hysteria2 config available')
        }
        connectHysteria2FromConfig(hysteria2Config, { proxyOnly })
        await finishChildProxyConnect({
          protocol: 'hysteria2', label: 'Hysteria2', proxyOnly,
          fromSavedConfig: !activeHysteria2Config && !!params.configString,
        })
        return { protocol: 'hysteria2' }
      }

      throw new Error('No active VPN instance')
      // The success branches already published 'connected'; this is what puts the
      // tray back to the truth when the bring-up threw instead.
    }).finally(notifyTraySettled)
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
      // This launch closed a tunnel a previous run left running. Reported alongside
      // the connection rather than on its own channel for the same reason `expired`
      // is: useConnection already polls this, so no new push is needed to surface it.
      orphanedTunnelClosed: orphanedTunnelClosed || undefined,
      sessionId: activeSessionId,
      // The active session's on-chain subscription, read off the session cache
      // (primed by every connect flow). Lets the Plans tab say "connected via
      // this plan" from chain fact instead of guessing by node membership,
      // which needed a node list the tunnel makes unreadable. Null when the
      // cache has no row (e.g. restart-then-adopt), and the label just stays
      // generic then.
      subscriptionId: activeSessionId
        ? ((lastKnownSessions as SessionInfo[]).find((s) => s?.id === activeSessionId)?.subscriptionId ?? null)
        : null,
      // MULTIHOP: present only for a two-hop chain. `nodeAddress`/`sessionId` above
      // stay the ENTRY hop; this is the exit, whose location is what the user's
      // traffic actually appears to come from.
      chainExit: activeExitNodeInfo
        ? {
            sessionId: activeExitSessionId,
            address: activeExitNodeInfo.address,
            moniker: activeExitNodeInfo.moniker,
            country: activeExitNodeInfo.country,
            type: activeExitNodeInfo.type,
          }
        : undefined,
      // When this tunnel came up. The Sessions card adds the time since to the
      // chain's metered `duration` to draw a live time gauge — the same
      // baseline-plus-live sum the quota watchdog scores against.
      connectedAt: connectedAtMs ?? undefined,
      proxyMode: vpnStatus.proxyMode || undefined,
      socksAddr: vpnStatus.socksAddr,
      reconnectAttempt: reconnectAttempt > 0 ? reconnectAttempt : undefined,
      reconnectMaxAttempts: reconnectAttempt > 0 ? RECONNECT_MAX_ATTEMPTS : undefined,
      // Why the last session ended, if it ended on its own. No new IPC channel is
      // needed: standDownSession's sendStateChange('idle') already makes
      // useConnection re-poll, which picks this up. trafficBlocked is read live
      // rather than off the captured snapshot — turning the kill switch off from
      // Settings while in this state (reapplyFirewall's 'disarm') must not leave
      // the banner claiming traffic is still blocked.
      expired: lastExpiry ? { ...lastExpiry, trafficBlocked: isKillSwitchArmed() } : undefined,
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

  handle(IPC.PLAN_OVERVIEW, async () => {
    // Plans always answer from the disk cache; only the subscription/allocation
    // half needs the chain. `stale: true` marks an answer whose chain half is a
    // memory of the last successful read (tunnel up, or the read failed) — the
    // renderer shows it as cached rather than blanking the tab.
    const cachedHalf = () => {
      const { plans, fetchedAt } = listCachedPlans()
      return {
        plans,
        fetchedAt,
        subscriptions: lastPlanOverview?.subscriptions ?? [],
        allocations: lastPlanOverview?.allocations ?? [],
        stale: true,
      }
    }
    const address = getAddress()
    if (!address) return { ...cachedHalf(), stale: false }
    if (isVpnActive()) return cachedHalf()
    try {
      const overview = await getPlanOverview(address)
      lastPlanOverview = overview
      return { ...overview, stale: false }
    } catch {
      reportRpcFailure()
      return cachedHalf()
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
    if (params.nodeType !== 1 && params.nodeType !== 2 && params.nodeType !== 3 && params.nodeType !== 4 && params.nodeType !== 5 && params.nodeType !== 6) throw new Error('Unsupported nodeType')
    assertString(params.apiField, 'apiField')

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) throw new Error('Wallet not loaded')
    // The purchase needs the chain, which is unreachable through our own tunnel —
    // fail fast instead of burning the RPC timeout (the renderer gates too).
    if (isVpnActive()) {
      throw new Error('Disconnect the VPN before starting a new session. The chain is unreachable through the tunnel.')
    }

    // Phase A — the pre-payment checks, the shared RPC connection and the
    // handshake endpoint (read-only), all in parallel. Any failure aborts with
    // nothing spent and the connection closed.
    const flowPromise = openChainFlow(wallet)
    let remoteUrl: string
    try {
      ;[, , remoteUrl] = await Promise.all([
        preflightConnect(params.nodeType, params.apiField),
        flowPromise.then((f) => assertSufficientFunds(cachedPlanCost(params.planId, params.denom), f.query)),
        flowPromise.then((f) => resolveNodeRemoteUrl(params.nodeAddress, params.apiField, f.query)),
      ])
    } catch (err) {
      flowPromise.then((f) => f.disconnect(), () => {})
      throw err
    }
    const flow = await flowPromise

    try {
      const { sessionId, subscriptionId } = await subscribeToPlan({
        wallet,
        address,
        planId: params.planId,
        denom: params.denom,
        nodeAddress: params.nodeAddress,
        renewalPricePolicy: params.renewalPolicy,
        client: flow.signing,
      }).catch(noteChainError)

      // Pre-cache sessions CONCURRENTLY with the handshake, exactly like
      // CONNECTION_SUBSCRIBE: the row exists from the moment the tx commits,
      // and it feeds both the sessions cache and the quota. Applied only after
      // the handshake succeeds, so a refunded session never primes either.
      const sessionsPromise = readAllSessions(flow.query).catch(() => null)

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
        remoteUrl,
      })

      applySession(sessionId, params.nodeAddress, params.nodeMoniker, params.nodeCountry, params.nodeType, result)

      const sessions = await sessionsPromise
      if (sessions) {
        primeSessionsCache(sessions)
        setQuota(sessions.find((s) => s.id === sessionId))
      }

      // The chain row was unreadable or hadn't appeared yet — fall back to the
      // plan's own caps from main's plan cache, mirroring the node path's
      // purchased-quota fallback. A session created seconds ago has metered
      // nothing, so both baselines are 0; the chain row overtakes this at the
      // next successful sessions read.
      if (!activeQuota) {
        const plan = getCachedPlans().plans.find((p) => p.id === params.planId)
        activeQuota = {
          sessionId,
          maxDurationSeconds: plan?.durationSeconds ?? null,
          baselineDurationSeconds: 0,
          maxBytes: plan ? parseInt(plan.bytes, 10) || 0 : 0,
          baselineBytes: 0,
        }
        quotaWarned = false
      }

      // A subscription (and maybe an allocation) just appeared on chain.
      notifySessionsChanged()

      return {
        sessionId,
        subscriptionId,
        protocol: result.protocol,
        configString: result.configString,
      }
    } finally {
      flow.disconnect()
    }
  })

  handle(IPC.PLAN_START_SESSION_FROM_SUB, async (_event, params: {
    subscriptionId: string
    /** The subscription's plan, for the quota fallback when the chain row is unreadable. */
    planId: string
    nodeAddress: string
    nodeMoniker: string
    nodeCountry: string
    nodeType: number
    apiField: string
  }) => {
    assertString(params.subscriptionId, 'subscriptionId')
    if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    assertString(params.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    assertSentAddress(params.nodeAddress, 'nodeAddress')
    assertString(params.nodeMoniker, 'nodeMoniker')
    assertString(params.nodeCountry, 'nodeCountry')
    if (params.nodeType !== 1 && params.nodeType !== 2 && params.nodeType !== 3 && params.nodeType !== 4 && params.nodeType !== 5 && params.nodeType !== 6) throw new Error('Unsupported nodeType')
    assertString(params.apiField, 'apiField')

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) throw new Error('Wallet not loaded')
    // Broader than the isVpnActive() check the plan mutations use: a new session
    // must also be refused in local-proxy mode and mid-reconnect, where routing is
    // untouched but a session is live all the same (see assertNotConnected).
    assertNotConnected()

    // Phase A — same shape as the paid flows even though this one only spends
    // gas: preflight, gas-reserve check and endpoint resolve in parallel over
    // the shared connection.
    const flowPromise = openChainFlow(wallet)
    let remoteUrl: string
    try {
      ;[, , remoteUrl] = await Promise.all([
        preflightConnect(params.nodeType, params.apiField),
        // Reusing a prepaid allocation — gas only, no new subscription is bought.
        flowPromise.then((f) => assertSufficientFunds(0, f.query)),
        flowPromise.then((f) => resolveNodeRemoteUrl(params.nodeAddress, params.apiField, f.query)),
      ])
    } catch (err) {
      flowPromise.then((f) => f.disconnect(), () => {})
      throw err
    }
    const flow = await flowPromise

    try {
      const { sessionId, subscriptionId } = await startSessionWithExistingSubscription({
        wallet,
        address,
        subscriptionId: params.subscriptionId,
        nodeAddress: params.nodeAddress,
        client: flow.signing,
      }).catch(noteChainError)

      // Read overlaps the handshake, applied only on success (see PLAN_SUBSCRIBE).
      const sessionsPromise = readAllSessions(flow.query).catch(() => null)

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
        remoteUrl,
      })

      applySession(sessionId, params.nodeAddress, params.nodeMoniker, params.nodeCountry, params.nodeType, result)

      const sessions = await sessionsPromise
      if (sessions) {
        primeSessionsCache(sessions)
        setQuota(sessions.find((s) => s.id === sessionId))
      }

      // Same fallback as PLAN_SUBSCRIBE. On this reuse path the plan-sized cap
      // can overstate what the subscription has left, but the chain row
      // overtakes it at the next successful sessions read, and the alternative
      // is a session with no watchdog at all.
      if (!activeQuota) {
        const plan = getCachedPlans().plans.find((p) => p.id === params.planId)
        activeQuota = {
          sessionId,
          maxDurationSeconds: plan?.durationSeconds ?? null,
          baselineDurationSeconds: 0,
          maxBytes: plan ? parseInt(plan.bytes, 10) || 0 : 0,
          baselineBytes: 0,
        }
        quotaWarned = false
      }

      // A new session row exists on chain.
      notifySessionsChanged()

      return {
        sessionId,
        subscriptionId,
        protocol: result.protocol,
        configString: result.configString,
      }
    } finally {
      flow.disconnect()
    }
  })

  handle(IPC.PLAN_SMART_CONNECT, async (_event, params: {
    planId: string
    /** Present = reuse this subscription (gas only); absent = subscribe first, denom required. */
    subscriptionId?: string
    denom?: string
    renewalPolicy?: number
    /** Only offer nodes local-proxy mode can run (v2ray/xray/hysteria2). */
    requireProxyCapable?: boolean
  }) => {
    assertString(params.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    if (params.subscriptionId !== undefined) {
      assertString(params.subscriptionId, 'subscriptionId')
      if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    } else {
      assertString(params.denom, 'denom')
    }
    if (params.renewalPolicy !== undefined) assertNumber(params.renewalPolicy, 'renewalPolicy', 0, 7)

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) throw new Error('Wallet not loaded')
    // Same breadth as PLAN_START_SESSION_FROM_SUB: proxy mode and the reconnect
    // window count as connected here, not just an active tunnel interface.
    assertNotConnected()

    const flow = await openChainFlow(wallet)
    try {
      // One funds check for the whole ladder: the plan price is spent at most
      // once (see ladderNextTx), and every later attempt is gas only.
      await assertSufficientFunds(
        params.subscriptionId ? 0 : cachedPlanCost(params.planId, params.denom!),
        flow.query,
      )

      sendPlanProgress('rank', 'Finding the best node')
      const addresses = await listNodesForPlan(params.planId, flow.query)
      if (addresses.length === 0) {
        throw new Error('This plan has no active nodes linked right now. Nothing was purchased.')
      }

      // Join the plan's node addresses against the aggregator metadata; a node
      // without a row can't be preflighted or probed, so rankPlanCandidates
      // excludes it with a reason.
      if (cachedNodes.length === 0) {
        try { await fetchNodes() } catch { /* best-effort */ }
      }
      const metaByAddress = new Map(cachedNodes.map((n) => [n.address, n]))
      const probeCache = getAllCachedResults()
      const now = Date.now()
      const toCandidate = (addr: string): PlanNodeCandidate => {
        const meta = metaByAddress.get(addr)
        const probe = probeCache[addr]
        const fresh = probe !== undefined && now - probe.timestamp < SMART_LATENCY_FRESH_MS
        const protocol = meta ? NODE_TYPE_TO_PROTOCOL[meta.type] : undefined
        const needsRoot = protocol === 'wireguard' || protocol === 'amneziawg' || protocol === 'openvpn'
        return {
          address: addr,
          moniker: meta?.moniker || addr,
          country: meta?.country || '',
          type: meta?.type ?? 0,
          api: meta?.api || '',
          isActive: meta?.isActive === true,
          isHealthy: meta?.isHealthy === true,
          latencyMs: fresh ? probe.latencyMs : null,
          probeFailed: fresh ? !probe.reachable : false,
          runtimeOk: protocol !== undefined
            && protocolRuntimeError(protocol) === null
            && (!needsRoot || canEscalatePrivileges()),
        }
      }

      const requireProxyCapable = params.requireProxyCapable === true
      const provisional = rankPlanCandidates(addresses.map(toCandidate), { requireProxyCapable })

      // Live-probe the provisional top so the pick reflects the network now,
      // not the last batch test. Bounded: probes race a fixed window, and a
      // node that hasn't answered by then just stays unprobed (still eligible,
      // ranked after the probed ones). nodeFetch's own timeout does not cover
      // the TCP connect, hence the window around the whole batch.
      const probeResults = new Map<string, { reachable: boolean; latencyMs: number | null }>()
      const toProbe = provisional.ranked.slice(0, SMART_PROBE_TOP_N)
      if (toProbe.length > 0) {
        await withTimeout(
          Promise.allSettled(toProbe.map(async (c) => {
            const r = await probeNode(c.api, c.address)
            probeResults.set(c.address, { reachable: r.reachable, latencyMs: r.latencyMs })
          })),
          SMART_PROBE_WINDOW_MS,
          'plan probe',
        ).catch(() => { /* window elapsed — whatever answered is in the map */ })
      }
      const { ranked, excluded } = rankPlanCandidates(
        provisional.ranked.map((c) => {
          const p = probeResults.get(c.address)
          return p ? { ...c, latencyMs: p.latencyMs, probeFailed: !p.reachable } : c
        }),
        { requireProxyCapable },
      )
      const allExcluded = [...provisional.excluded, ...excluded]

      if (ranked.length === 0) {
        const why = allExcluded.slice(0, 5)
          .map((e) => `${metaByAddress.get(e.address)?.moniker || e.address}: ${e.reason}`)
          .join('; ')
        throw new Error(`No node in this plan is usable right now. Nothing was purchased. ${why}`)
      }

      // The ladder. Refunded failures advance to the next candidate while the
      // tx budget lasts; anything that may have left money in flight stops it.
      let subscriptionId: string | null = params.subscriptionId ?? null
      let txAttempts = 0
      const attempts: { moniker: string; reason: string }[] = []

      for (const candidate of ranked) {
        const attemptLabel = `${candidate.moniker}, attempt ${attempts.length + 1}`
        const recordAndDecide = (failure: SmartConnectFailure, err: unknown): boolean => {
          attempts.push({
            moniker: candidate.moniker,
            reason: err instanceof Error ? err.message : 'unknown failure',
          })
          return shouldTryNextCandidate(failure, txAttempts)
        }

        // Pre-payment checks for THIS node; failures here cost nothing.
        sendPlanProgress('rank', `Checking ${attemptLabel}`)
        try {
          await preflightConnect(candidate.type, candidate.api)
        } catch (err) {
          if (recordAndDecide('preflight', err)) continue
          break
        }
        let remoteUrl: string
        try {
          remoteUrl = await resolveNodeRemoteUrl(candidate.address, candidate.api, flow.query)
        } catch (err) {
          if (recordAndDecide('endpoint', err)) continue
          break
        }

        // The tx. ladderNextTx enforces the money rule: before a subscription
        // exists the attempt buys one; from the moment one commits, every
        // further attempt rides it for gas only (a refund cancels the SESSION,
        // never the subscription).
        let sessionId: string
        try {
          if (ladderNextTx(subscriptionId) === 'plan-subscribe') {
            sendPlanProgress('buy', attemptLabel)
            const res = await subscribeToPlan({
              wallet,
              address,
              planId: params.planId,
              denom: params.denom!,
              nodeAddress: candidate.address,
              renewalPricePolicy: params.renewalPolicy,
              client: flow.signing,
            }).catch(noteChainError)
            txAttempts++
            sessionId = res.sessionId
            if (res.subscriptionId) subscriptionId = res.subscriptionId
          } else {
            sendPlanProgress('session', attemptLabel)
            const res = await startSessionWithExistingSubscription({
              wallet,
              address,
              subscriptionId: subscriptionId!,
              nodeAddress: candidate.address,
              client: flow.signing,
            }).catch(noteChainError)
            txAttempts++
            sessionId = res.sessionId
          }
        } catch (err) {
          // A timed-out tx may still land (a second one could buy a second
          // subscription), and a chain rejection would fail every candidate:
          // both classifications stop the ladder, so surface the error as-is.
          const msg = err instanceof Error ? err.message : ''
          const failure: SmartConnectFailure = msg === PLAN_TX_TIMEOUT_MESSAGE ? 'tx-timeout' : 'chain'
          if (recordAndDecide(failure, err)) continue
          throw err
        }

        sendPlanProgress('handshake', attemptLabel)
        const sessionsPromise = readAllSessions(flow.query).catch(() => null)
        try {
          const result = await establishSessionOrRefund({
            sessionId,
            nodeAddress: candidate.address,
            nodeType: candidate.type,
            apiField: candidate.api,
            nodeMoniker: candidate.moniker,
            nodeCountry: candidate.country,
            wallet,
            address,
            privKey,
            isDeposit: false,
            remoteUrl,
          })

          applySession(sessionId, candidate.address, candidate.moniker, candidate.country, candidate.type, result)
          const sessions = await sessionsPromise
          if (sessions) {
            primeSessionsCache(sessions)
            setQuota(sessions.find((s) => s.id === sessionId))
          }
          // Same fallback as the two plan handlers above.
          if (!activeQuota) {
            const plan = getCachedPlans().plans.find((p) => p.id === params.planId)
            activeQuota = {
              sessionId,
              maxDurationSeconds: plan?.durationSeconds ?? null,
              baselineDurationSeconds: 0,
              maxBytes: plan ? parseInt(plan.bytes, 10) || 0 : 0,
              baselineBytes: 0,
            }
            quotaWarned = false
          }
          notifySessionsChanged()

          return {
            sessionId,
            subscriptionId: subscriptionId ?? '',
            protocol: result.protocol,
            configString: result.configString,
            node: {
              address: candidate.address,
              moniker: candidate.moniker,
              country: candidate.country,
              type: candidate.type,
            },
            attempts,
          }
        } catch (err) {
          // A failed REFUND leaves a live session needing manual cleanup —
          // never buy another one behind it.
          const msg = err instanceof Error ? err.message : ''
          const failure: SmartConnectFailure = msg.includes(REFUND_FAILED_TAIL) ? 'chain' : 'handshake'
          if (failure === 'handshake' && recordAndDecide('handshake', err)) continue
          throw err
        }
      }

      // Ladder exhausted without a tunnel. A subscription bought along the way
      // survives its refunded sessions, so hand it back instead of losing it.
      let summary = smartConnectFailureSummary(attempts)
      if (!params.subscriptionId && subscriptionId) {
        summary += ` Your new subscription #${subscriptionId} was created and can be connected from My plans without paying again.`
      }
      throw new Error(summary)
    } finally {
      flow.disconnect()
    }
  })

  handle(IPC.PLAN_NODES, async (_event, params: { planId: string }) => {
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    // While our own tunnel makes the chain unreachable, a stale node list beats
    // an empty one: [] here used to render as "No nodes are linked to this
    // plan", a false statement caused by the tunnel, not the plan. And when the
    // cache has nothing either (it is in-memory, so the catalog scan's warm
    // entries die with the process), the answer is UNKNOWN (null), never [] —
    // the `?? []` fallback here recreated the exact false statement above after
    // every app restart. The renderer words null differently and falls back to
    // the catalog's persisted nodeCount.
    if (isVpnActive()) return getCachedPlanNodes(params.planId)
    try {
      return await listNodesForPlan(params.planId)
    } catch {
      reportRpcFailure()
      return getCachedPlanNodes(params.planId)
    }
  })

  handle(IPC.PLAN_LIST_FOR_NODE, async (_event, params: { nodeAddress: string }) => {
    assertString(params?.nodeAddress, 'nodeAddress')
    if (isVpnActive()) return []
    try {
      return await listPlansForNode(params.nodeAddress)
    } catch {
      reportRpcFailure()
      return []
    }
  })

  handle(IPC.SUBSCRIPTION_CANCEL, async (_event, params: { subscriptionId: string }) => {
    assertString(params?.subscriptionId, 'subscriptionId')
    if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    const wallet = getWallet()
    const address = getAddress()
    if (!wallet || !address) throw new Error('Wallet not loaded')
    // The tx needs the chain, which is unreachable through our own tunnel — fail
    // fast instead of hanging to the RPC timeout (same rule as WALLET_END_SESSION).
    if (isVpnActive()) {
      throw new Error('Disconnect the VPN before managing subscriptions. The chain is unreachable through the tunnel.')
    }
    // One connection for the funds check and the tx.
    const flow = await openChainFlow(wallet)
    try {
      await assertSufficientFunds(0, flow.query)
      await cancelSubscription({
        wallet, address, subscriptionId: params.subscriptionId, client: flow.signing,
      }).catch(noteChainError)
    } finally {
      flow.disconnect()
    }
  })

  /**
   * Renew a PLAN subscription for another period. Charges the plan's price again,
   * so it is gated on funds exactly like a first subscribe — and like that path,
   * the price comes from main's own plan cache, never from the renderer.
   * Node (per-GB/hour) subscriptions aren't renewable here; they have no plan price.
   */
  handle(IPC.SUBSCRIPTION_RENEW, async (_event, params: { subscriptionId: string; planId: string; denom: string }) => {
    assertString(params?.subscriptionId, 'subscriptionId')
    if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId) || params.planId === '0') throw new Error('Invalid planId')
    assertString(params?.denom, 'denom')
    const wallet = getWallet()
    const address = getAddress()
    if (!wallet || !address) throw new Error('Wallet not loaded')
    if (isVpnActive()) {
      throw new Error('Disconnect the VPN before managing subscriptions. The chain is unreachable through the tunnel.')
    }
    const flow = await openChainFlow(wallet)
    try {
      await assertSufficientFunds(cachedPlanCost(params.planId, params.denom), flow.query)
      await renewSubscription({
        wallet, address, subscriptionId: params.subscriptionId, denom: params.denom, client: flow.signing,
      }).catch(noteChainError)
    } finally {
      flow.disconnect()
    }
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
    if (isVpnActive()) {
      throw new Error('Disconnect the VPN before managing subscriptions. The chain is unreachable through the tunnel.')
    }
    const flow = await openChainFlow(wallet)
    try {
      await assertSufficientFunds(0, flow.query)
      await updateSubscriptionPolicy({
        wallet, address, subscriptionId: params.subscriptionId, policy: params.policy, client: flow.signing,
      }).catch(noteChainError)
    } finally {
      flow.disconnect()
    }
  })

  handle(IPC.PROVIDER_GET, async (_event, params: { address: string }) => {
    assertString(params?.address, 'address')
    assertSentAddress(params.address, 'address')
    try {
      return await getProvider(params.address)
    } catch {
      reportRpcFailure()
      const cached = getCachedProviders().providers
      return cached.find((p) => p.address === params.address) ?? null
    }
  })

  handle(IPC.PROVIDER_LIST, async () => {
    try {
      return await listProviders()
    } catch {
      reportRpcFailure()
      return getCachedProviders().providers
    }
  })

  // --- Provider console ---
  //
  // Every one of these talks to the chain live: there is no cache to fall back on
  // and a stale answer would be worse than none (a provider registered seconds ago
  // must show as registered). So reads AND writes refuse while the tunnel is up,
  // rather than lying. Writes additionally go through assertSufficientFunds with a
  // cost computed HERE from on-chain data — never from a renderer-supplied figure.

  /** Reads that need the wallet's account address, and the chain to be reachable. */
  function requireProviderContext(): { wallet: NonNullable<ReturnType<typeof getWallet>>; address: string } {
    const wallet = getWallet()
    const address = getAddress()
    if (!wallet || !address) throw new Error('Wallet not loaded')
    if (isVpnActive()) {
      throw new Error('Provider actions need the blockchain, which is unreachable through the VPN tunnel. Disconnect first.')
    }
    return { wallet, address }
  }

  handle(IPC.PROVIDER_ME, async () => {
    const address = getAddress()
    if (!address) throw new Error('Wallet not loaded')
    if (isVpnActive()) return null
    return await getMyProvider(address).catch(noteChainError)
  })

  // Reveals the Provider tab for the ACTIVE wallet only. Read back off the wallet
  // entry (walletList / walletStoreStatus), so there's no getter here.
  handle(IPC.PROVIDER_MODE_SET, async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid providerMode: expected boolean')
    const activeWalletId = loadSettings().activeWalletId
    if (!activeWalletId) throw new Error('No active wallet')
    setWalletProviderMode(activeWalletId, enabled)
  })

  handle(IPC.PROVIDER_DEPOSIT, async () => {
    if (isVpnActive()) return null
    return await getProviderDeposit().catch(noteChainError)
  })

  handle(IPC.PROVIDER_REGISTER, async (_event, params: { name: string; identity: string; website: string; description: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.name, 'name')
    const details = {
      name: params.name,
      identity: params.identity ?? '',
      website: params.website ?? '',
      description: params.description ?? '',
    }
    // The deposit is spent to the community pool, not escrowed — check for it
    // explicitly rather than letting the tx fail after the gas simulation.
    const deposit = await getProviderDeposit().catch(noteChainError)
    await assertSufficientFunds(parseInt(deposit.amount, 10) || 0)
    await registerProvider({ wallet, accountAddress: address, details }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_UPDATE_DETAILS, async (_event, params: { name: string; identity: string; website: string; description: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.name, 'name')
    await assertSufficientFunds(0)
    await updateProviderDetails({
      wallet,
      accountAddress: address,
      details: {
        name: params.name,
        identity: params.identity ?? '',
        website: params.website ?? '',
        description: params.description ?? '',
      },
    }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_SET_STATUS, async (_event, params: { active: boolean }) => {
    const { wallet, address } = requireProviderContext()
    if (typeof params?.active !== 'boolean') throw new Error('Invalid active: expected boolean')
    await assertSufficientFunds(0)
    await setProviderStatus({ wallet, accountAddress: address, active: params.active }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_PLANS, async () => {
    const address = getAddress()
    if (!address) throw new Error('Wallet not loaded')
    if (isVpnActive()) return []
    return await listMyPlans(address).catch(noteChainError)
  })

  handle(IPC.PROVIDER_PLAN_CREATE, async (_event, params: { gigabytes: number; days: number; priceUdvpn: number; private: boolean }) => {
    const { wallet, address } = requireProviderContext()
    // Outer sanity bounds only — the semantic rules (whole numbers, non-zero
    // bytes/duration) are enforced by buildCreatePlanMsg, which mirrors the hub's
    // own ValidateBasic.
    assertIntRange(params?.gigabytes, 'gigabytes', 1, 1_000_000)
    assertIntRange(params?.days, 'days', 1, 3650)
    assertIntRange(params?.priceUdvpn, 'priceUdvpn', 0, 1_000_000_000_000)
    if (typeof params?.private !== 'boolean') throw new Error('Invalid private: expected boolean')
    await assertSufficientFunds(0)
    await createPlan({
      wallet,
      accountAddress: address,
      input: {
        gigabytes: params.gigabytes,
        days: params.days,
        priceUdvpn: params.priceUdvpn,
        private: params.private,
      },
    }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_PLAN_SET_STATUS, async (_event, params: { planId: string; active: boolean }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    if (typeof params?.active !== 'boolean') throw new Error('Invalid active: expected boolean')
    await assertSufficientFunds(0)
    await setPlanStatus({ wallet, accountAddress: address, planId: params.planId, active: params.active }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_PLAN_LINK, async (_event, params: { planId: string; nodeAddress: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    await assertSufficientFunds(0)
    await linkNode({ wallet, accountAddress: address, planId: params.planId, nodeAddress: params.nodeAddress }).catch(noteChainError)
    // The plan→nodes list is cached for 10 minutes for browsing; after our own
    // link the console re-reads it immediately and must not get the old answer.
    invalidatePlanNodes(params.planId)
  })

  handle(IPC.PROVIDER_PLAN_UNLINK, async (_event, params: { planId: string; nodeAddress: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    await assertSufficientFunds(0)
    await unlinkNode({ wallet, accountAddress: address, planId: params.planId, nodeAddress: params.nodeAddress }).catch(noteChainError)
    invalidatePlanNodes(params.planId)
  })

  /**
   * Per-plan counters for the provider's own plan list: linked nodes, and how
   * many subscriptions the plan has sold. Batched over the wallet's plans (there
   * are a handful) so the console makes one call rather than three per plan.
   * Best-effort per plan — one unreadable plan must not blank the whole list.
   */
  handle(IPC.PROVIDER_PLAN_STATS, async (_event, params: { planIds: string[] }) => {
    if (!Array.isArray(params?.planIds)) throw new Error('Invalid planIds')
    if (params.planIds.length > 50) throw new Error('Too many planIds')
    for (const id of params.planIds) {
      assertString(id, 'planId')
      if (!/^\d+$/.test(id)) throw new Error('Invalid planId')
    }
    if (isVpnActive()) return {}

    const out: Record<string, { nodes: number; subscriptions: number; active: number; truncated: boolean }> = {}
    for (const planId of params.planIds) {
      try {
        const [nodes, subs] = await Promise.all([
          listNodesForPlan(planId),
          getPlanSubscriberStats(planId),
        ])
        out[planId] = { nodes: nodes.length, ...subs }
      } catch {
        reportRpcFailure()
      }
    }
    return out
  })

  /**
   * Lease burn, escrow and estimated plan income in one read, for the console's
   * economics strip and the break-even line on the plan form.
   *
   * Not best-effort like PROVIDER_PLAN_STATS: money figures either add up or they
   * don't, so a partial read throws and the strip renders "unavailable" rather than
   * a total silently missing a plan's income or a node's burn.
   */
  handle(IPC.PROVIDER_ECONOMICS, async () => {
    const address = getAddress()
    if (!address) throw new Error('Wallet not loaded')
    if (isVpnActive()) return null
    return await getProviderEconomics(address).catch(noteChainError)
  })

  /** Display-only USD rate. Null when it can't be reached — the UI just omits it. */
  handle(IPC.PRICE_TOKEN, async () => {
    return await getTokenPrice()
  })

  // --- Leases ---

  handle(IPC.LEASE_LIST, async () => {
    const address = getAddress()
    if (!address) throw new Error('Wallet not loaded')
    if (isVpnActive()) return []
    return await listLeasesForProvider(toProviderAddress(address)).catch(noteChainError)
  })

  handle(IPC.LEASE_PARAMS, async () => {
    if (isVpnActive()) return null
    return await getLeaseParams().catch(noteChainError)
  })

  /**
   * What a lease on this node would cost. Priced in main from the node's own
   * on-chain hourly price so the renderer never supplies a figure that a funds
   * check or a MaxPrice guard would then be based on.
   */
  handle(IPC.LEASE_QUOTE, async (_event, params: { nodeAddress: string; hours: number }) => {
    requireProviderContext()
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    assertIntRange(params?.hours, 'hours', 1, 720)
    const [price, leaseParams] = await Promise.all([
      getNodeHourlyPrice(params.nodeAddress).catch(noteChainError),
      getLeaseParams().catch(noteChainError),
    ])
    if (!price.hourlyPrice) {
      throw new Error('That node does not publish an hourly price in P2P, so it cannot be leased.')
    }
    return {
      hourlyPrice: price.hourlyPrice,
      totalUdvpn: leaseDepositUdvpn(price.hourlyPrice, params.hours),
      nodeStatus: price.status,
      minHours: leaseParams.minHours,
      maxHours: leaseParams.maxHours,
    }
  })

  handle(IPC.LEASE_START, async (_event, params: { nodeAddress: string; hours: number; renewalPolicy: number }) => {
    const { wallet, address } = requireProviderContext()
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    assertIntRange(params?.hours, 'hours', 1, 720)
    assertNumber(params.renewalPolicy, 'renewalPolicy', 0, 7)

    const [price, leaseParams] = await Promise.all([
      getNodeHourlyPrice(params.nodeAddress).catch(noteChainError),
      getLeaseParams().catch(noteChainError),
    ])
    if (!price.hourlyPrice) {
      throw new Error('That node does not publish an hourly price in P2P, so it cannot be leased.')
    }
    assertValidLeaseHours(params.hours, leaseParams.minHours, leaseParams.maxHours)
    await assertSufficientFunds(leaseDepositNumber(price.hourlyPrice, params.hours))

    await startLease({
      wallet,
      accountAddress: address,
      nodeAddress: params.nodeAddress,
      hours: params.hours,
      hourlyQuoteValue: price.hourlyPrice,
      renewalPricePolicy: params.renewalPolicy,
    }).catch(noteChainError)
  })

  handle(IPC.LEASE_END, async (_event, params: { leaseId: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.leaseId, 'leaseId')
    if (!/^\d+$/.test(params.leaseId)) throw new Error('Invalid leaseId')
    await assertSufficientFunds(0)
    await endLease({ wallet, accountAddress: address, leaseId: params.leaseId }).catch(noteChainError)
  })

  // Register V2Ray unexpected exit handler for auto-reconnect
  onV2RayUnexpectedExit(() => {
    if (!isIntentionalDisconnect && activeSessionId) {
      console.log('[vpn] V2Ray exited unexpectedly, attempting reconnect...')
      attemptReconnect()
    }
  })
}

/**
 * Quit-path teardown. Delegates to performDisconnect() rather than repeating a
 * lighter version of it, because the three things this used to skip all matter:
 *
 * - rememberSessionUsage(), so quitting mid-session still writes the usage floor.
 *   Node proofs lag by tens of minutes, so without it the Sessions gauge reads
 *   the not-yet-settled chain figure after a relaunch (see the usage-floor rule).
 * - isIntentionalDisconnect + clearing activeSessionId BEFORE disconnect() SIGTERMs
 *   the proxy core, or the core's exit handler schedules an auto-reconnect in the
 *   middle of the quit (onV2RayUnexpectedExit gates on exactly those two).
 * - connectionEpoch++, set synchronously ahead of the lock, so an in-flight
 *   connect or reconnect bails instead of completing a bring-up after teardown.
 *
 * Note the ordering inside performDisconnect is load-bearing here: stopQuotaWatchdog()
 * nulls connectedAtMs, so it must run AFTER rememberSessionUsage(), not before.
 * Nothing may be pre-stopped from this function.
 *
 * Still bounded by before-quit's 5s race, so this stays best-effort: on the pkexec
 * path an unanswered polkit prompt outlives the budget and healStrandedKillSwitch()
 * repairs the firewall at the next launch.
 */
export async function cleanupOnQuit(): Promise<void> {
  await performDisconnect()
}
