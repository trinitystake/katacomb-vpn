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
import { randomUUID } from 'crypto'
import { join } from 'path'
import { getRpcEndpoint, isSecureStorageAvailable } from './settings'
import { writeFileAtomic } from './fs-utils'
import { withTimeout } from './async-utils'
import { assertTxSucceeded, broadcastOrTimeout, isSessionNotActive } from './tx-utils'
import { filterV2RayMetadata, isAllCleartext, v2raySecurityBadge, isSafeNodeApiUrl } from './config-guard'
import { buildXRayConfig } from './xray-config'
import { buildMultihopConfig, type HopSpec } from './multihop-config'
import { buildHysteria2Config } from './hysteria-config'
import { buildAmneziaWgConfig } from './amneziawg-config'
import { buildOpenVpnConfig } from './openvpn-config'
import { GAS_PRICE_STR } from '../shared/chain-constants'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
// A node in this app's threat model may accept the TLS connection but never reply
// to the handshake POST (the SDK's axios call has no timeout), which would wedge
// the paid connect flow forever — bound the wait so it fails into the refund path.
const HANDSHAKE_TIMEOUT_MS = 15_000
// Fail fast instead of hanging if the configured RPC is slow/unreachable (finding L2).
const RPC_CONNECT_TIMEOUT_MS = 10_000
// Blocks of validity for a session-creating tx (~6s/block on chain → ~3 min).
// Past this height the chain rejects the tx, so it can't confirm long after we've
// stopped polling (finding H2).
const TX_TIMEOUT_HEIGHT_OFFSET = 30
const SESSION_TX_TIMEOUT_MESSAGE =
  'The transaction timed out before confirmation. It may still be processing — check ' +
  'the Session tab shortly and cancel any unexpected session to reclaim your funds.'
const END_SESSION_TX_TIMEOUT_MESSAGE =
  'The cancel transaction timed out before confirmation. It may still be processing — ' +
  'refresh the Session tab shortly to see whether the session ended.'

// --- Session config persistence ---

interface SavedSessionConfig {
  sessionId: string
  protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'
  configString: string // WG/AWG INI, V2Ray/Xray/Hysteria2 JSON, or OpenVPN .ovpn
  nodeAddress: string
  nodeMoniker?: string
  nodeCountry?: string
  /**
   * MULTIHOP only: the OTHER hop's session id. Its presence is what marks this record
   * as half of a chain, and `configString` then holds the whole chained config (the
   * same string is saved under both ids), not this node's own single-hop config.
   *
   * Load-bearing for correctness, not just bookkeeping: without it the Sessions-tab
   * reconnect would re-handshake this one node, build a SINGLE-hop config and connect
   * with it while both sessions were still paid — silently dropping a hop. On the exit
   * hop's record that would connect the user straight to the exit node, handing it the
   * real IP the chain existed to hide.
   */
  chainPeerSessionId?: string
  /**
   * MULTIHOP only: which end of the chain THIS record is. Stored rather than inferred
   * from the config — the outbounds identify hops by hostname, while these records are
   * keyed by `sentnode…` address, so there is no reliable mapping between them. A
   * reconnect must keep entry as entry whichever hop the user clicked on.
   */
  chainRole?: 'entry' | 'exit'
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
      client.signAndBroadcast(address, [msg], 'auto', 'katacomb-vpn', timeoutHeight),
      SESSION_TX_TIMEOUT_MESSAGE,
    )

    assertTxSucceeded(tx, 'Transaction')

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

    try {
      const tx = await broadcastOrTimeout(
        client.signAndBroadcast(address, [msg], 'auto', 'katacomb-vpn: end session'),
        END_SESSION_TX_TIMEOUT_MESSAGE,
      )

      assertTxSucceeded(tx, 'End session')
    } catch (err) {
      // The session had already left 'active' — it ran out of its own quota
      // between the last list refresh and this click, and x/session only accepts
      // a cancel in status 1. The user's intent ("end this session") is already
      // satisfied on chain, so finish quietly instead of surfacing a rawLog for
      // something that has happened. Caught around the broadcast, not just the
      // assert: gas: 'auto' simulates first, so the guard usually rejects there.
      // Anything else still throws.
      if (!(err instanceof Error) || !isSessionNotActive(err.message)) throw err
      console.log(`[session] #${sessionId} was already inactive on chain — nothing to cancel`)
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
  } else if (nodeType === 6) {
    // Hysteria2 (QUIC). The bundled JS SDK has no Hysteria2 class either, so — like
    // xray — we build the client config ourselves from the node's handshake metadata
    // (see hysteria-config.ts). The peer material is a UUID which doubles as the
    // hysteria2 `auth` credential.
    //
    // CRITICAL: unlike V2Ray/XRAY, hysteria2's node-side peer request field is a plain
    // `string` (go-sdk hysteria2/requests.go: `UUID string`), NOT `uuid.UUID`. The SDK's
    // V2Ray.getKey() returns the uuid as a 16-BYTE ARRAY — which v2ray/xray's `uuid.UUID`
    // field accepts, but hysteria2's `string` field cannot unmarshal (JSON array → Go
    // string), so the node returns HTTP 500. So we send the canonical UUID STRING, and
    // reuse that exact string as the config `auth` (it must match what the node registered).
    const uuid = randomUUID()
    const result = await withTimeout(
      sdkHandshake(sid, { uuid }, privKey, remoteUrl),
      HANDSHAKE_TIMEOUT_MS,
      'node handshake',
    )

    const handshakeData = parseHandshakeData(result)
    const metadata = Array.isArray(handshakeData.metadata) ? handshakeData.metadata : []
    const config = buildHysteria2Config(metadata, result.addrs, uuid)
    const configString = JSON.stringify(config, null, 2)

    saveSessionConfig({
      sessionId,
      protocol: 'hysteria2',
      configString,
      nodeAddress,
      nodeMoniker,
      nodeCountry,
    })

    return { protocol: 'hysteria2', configString, wgInstance: null, v2rayInstance: null }
  } else if (nodeType === 5) {
    // AmneziaWG — same handshake payload as WireGuard (a base64 Curve25519 public
    // key); the SDK Wireguard class is used ONLY for keygen, the way the xray
    // branch uses a V2Ray instance only for its uuid. The SDK cannot emit the AWG
    // obfuscation keys (Jc/S/H/I), so amneziawg-config.ts builds the INI instead.
    // Any builder throw (bad metadata from an adversarial node) propagates into
    // establishSessionOrRefund's refund path.
    const wg = new Wireguard()
    const result = await withTimeout(
      sdkHandshake(sid, { public_key: wg.publicKey }, privKey, remoteUrl),
      HANDSHAKE_TIMEOUT_MS,
      'node handshake',
    )

    const handshakeData = parseHandshakeData(result)
    const metadata = Array.isArray(handshakeData.metadata) ? handshakeData.metadata : []
    const assignedAddrs = Array.isArray(handshakeData.addrs) ? handshakeData.addrs : []
    const configString = buildAmneziaWgConfig(metadata, result.addrs, assignedAddrs, wg.privateKey)

    saveSessionConfig({
      sessionId,
      protocol: 'amneziawg',
      configString,
      nodeAddress,
      nodeMoniker,
      nodeCountry,
    })

    return { protocol: 'amneziawg', configString, wgInstance: null, v2rayInstance: null }
  } else if (nodeType === 3) {
    // OpenVPN. The bundled JS SDK has no OpenVPN class, so openvpn-config.ts builds
    // the client .ovpn from the handshake response.
    //
    // The peer field is v2fly `uuid.UUID` ([16]byte) — go-sdk openvpn/requests.go —
    // so this is the BYTE-ARRAY form, the opposite of hysteria2's string field
    // above. Unlike every other protocol the peer material is not what authenticates
    // us: the node's PKI issues a client certificate + key in the response, and the
    // uuid is only the peer's identifier.
    const uuid = randomUUID()
    const result = await withTimeout(
      sdkHandshake(sid, { uuid: Array.from(Buffer.from(uuid.replace(/-/g, ''), 'hex')) }, privKey, remoteUrl),
      HANDSHAKE_TIMEOUT_MS,
      'node handshake',
    )

    const handshakeData = parseHandshakeData(result)
    const configString = buildOpenVpnConfig(handshakeData, result.addrs)

    saveSessionConfig({
      sessionId,
      protocol: 'openvpn',
      configString,
      nodeAddress,
      nodeMoniker,
      nodeCountry,
    })

    return { protocol: 'openvpn', configString, wgInstance: null, v2rayInstance: null }
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

/** One hop of a multihop chain. `nodeType` must be 2 (V2Ray) or 4 (XRAY). */
export interface ChainHopParams {
  sessionId: string
  nodeAddress: string
  nodeType: number
  remoteUrl: string
  nodeMoniker?: string
  nodeCountry?: string
}

/**
 * Handshake ONE hop and return what buildMultihopConfig needs. VLESS/VMess peer
 * material is a UUID for both protocols, so an SDK `V2Ray` instance is used purely
 * as a keygen — `getKey()` (the 16-byte array form) goes on the wire because the
 * node's field is a `uuid.UUID`, while `.uuid` (the string form) goes in the config.
 * Mixing those up cost a live 500 once already (see the hysteria2 note in CLAUDE.md).
 */
async function handshakeChainHop(
  hop: ChainHopParams,
  privKey: Uint8Array,
  role: 'entry' | 'exit',
): Promise<HopSpec> {
  const keygen = new V2Ray()
  const result = await withTimeout(
    sdkHandshake(Long.fromString(hop.sessionId, true), { uuid: keygen.getKey() }, privKey, hop.remoteUrl),
    HANDSHAKE_TIMEOUT_MS,
    `${role} node handshake`,
  )

  const handshakeData = parseHandshakeData(result)
  const metadata = Array.isArray(handshakeData.metadata) ? handshakeData.metadata : []

  // Same encryption policy as single-hop, applied per hop so the failure names the
  // offending node. buildMultihopConfig re-checks, but this throws the typed error
  // the connect handlers already translate into a refund.
  if (metadata.length > 0 && isAllCleartext(metadata)) {
    throw new V2RayPolicyError(hop.nodeMoniker || hop.nodeAddress, v2raySecurityBadge(metadata))
  }

  return {
    protocol: hop.nodeType === 4 ? 'xray' : 'v2ray',
    metadata,
    addrs: Array.isArray(result.addrs) ? result.addrs : [],
    uuid: keygen.uuid,
  }
}

/**
 * Handshake BOTH hops of a multihop chain and build the single chained config.
 *
 * Both sessions must already be paid for; the caller (establishChainOrRefund) is
 * responsible for cancelling BOTH if anything here throws. Nothing is persisted
 * until both hops have succeeded, so a half-built chain leaves no stale config.
 *
 * The result is always run on the **xray** binary regardless of the hops' node
 * types: xray-core is a v2ray-core fork and a strict superset of what we emit
 * (vmess + vless, tcp/ws/grpc, tls + reality), so one runtime covers every
 * entry/exit combination and there is no v2ray-vs-xray binary decision to get
 * wrong at bring-up.
 *
 * The same chained config is saved under BOTH session ids: reconnect can then
 * rebuild the whole chain from either hop's record, and `SavedSessionConfig` stays
 * exactly as it is (one protocol, one config string, one node address per file).
 */
export async function performChainHandshake(params: {
  entry: ChainHopParams
  exit: ChainHopParams
  privKey: Uint8Array
}): Promise<{ protocol: 'xray'; configString: string }> {
  const { entry, exit, privKey } = params

  sendProgress('4/5', 'Handshaking entry node...')
  const entrySpec = await handshakeChainHop(entry, privKey, 'entry')

  sendProgress('4/5', 'Handshaking exit node...')
  const exitSpec = await handshakeChainHop(exit, privKey, 'exit')

  const configString = JSON.stringify(buildMultihopConfig(entrySpec, exitSpec), null, 2)

  for (const [hop, peer, role] of [[entry, exit, 'entry'], [exit, entry, 'exit']] as const) {
    saveSessionConfig({
      sessionId: hop.sessionId,
      protocol: 'xray',
      configString,
      nodeAddress: hop.nodeAddress,
      nodeMoniker: hop.nodeMoniker,
      nodeCountry: hop.nodeCountry,
      chainPeerSessionId: peer.sessionId,
      chainRole: role,
    })
  }

  return { protocol: 'xray', configString }
}
