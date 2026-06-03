import { ipcMain, net, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'
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
import { subscribeToNode, performHandshake, resolveNodeRemoteUrl, loadSessionConfig, endSession } from './sentinel-service'
import { discoverPlans, listCachedPlans, listNodesForPlan, listPlansForNode, queryPlanAllocations, subscribeToPlan, startSessionWithExistingSubscription } from './plan-service'
import { getProvider, listProviders } from './provider-service'
import { getCachedProviders } from './provider-cache'
import { loadSettings, saveSettings, listWallets, deleteWalletEntry, renameWallet } from './settings'
import { loadNodesCache, saveNodesCache, type NodesCacheFile } from './nodes-cache'
import {
  connectV2Ray,
  connectWireGuard,
  connectWireGuardFromConfig,
  connectV2RayFromConfig,
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
  runPrivileged,
} from './vpn-manager'
import { isAllowedBypassCidr } from './config-guard'
import { enableKillSwitch, disableKillSwitch } from './kill-switch'
import { getTrafficStats } from './traffic-stats'
import { probeNode, startBatch, cancelBatch, speedTest, getAllCachedResults } from './node-tester'
import { onV2RayUnexpectedExit } from './vpn-manager'
import type { Wireguard, V2Ray } from '@sentinel-official/sentinel-js-sdk'

const NODES_API = 'https://api.sentnodes.com/v2/nodes'
const PUBLIC_RPC_API = 'https://sentnodes.com/public-rpc/json'
const PUBLIC_RPC_TTL_MS = 60_000
const RECONNECT_MAX_ATTEMPTS = 5

let activeWg: Wireguard | null = null
let activeV2ray: V2Ray | null = null
let activeSessionId: string | null = null
let activeNodeInfo: { address: string; moniker: string; country: string; type: 1 | 2 } | null = null

// Cached values returned when VPN is active and RPC is unreachable
let lastKnownBalance: { denom: string; amount: string }[] = []
let lastKnownSessions: unknown[] = []
let cachedNodes: { address: string; moniker: string; country: string }[] = []

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

// Active protocol + WireGuard liveness monitor. V2Ray has a process exit
// callback; WireGuard has no process to watch, so we poll the interface and
// trigger the same auto-reconnect path when it drops.
let activeProtocol: 'wireguard' | 'v2ray' | null = null
let wgMonitorTimer: ReturnType<typeof setInterval> | null = null

function startWireGuardMonitor(): void {
  if (wgMonitorTimer) return
  wgMonitorTimer = setInterval(() => {
    if (activeProtocol !== 'wireguard' || isIntentionalDisconnect || reconnectAttempt > 0) return
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

function sendStateChange(state: 'connected' | 'idle'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.CONNECTION_STATE_CHANGE, state)
  }
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
  nodeType: 1 | 2,
  result: { wgInstance: Wireguard | null; v2rayInstance: V2Ray | null },
): void {
  activeSessionId = sessionId
  activeNodeInfo = { address: nodeAddress, moniker: nodeMoniker, country: nodeCountry, type: nodeType }
  activeWg = result.wgInstance
  activeV2ray = result.v2rayInstance
}

/** Apply DNS and kill switch settings after a successful VPN connection */
async function applyPostConnectSettings(protocol: 'wireguard' | 'v2ray'): Promise<void> {
  const settings = loadSettings()

  // Apply custom DNS
  if (settings.dnsResolver !== 'system') {
    try {
      runPrivileged(['dns-set', settings.dnsResolver])
    } catch (err) {
      console.error('Failed to set DNS:', err)
    }
  }

  // Enable kill switch
  if (settings.killSwitch) {
    try {
      const vpnIface = protocol === 'wireguard' ? 'sntl0' : 'sntl-tun'
      // Whitelist the *real* server endpoint so the tunnel can re-handshake
      // while the kill switch is engaged (was hardcoded to a useless 0.0.0.0
      // for WireGuard — see finding H2).
      const remoteHost = (protocol === 'wireguard' ? getWireGuardRemoteHost() : getV2RayRemoteHost()) || '0.0.0.0'
      const dnsIp = settings.dnsResolver !== 'system' ? settings.dnsResolver : undefined
      enableKillSwitch(vpnIface, remoteHost, dnsIp)
    } catch (err) {
      console.error('Failed to enable kill switch:', err)
    }
  }
}

/** Revert DNS and kill switch on disconnect */
function revertPostConnectSettings(): void {
  const settings = loadSettings()

  // Disable kill switch first (so DNS restore traffic can flow)
  if (settings.killSwitch) {
    try {
      disableKillSwitch()
    } catch { /* best-effort */ }
  }

  // Restore DNS
  if (settings.dnsResolver !== 'system') {
    try {
      runPrivileged(['dns-restore'])
    } catch { /* best-effort */ }
  }
}

/** Attempt auto-reconnection using saved session config */
async function attemptReconnect(): Promise<void> {
  if (!activeSessionId || isIntentionalDisconnect) return

  const settings = loadSettings()
  if (!settings.autoReconnect) return

  reconnectAttempt++
  if (reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
    console.log('[reconnect] Max attempts reached, giving up')
    reconnectAttempt = 0
    // Don't strand the user behind a DROP-all kill switch / overridden DNS.
    revertPostConnectSettings()
    disconnect()
    stopWireGuardMonitor()
    activeProtocol = null
    sendStateChange('idle')
    return
  }

  const delay = Math.min(Math.pow(2, reconnectAttempt) * 1000, 60000)
  console.log(`[reconnect] Attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${delay}ms`)
  sendReconnecting(reconnectAttempt, RECONNECT_MAX_ATTEMPTS)

  reconnectTimer = setTimeout(async () => {
    try {
      const savedSessionId = activeSessionId
      if (!savedSessionId) return

      const saved = loadSessionConfig(savedSessionId)
      if (!saved) {
        console.log('[reconnect] No saved config, cannot reconnect')
        reconnectAttempt = 0
        revertPostConnectSettings()
        disconnect()
        stopWireGuardMonitor()
        activeProtocol = null
        sendStateChange('idle')
        return
      }

      // Re-establish the tunnel
      if (saved.protocol === 'wireguard') {
        connectWireGuardFromConfig(saved.configString)
      } else {
        connectV2RayFromConfig(saved.configString)
        await new Promise((r) => setTimeout(r, 1500))
        const status = getConnectionStatus()
        if (!status.connected) {
          throw new Error('V2Ray failed to start on reconnect')
        }
        await bringUpV2RayTunnel()
      }

      // Apply post-connect settings
      await applyPostConnectSettings(saved.protocol as 'wireguard' | 'v2ray')

      activeProtocol = saved.protocol as 'wireguard' | 'v2ray'
      if (activeProtocol === 'wireguard') startWireGuardMonitor()

      console.log('[reconnect] Success')
      reconnectAttempt = 0
      sendStateChange('connected')
    } catch (err) {
      console.error('[reconnect] Failed:', err)
      attemptReconnect()
    }
  }, delay)
}

async function fetchNodes(): Promise<unknown[]> {
  const response = await net.fetch(NODES_API)
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
  const response = await net.fetch(PUBLIC_RPC_API)
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
    throw new Error(`Invalid ${name}: not a valid Sentinel address`)
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
    try {
      // Ensure node cache is populated for enrichment
      if (cachedNodes.length === 0) {
        try { await fetchNodes() } catch { /* best-effort */ }
      }
      const sessions = await getActiveSessions()
      // Enrich sessions with node metadata from saved configs or node cache
      const enriched = sessions.map((s) => {
        const saved = loadSessionConfig(s.id)
        const nodeMeta = getNodeMeta(s.nodeAddress)
        return {
          ...s,
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
      const validDns = ['system', '1.1.1.1', '1.0.0.1', '8.8.8.8', '9.9.9.9', '45.90.28.0']
      if (!validDns.includes(filtered.dnsResolver as string)) {
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
    nodeType: 1 | 2
    apiField: string
    type: 'gigabytes' | 'hours'
    amount: number
    denom: string
    quoteValue: string
  }) => {
    assertSentAddress(params.nodeAddress, 'nodeAddress')
    assertString(params.nodeMoniker, 'nodeMoniker')
    assertString(params.nodeCountry, 'nodeCountry')
    if (params.nodeType !== 1 && params.nodeType !== 2) throw new Error('Invalid nodeType: must be 1 or 2')
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

    // Resolve remote URL
    const remoteUrl = await resolveNodeRemoteUrl(params.nodeAddress, params.apiField)

    // Perform handshake
    const result = await performHandshake({
      sessionId,
      nodeAddress: params.nodeAddress,
      nodeType: params.nodeType,
      remoteUrl,
      privKey,
      nodeMoniker: params.nodeMoniker,
      nodeCountry: params.nodeCountry,
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
      type: saved.protocol === 'wireguard' ? 1 : 2,
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
    protocol: 'wireguard' | 'v2ray'
    configString?: string
  }) => {
    if (params.protocol !== 'wireguard' && params.protocol !== 'v2ray') {
      throw new Error('Invalid protocol: must be wireguard or v2ray')
    }
    if (params.configString !== undefined && typeof params.configString !== 'string') {
      throw new Error('Invalid configString')
    }
    if (params.protocol === 'wireguard') {
      if (activeWg) {
        connectWireGuard(activeWg)
      } else if (params.configString) {
        connectWireGuardFromConfig(params.configString)
      } else {
        throw new Error('No WireGuard instance or config available')
      }

      // Apply DNS and kill switch if enabled
      await applyPostConnectSettings('wireguard')

      activeProtocol = 'wireguard'
      startWireGuardMonitor()
      sendStateChange('connected')
      return { protocol: 'wireguard' }
    }

    if (params.protocol === 'v2ray') {
      if (activeV2ray) {
        connectV2Ray(activeV2ray)
      } else if (params.configString) {
        connectV2RayFromConfig(params.configString)
      } else {
        throw new Error('No V2Ray instance or config available')
      }

      // Wait briefly and verify the v2ray process didn't crash on startup
      await new Promise((r) => setTimeout(r, 1500))
      const status = getConnectionStatus()
      if (!status.connected) {
        const errMsg = getV2RayError()
        throw new Error(
          'V2Ray process exited immediately after starting.' +
          (errMsg ? `\n\nV2Ray error:\n${errMsg.slice(0, 500)}` : '\n\nNo error output captured.')
        )
      }

      // V2Ray is running — now bring up TUN interface to route all traffic through it
      await bringUpV2RayTunnel()

      // Apply DNS and kill switch if enabled
      await applyPostConnectSettings('v2ray')

      activeProtocol = 'v2ray'
      sendStateChange('connected')
      return { protocol: 'v2ray' }
    }

    throw new Error('No active VPN instance')
  })

  // Connection: Disconnect
  handle(IPC.CONNECTION_DISCONNECT, async () => {
    isIntentionalDisconnect = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempt = 0

    stopWireGuardMonitor()
    revertPostConnectSettings()
    disconnect()
    activeV2ray = null
    activeWg = null
    activeProtocol = null
    activeSessionId = null
    activeNodeInfo = null
    isIntentionalDisconnect = false
    sendStateChange('idle')
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
      sessionId: activeSessionId,
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
    return probeNode(params.remoteUrl, params.nodeAddress)
  })

  // Node Testing: Batch probe
  handle(IPC.NODE_TEST_BATCH, async (_event, nodes: Array<{ nodeAddress: string; remoteUrl: string }>) => {
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('Invalid nodes array')
    for (const n of nodes) {
      assertString(n.nodeAddress, 'nodeAddress')
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
    if (isVpnActive()) throw new Error('Disconnect VPN before discovering plans')
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
    nodeType: 1 | 2
    apiField: string
  }) => {
    assertString(params.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    assertString(params.denom, 'denom')
    assertSentAddress(params.nodeAddress, 'nodeAddress')
    assertString(params.nodeMoniker, 'nodeMoniker')
    assertString(params.nodeCountry, 'nodeCountry')
    if (params.nodeType !== 1 && params.nodeType !== 2) throw new Error('Invalid nodeType')
    assertString(params.apiField, 'apiField')

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) throw new Error('Wallet not loaded')

    const { sessionId, subscriptionId } = await subscribeToPlan({
      wallet,
      address,
      planId: params.planId,
      denom: params.denom,
      nodeAddress: params.nodeAddress,
    })

    const remoteUrl = await resolveNodeRemoteUrl(params.nodeAddress, params.apiField)

    const result = await performHandshake({
      sessionId,
      nodeAddress: params.nodeAddress,
      nodeType: params.nodeType,
      remoteUrl,
      privKey,
      nodeMoniker: params.nodeMoniker,
      nodeCountry: params.nodeCountry,
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
    nodeType: 1 | 2
    apiField: string
  }) => {
    assertString(params.subscriptionId, 'subscriptionId')
    if (!/^\d+$/.test(params.subscriptionId)) throw new Error('Invalid subscriptionId')
    assertSentAddress(params.nodeAddress, 'nodeAddress')
    assertString(params.nodeMoniker, 'nodeMoniker')
    assertString(params.nodeCountry, 'nodeCountry')
    if (params.nodeType !== 1 && params.nodeType !== 2) throw new Error('Invalid nodeType')
    assertString(params.apiField, 'apiField')

    const wallet = getWallet()
    const address = getAddress()
    const privKey = getPrivKey()
    if (!wallet || !address || !privKey) throw new Error('Wallet not loaded')

    const { sessionId, subscriptionId } = await startSessionWithExistingSubscription({
      wallet,
      address,
      subscriptionId: params.subscriptionId,
      nodeAddress: params.nodeAddress,
    })

    const remoteUrl = await resolveNodeRemoteUrl(params.nodeAddress, params.apiField)

    const result = await performHandshake({
      sessionId,
      nodeAddress: params.nodeAddress,
      nodeType: params.nodeType,
      remoteUrl,
      privKey,
      nodeMoniker: params.nodeMoniker,
      nodeCountry: params.nodeCountry,
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

export function cleanupOnQuit(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopWireGuardMonitor()
  revertPostConnectSettings()
  disconnect()
}
