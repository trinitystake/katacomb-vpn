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
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getRpcEndpoint } from './settings'
import { writeFileAtomic } from './fs-utils'
import { GAS_PRICE_STR } from '../shared/chain-constants'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)

// --- Session config persistence ---

interface SavedSessionConfig {
  sessionId: string
  protocol: 'wireguard' | 'v2ray'
  configString: string // WG config or V2Ray JSON config
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
  // plaintext. Without a working keyring we skip persistence entirely —
  // connecting still works this session, only reconnect-after-restart is lost.
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[session] OS keyring unavailable — session config not persisted')
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
  const client = await SentinelClient.connect(getRpcEndpoint())
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
    // non-http(s) schemes and embedded credentials (finding M5).
    const url = apiField.startsWith('http') ? apiField : `https://${apiField}`
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Invalid node API endpoint') }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Node API endpoint must use http(s)')
    }
    if (parsed.username || parsed.password) {
      throw new Error('Node API endpoint must not contain credentials')
    }
    return url
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
  const [client, onChainNode] = await Promise.all([
    SigningSentinelClient.connectWithSigner(getRpcEndpoint(), wallet, { gasPrice: GAS_PRICE }),
    queryNodeOnChain(nodeAddress),
  ])

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
    const tx = await client.signAndBroadcast(address, [msg], 'auto', 'sentinel-dvpn-app')

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
  const client = await SigningSentinelClient.connectWithSigner(getRpcEndpoint(), wallet, {
    gasPrice: GAS_PRICE,
  })

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

export async function performHandshake(params: {
  sessionId: string
  nodeAddress: string
  nodeType: 1 | 2
  remoteUrl: string
  privKey: Uint8Array
  nodeMoniker?: string
  nodeCountry?: string
}): Promise<{
  protocol: string
  configString: string
  wgInstance: Wireguard | null
  v2rayInstance: V2Ray | null
}> {
  const { sessionId, nodeAddress, nodeType, remoteUrl, privKey, nodeMoniker, nodeCountry } = params
  const sid = Long.fromString(sessionId, true)

  sendProgress('4/5', 'Performing handshake with node...')

  if (nodeType === 1) {
    // WireGuard
    const wg = new Wireguard()
    const result = await sdkHandshake(
      sid,
      { public_key: wg.publicKey },
      privKey,
      remoteUrl
    )

    const handshakeData = JSON.parse(Buffer.from(result.data, 'base64').toString())
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
  } else {
    // V2Ray
    const v2ray = new V2Ray()
    const result = await sdkHandshake(
      sid,
      { uuid: v2ray.getKey() },
      privKey,
      remoteUrl
    )

    const handshakeData = JSON.parse(Buffer.from(result.data, 'base64').toString())
    await v2ray.parseConfig(handshakeData, result.addrs)

    const configFile = v2ray.writeConfig()

    // Read the config file content so we can persist it for reconnection
    // (the temp file path won't survive app restarts)
    let configString = ''
    if (configFile && existsSync(configFile)) {
      configString = readFileSync(configFile, 'utf-8')
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

    return { protocol: 'v2ray', configString, wgInstance: null, v2rayInstance: v2ray }
  }
}
