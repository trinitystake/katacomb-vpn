import { GasPrice } from '@cosmjs/stargate'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import Long from 'long'
import {
  SigningSentinelClient,
  SentinelClient,
  nodeStartSession,
  sessionCancel,
  searchEvent,
  NodeEventCreateSession,
  handshake as sdkHandshake,
  Wireguard,
  V2Ray,
} from '@sentinel-official/sentinel-js-sdk'
import { BrowserWindow, app, safeStorage } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getRpcEndpoint, isSecureStorageAvailable } from './settings'
import { writeFileAtomic } from './fs-utils'
import { withTimeout } from './async-utils'
import { broadcastOrTimeout } from './tx-utils'
import { filterV2RayMetadata, isAllCleartext, v2raySecurityBadge, isSafeNodeApiUrl } from './config-guard'
import { buildXRayConfig } from './xray-config'
import { GAS_PRICE_STR } from '../shared/chain-constants'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
// A node in this app's threat model may accept the TLS connection but never reply
// to the handshake POST (the SDK's axios call has no timeout), which would wedge
// the paid connect flow forever — bound the wait so it fails into the refund path.
const HANDSHAKE_TIMEOUT_MS = 15_000
// Fail fast instead of hanging if the configured RPC is slow/unreachable (finding L2).
const RPC_CONNECT_TIMEOUT_MS = 10_000
// Blocks of validity for a session-creating tx (~6s/block on Sentinel → ~3 min).
// Past this height the chain rejects the tx, so it can't confirm long after we've
// stopped polling (finding H2).
const TX_TIMEOUT_HEIGHT_OFFSET = 30
const SESSION_TX_TIMEOUT_MESSAGE =
  'The transaction timed out before confirmation. It may still be processing — check ' +
  'the Session tab shortly and cancel any unexpected session to reclaim your funds.'

// --- Session config persistence ---

interface SavedSessionConfig {
  sessionId: string
  protocol: 'wireguard' | 'v2ray' | 'xray'
  configString: string // WG config, or V2Ray/Xray JSON config
  nodeAddress: string
  nodeMoniker?: string
  nodeCountry?: string
}

function getSessionsDir(): string {
  const dir = join(app.getPath('userData'), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sessionConfigPath(sessionId: string): string {
  return join(getSessionsDir(), `session-${sessionId}.json`)
}

export function saveSessionConfig(config: SavedSessionConfig): void {
  // Never write tunnel credentials (WG private key / V2Ray UUID) to disk in
  // plaintext OR under the reversible basic_text backend (finding H1). Without
  // real keyring encryption we skip persistence entirely — connecting still works
  // this session, only reconnect-after-restart is lost.
  if (!isSecureStorageAvailable()) {
    console.warn('[session] secure OS keyring unavailable — session config not persisted')
    return
  }
  const json = JSON.stringify(config)
  const encrypted = safeStorage.encryptString(json)
  writeFileAtomic(sessionConfigPath(config.sessionId), encrypted, 0o600)
}

export function loadSessionConfig(sessionId: string): SavedSessionConfig | null {
  const path = sessionConfigPath(sessionId)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path)
    // Try decrypting first; fall back to plaintext for configs saved before encryption
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(raw)
        return JSON.parse(decrypted)
      } catch {
        // May be a legacy plaintext config — try parsing as JSON
        return JSON.parse(raw.toString('utf-8'))
      }
    }
    return JSON.parse(raw.toString('utf-8'))
  } catch {
    return null
  }
}

function deleteSessionConfig(sessionId: string): void {
  const path = sessionConfigPath(sessionId)
  if (existsSync(path)) unlinkSync(path)
}

/**
 * Delete session config files older than maxAgeMs (default 7 days). endSession
 * removes a file on a clean cancel, but other exit paths (disconnect, quit, expiry)
 * leave the encrypted WG key / V2Ray UUID behind to accumulate — this sweeps the
 * strays on startup (finding L4). Age-based on purpose: an on-chain diff could sweep
 * every reconnect config on a transient RPC failure (getActiveSessions returns [] on
 * error), so we never touch recent files.
 */
export function sweepStaleSessionFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const now = Date.now()
  try {
    const dir = getSessionsDir()
    for (const file of readdirSync(dir)) {
      if (!/^session-\d+\.json$/.test(file)) continue
      const path = join(dir, file)
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path)
      } catch { /* ignore individual files */ }
    }
  } catch { /* sessions dir missing / unreadable */ }
}

function sendProgress(step: string, detail: string): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.webContents.send(IPC.CONNECTION_PROGRESS, step, detail)
  }
}

interface OnChainNode {
  gigabytePrices: { denom: string; baseValue: string; quoteValue: string }[]
  hourlyPrices: { denom: string; baseValue: string; quoteValue: string }[]
  remoteAddrs: string[]
}

async function queryNodeOnChain(nodeAddress: string): Promise<OnChainNode> {
  const client = await withTimeout(SentinelClient.connect(getRpcEndpoint()), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  try {
    const result = await client.sentinelQuery?.node.node(nodeAddress)
    if (!result) throw new Error('Node not found on chain')
    return result as OnChainNode
  } finally {
    client.disconnect()
  }
}

export async function resolveNodeRemoteUrl(
  nodeAddress: string,
  apiField: string
): Promise<string> {
  try {
    const node = await queryNodeOnChain(nodeAddress)
    if (node.remoteAddrs && node.remoteAddrs.length > 0) {
      return node.remoteAddrs[0]
    }
  } catch {
    // Fall through to API field
  }

  if (apiField) {
    // apiField is renderer-supplied: parse + constrain it before it becomes the
    // handshake endpoint (which we hit with the wallet private key). Reject
    // non-http(s) schemes and embedded credentials (finding M5) — shared with the
    // node-probe path (finding M3).
    if (!isSafeNodeApiUrl(apiField)) throw new Error('Invalid node API endpoint')
    return apiField.startsWith('http') ? apiField : `https://${apiField}`
  }

  throw new Error('Cannot resolve node remote address')
}

export async function subscribeToNode(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  nodeAddress: string
  type: 'gigabytes' | 'hours'
  amount: number
  denom: string
}): Promise<string> {
  const { wallet, address, nodeAddress, type, amount, denom } = params

  // Step 1: Create signing client and fetch on-chain prices
  sendProgress('1/5', 'Creating signing client...')
  // Start the signing client and the on-chain price query in parallel. If the query
  // rejects, disconnect the client spun up alongside it so it can't leak (finding L1).
  const clientPromise = withTimeout(
    SigningSentinelClient.connectWithSigner(getRpcEndpoint(), wallet, { gasPrice: GAS_PRICE }),
    RPC_CONNECT_TIMEOUT_MS,
    'RPC connect',
  )
  let onChainNode: OnChainNode
  try {
    onChainNode = await queryNodeOnChain(nodeAddress)
  } catch (err) {
    clientPromise.then((c) => c.disconnect(), () => {})
    throw err
  }
  const client = await clientPromise

  try {
    // Find the matching on-chain Price for the selected denom and subscription type
    const priceList = type === 'gigabytes' ? onChainNode.gigabytePrices : onChainNode.hourlyPrices
    const price = priceList.find((p) => p.denom === denom)
    if (!price) {
      throw new Error(`Node does not accept ${denom} for ${type} subscriptions`)
    }

    // Step 2: Broadcast subscription transaction
    sendProgress('2/5', 'Broadcasting subscription transaction...')
    const msgArgs: Record<string, unknown> = {
      from: address,
      nodeAddress,
      maxPrice: { denom: price.denom, baseValue: price.baseValue, quoteValue: price.quoteValue },
    }

    if (type === 'gigabytes') {
      msgArgs.gigabytes = Long.fromNumber(amount, true)
    } else {
      msgArgs.hours = Long.fromNumber(amount, true)
    }

    const msg = nodeStartSession(msgArgs as unknown as Parameters<typeof nodeStartSession>[0])
    // Bound how late this money tx can land: set a timeoutHeight so the chain rejects
    // it past the window rather than confirming after we've stopped polling (H2).
    const timeoutHeight = BigInt((await client.getHeight()) + TX_TIMEOUT_HEIGHT_OFFSET)
    const tx = await broadcastOrTimeout(
      client.signAndBroadcast(address, [msg], 'auto', 'sentinel-dvpn-app', timeoutHeight),
      SESSION_TX_TIMEOUT_MESSAGE,
    )

    if (tx.code !== 0) {
      throw new Error(`Transaction failed with code ${tx.code}: ${tx.rawLog}`)
    }

    // Step 3: Extract session ID
    sendProgress('3/5', 'Extracting session ID...')
    const event = searchEvent(NodeEventCreateSession.type, tx.events)
    if (!event) {
      throw new Error('Could not find session creation event in transaction')
    }

    const parsed = NodeEventCreateSession.parse(event)
    const sessionId = parsed.value.sessionId
    if (!sessionId) {
      throw new Error('Session ID not found in event')
    }

    return sessionId.toString()
  } finally {
    client.disconnect()
  }
}

export async function endSession(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  sessionId: string
}): Promise<void> {
  const { wallet, address, sessionId } = params
  const client = await withTimeout(
    SigningSentinelClient.connectWithSigner(getRpcEndpoint(), wallet, { gasPrice: GAS_PRICE }),
    RPC_CONNECT_TIMEOUT_MS,
    'RPC connect',
  )

  try {
    const msg = sessionCancel({
      from: address,
      id: Long.fromString(sessionId, true),
    })

    const tx = await client.signAndBroadcast(address, [msg], 'auto', 'sentinel-dvpn-app: end session')

    if (tx.code !== 0) {
      throw new Error(`End session failed with code ${tx.code}: ${tx.rawLog}`)
    }

    deleteSessionConfig(sessionId)
  } finally {
    client.disconnect()
  }
}

/**
 * Thrown by performHandshake when a V2Ray node offers ONLY cleartext
 * (VLess-none) inbounds. The connect handlers catch this to auto-cancel the
 * just-created session (refund) instead of bringing up an unencrypted tunnel.
 */
export class V2RayPolicyError extends Error {
  readonly code = 'VLESS_NONE_REJECTED'
  readonly badge: string
  constructor(nodeLabel: string, badge: string) {
    super(`Node "${nodeLabel}" only offers unencrypted (VLess-none) inbounds`)
    this.name = 'V2RayPolicyError'
    this.badge = badge
  }
}

/**
 * Decode the base64 JSON body from an (untrusted) node handshake response. Both
 * protocol branches funnel through here so the shape check on adversarial node
 * data is a single enforcement point. Returns `any` to match the SDK's loosely
 * typed config objects consumed by wg/v2ray parseConfig.
 */
function parseHandshakeData(result: { data?: unknown }): any {
  if (!result || typeof result.data !== 'string') {
    throw new Error('Node returned an invalid handshake response')
  }
  try {
    return JSON.parse(Buffer.from(result.data, 'base64').toString())
  } catch {
    throw new Error('Node returned an unparseable handshake response')
  }
}

export async function performHandshake(params: {
  sessionId: string
  nodeAddress: string
  nodeType: number
  remoteUrl: string
  privKey: Uint8Array
  nodeMoniker?: string
  nodeCountry?: string
}): Promise<{
  protocol: string
  configString: string
  wgInstance: Wireguard | null
  v2rayInstance: V2Ray | null
  v2raySummary?: string
}> {
  const { sessionId, nodeAddress, nodeType, remoteUrl, privKey, nodeMoniker, nodeCountry } = params
  const sid = Long.fromString(sessionId, true)

  sendProgress('4/5', 'Performing handshake with node...')

  if (nodeType === 1) {
    // WireGuard
    const wg = new Wireguard()
    const result = await withTimeout(
      sdkHandshake(sid, { public_key: wg.publicKey }, privKey, remoteUrl),
      HANDSHAKE_TIMEOUT_MS,
      'node handshake',
    )

    const handshakeData = parseHandshakeData(result)
    await wg.parseConfig(handshakeData, result.addrs)

    const configString = wg.buildConfigString() || ''

    // Persist config for reconnection
    saveSessionConfig({
      sessionId,
      protocol: 'wireguard',
      configString,
      nodeAddress,
      nodeMoniker,
      nodeCountry,
    })

    return { protocol: 'wireguard', configString, wgInstance: wg, v2rayInstance: null }
  } else if (nodeType === 4) {
    // XRAY (VLESS + Reality). The SDK can't build Reality configs (its V2Ray parser
    // has no flow/reality_* support), so we generate the xray JSON ourselves from the
    // node's handshake metadata (see xray-config.ts). VLESS peer material is a UUID —
    // the same handshake V2Ray uses — so we reuse an SDK V2Ray instance purely to
    // generate + send the uuid. buildXRayConfig rejects a node with no encrypted
    // (Reality/TLS) VLESS entry, so an all-cleartext node fails into the refund path.
    const keygen = new V2Ray()
    const result = await withTimeout(
      sdkHandshake(sid, { uuid: keygen.getKey() }, privKey, remoteUrl),
      HANDSHAKE_TIMEOUT_MS,
      'node handshake',
    )

    const handshakeData = parseHandshakeData(result)
    const metadata = Array.isArray(handshakeData.metadata) ? handshakeData.metadata : []
    const config = buildXRayConfig(metadata, result.addrs, keygen.uuid)
    const configString = JSON.stringify(config, null, 2)

    saveSessionConfig({
      sessionId,
      protocol: 'xray',
      configString,
      nodeAddress,
      nodeMoniker,
      nodeCountry,
    })

    return { protocol: 'xray', configString, wgInstance: null, v2rayInstance: null }
  } else {
    // V2Ray
    const v2ray = new V2Ray()
    const result = await withTimeout(
      sdkHandshake(sid, { uuid: v2ray.getKey() }, privKey, remoteUrl),
      HANDSHAKE_TIMEOUT_MS,
      'node handshake',
    )

    const handshakeData = parseHandshakeData(result)

    // Encryption policy: reject a node that offers ONLY cleartext (VLess-none)
    // inbounds; otherwise drop any VLess-none inbound and keep the encrypted
    // ones. The SDK's parseConfig builds its leastping balancer over whatever
    // metadata remains, so filtering here is the single enforcement point — and
    // it runs before any config is written/persisted or the tunnel is brought up.
    let v2raySummary: string | undefined
    if (Array.isArray(handshakeData.metadata)) {
      if (isAllCleartext(handshakeData.metadata)) {
        throw new V2RayPolicyError(nodeMoniker || nodeAddress, v2raySecurityBadge(handshakeData.metadata))
      }
      handshakeData.metadata = filterV2RayMetadata(handshakeData.metadata)
      v2raySummary = v2raySecurityBadge(handshakeData.metadata)
    }

    await v2ray.parseConfig(handshakeData, result.addrs)

    const configFile = v2ray.writeConfig()

    // Read the config file content so we can persist it for reconnection
    // (the temp file path won't survive app restarts)
    let configString = ''
    if (configFile && existsSync(configFile)) {
      configString = readFileSync(configFile, 'utf-8')
      // Drop the SDK's temp config once we've read it — it holds the V2Ray UUID and
      // the tunnel is spawned from a freshly written config later, not this file (L5).
      try { unlinkSync(configFile) } catch { /* best-effort */ }
    }
    if (!configString) {
      throw new Error('V2Ray handshake succeeded but failed to read config file')
    }

    // Persist config for reconnection
    saveSessionConfig({
      sessionId,
      protocol: 'v2ray',
      configString,
      nodeAddress,
      nodeMoniker,
      nodeCountry,
    })

    return { protocol: 'v2ray', configString, wgInstance: null, v2rayInstance: v2ray, v2raySummary }
  }
}
