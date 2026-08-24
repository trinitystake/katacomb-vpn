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
import { BrowserWindow, app, net, safeStorage } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import type https from 'node:https'
import { join } from 'path'
import { getRpcEndpoint, isSecureStorageAvailable, loadSettings } from './settings'
import { writeFileAtomic } from './fs-utils'
import { withTimeout } from './async-utils'
import { assertTxSucceeded, broadcastOrTimeout, isSessionNotActive } from './tx-utils'
import { filterV2RayMetadata, isAllCleartext, v2raySecurityBadge, isSafeNodeApiUrl, DOH_ENDPOINTS } from './config-guard'
import { buildXRayConfig } from './xray-config'
import { buildMultihopConfig, type HopSpec } from './multihop-config'
import { buildHandshakeBody, postHandshake } from './node-handshake'
import { buildHysteria2Config } from './hysteria-config'
import { buildAmneziaWgConfig } from './amneziawg-config'
import { buildOpenVpnConfig } from './openvpn-config'
import { GAS_PRICE_STR, TX_TIMEOUT_HEIGHT_OFFSET } from '../shared/chain-constants'
import { resolveRpcBase, TX_POLL_INTERVAL_MS } from './chain-clients'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
// A node in this app's threat model may accept the TLS connection but never reply
// to the handshake POST (the SDK's axios call has no timeout), which would wedge
// the paid connect flow forever — bound the wait so it fails into the refund path.
const HANDSHAKE_TIMEOUT_MS = 15_000
// The same wait, for a handshake that crosses the entry hop on its way to the exit (see
// handshakeChainExit). Failing this one costs a session that is already paid for, so it
// is deliberately generous about latency we added ourselves.
const PROXIED_HANDSHAKE_TIMEOUT_MS = 30_000
// Fail fast instead of hanging if the configured RPC is slow/unreachable (finding L2).
const RPC_CONNECT_TIMEOUT_MS = 10_000
const SESSION_TX_TIMEOUT_MESSAGE =
  'The transaction timed out before confirmation. It may still be processing. Check ' +
  'the Session tab shortly and cancel any unexpected session to reclaim your funds.'
const END_SESSION_TX_TIMEOUT_MESSAGE =
  'The cancel transaction timed out before confirmation. It may still be processing. ' +
  'Refresh the Session tab shortly to see whether the session ended.'

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
  /**
   * Which wallet owns this session, when it is NOT the active one. Multihop can pay
   * for its two hops from two accounts so that neither node can pair them off the
   * chain, and the session then only exists under that account: listing it, metering
   * it and cancelling it all need the owning wallet. Absent means the active wallet,
   * which is every single-hop session and every same-wallet chain.
   */
  walletId?: string
  /**
   * The NODE's own protocol tag (2 = V2Ray, 4 = XRAY), which is deliberately not the
   * same thing as `protocol` above. `protocol` is the runtime that replays this
   * config, and a chain is always replayed by xray because xray-core is a strict
   * superset of what the builder emits — so a chain of two plain V2Ray nodes is
   * saved with `protocol: 'xray'`. Recording the real tag keeps the reconnect path
   * from reporting the runtime as the node's protocol, which put "XRAY" in the
   * connected bar for a V2Ray chain.
   */
  nodeType?: number
}

function getSessionsDir(): string {
  const dir = join(app.getPath('userData'), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sessionConfigPath(sessionId: string): string {
  return join(getSessionsDir(), `session-${sessionId}.json`)
}

function saveSessionConfig(config: SavedSessionConfig): void {
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
 * Retire a finished session's stored config. A CHAIN hop leaves a tombstone rather
 * than vanishing: the credentials go, but `chainPeerSessionId`/`chainRole` stay.
 *
 * They have to. That pairing is the only record that two sessions were one tunnel,
 * and an ended session keeps its row for the two hours the chain takes to settle —
 * so deleting it outright split a finished chain back into two unrelated "Ended"
 * cards, exactly the confusion the grouped card exists to prevent. The pairing is
 * two session ids and a role; nothing about it is secret. The config string is the
 * secret, and that is what gets cleared.
 *
 * Stale tombstones are swept with everything else by sweepStaleSessionFiles.
 */
function retireSessionConfig(sessionId: string): void {
  const saved = loadSessionConfig(sessionId)
  // Only tombstone when the write can actually happen: without the OS keyring
  // saveSessionConfig writes nothing, which would leave the ORIGINAL file and its
  // credentials sitting there. Deleting is the safe outcome in that case.
  if (saved?.chainPeerSessionId && isSecureStorageAvailable()) {
    saveSessionConfig({ ...saved, configString: '' })
    return
  }
  deleteSessionConfig(sessionId)
}

/**
 * Every saved session that a NON-active wallet paid for, as {sessionId, walletId}.
 *
 * A per-hop-wallet chain buys its exit session from a second account, and
 * `sessionsForAccount(active)` cannot see it — so without this the exit hop drops
 * out of the Sessions tab the moment it is bought: invisible, unmetered and
 * impossible to cancel from the UI, with a live deposit against it. The caller uses
 * it to look up which extra accounts to query and which session ids are ours.
 *
 * Only ids WE recorded are returned, so merging these in never surfaces unrelated
 * sessions that happen to live on the user's other wallets.
 */
export function listSessionsOwnedByOtherWallets(): { sessionId: string; walletId: string }[] {
  const out: { sessionId: string; walletId: string }[] = []
  try {
    for (const file of readdirSync(getSessionsDir())) {
      const match = file.match(/^session-(\d+)\.json$/)
      if (!match) continue
      const saved = loadSessionConfig(match[1])
      if (saved?.walletId) out.push({ sessionId: match[1], walletId: saved.walletId })
    }
  } catch { /* sessions dir missing or unreadable */ }
  return out
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

async function queryNodeOnChain(nodeAddress: string, client?: SentinelClient): Promise<OnChainNode> {
  // A caller sharing a connect flow's client keeps ownership of it; only a
  // connection opened here is closed here (see chain-clients.ts). A standalone
  // connection still goes to the redirect-resolved base: this is the reconnect
  // path's one chain call, and the multihop resolves ride it too.
  const own = !client
  const c = client ?? await withTimeout(SentinelClient.connect(await resolveRpcBase(getRpcEndpoint())), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  try {
    const result = await c.sentinelQuery?.node.node(nodeAddress)
    if (!result) throw new Error('Node not found on chain')
    return result as OnChainNode
  } finally {
    if (own) c.disconnect()
  }
}

/** The endpoint rule shared by resolveNodeRemoteUrl and subscribeToNode: the
 * chain's remoteAddrs first, the (validated) aggregator apiField as fallback. */
function remoteUrlFromNode(node: OnChainNode | null, apiField: string): string {
  if (node?.remoteAddrs && node.remoteAddrs.length > 0) {
    return node.remoteAddrs[0]
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

export async function resolveNodeRemoteUrl(
  nodeAddress: string,
  apiField: string,
  client?: SentinelClient,
): Promise<string> {
  let node: OnChainNode | null = null
  try {
    node = await queryNodeOnChain(nodeAddress, client)
  } catch {
    // Fall through to API field
  }
  return remoteUrlFromNode(node, apiField)
}

export async function subscribeToNode(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  nodeAddress: string
  /** Aggregator fallback for the returned remoteUrl when the chain row has no remoteAddrs. */
  apiField: string
  type: 'gigabytes' | 'hours'
  amount: number
  denom: string
  /**
   * Share a connect flow's clients (one RPC connection, see chain-clients.ts)
   * instead of opening a fresh one. The caller owns their lifecycle. The
   * multihop purchases stay in standalone mode: a chain can pay its hops from
   * two wallets, and a signing client is bound to one.
   */
  clients?: { query: SentinelClient; signing: SigningSentinelClient }
}): Promise<{ sessionId: string; remoteUrl: string }> {
  const { wallet, address, nodeAddress, apiField, type, amount, denom, clients } = params

  // Step 1: Create signing client and fetch on-chain prices
  sendProgress('1/5', 'Creating signing client...')
  let client: SigningSentinelClient
  let onChainNode: OnChainNode
  let height: number
  let ownClient = false
  if (clients) {
    // One shared connection, so the two reads the tx needs go out together.
    client = clients.signing
    ;[onChainNode, height] = await Promise.all([
      queryNodeOnChain(nodeAddress, clients.query),
      clients.signing.getHeight(),
    ])
  } else {
    // Standalone: start the signing client and the on-chain price query in
    // parallel. If the query rejects, disconnect the client spun up alongside
    // it so it can't leak (finding L1).
    ownClient = true
    const clientPromise = withTimeout(
      resolveRpcBase(getRpcEndpoint()).then((base) =>
        SigningSentinelClient.connectWithSigner(base, wallet, { gasPrice: GAS_PRICE })),
      RPC_CONNECT_TIMEOUT_MS,
      'RPC connect',
    )
    try {
      onChainNode = await queryNodeOnChain(nodeAddress)
    } catch (err) {
      clientPromise.then((c) => c.disconnect(), () => {})
      throw err
    }
    client = await clientPromise
    height = await client.getHeight()
  }

  try {
    // Resolve the handshake endpoint from the row already in hand, BEFORE the tx:
    // the post-tx path used to re-query the chain for this exact row, and a node
    // with no usable address should cost nothing rather than a purchase + refund.
    const remoteUrl = remoteUrlFromNode(onChainNode, apiField)

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
    // The height is at most a couple of seconds stale against a ~110s window.
    const timeoutHeight = BigInt(height + TX_TIMEOUT_HEIGHT_OFFSET)
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

    return { sessionId: sessionId.toString(), remoteUrl }
  } finally {
    if (ownClient) client.disconnect()
  }
}

export async function endSession(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  sessionId: string
}): Promise<void> {
  const { wallet, address, sessionId } = params
  // This is the money-recovery path (refunds + the user's End button): the
  // resolved base skips the endpoint's per-request redirect and the 1s poll
  // discovers the committed cancel ~2s sooner than CosmJS's default.
  const client = await withTimeout(
    resolveRpcBase(getRpcEndpoint()).then((base) =>
      SigningSentinelClient.connectWithSigner(base, wallet, {
        gasPrice: GAS_PRICE,
        broadcastPollIntervalMs: TX_POLL_INTERVAL_MS,
      })),
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

    retireSessionConfig(sessionId)
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
  /** Which wallet paid for this hop. Absent when both hops share the active one. */
  walletId?: string
}

/**
 * Announce which hop the next steps belong to, and WHICH PHASE of it.
 *
 * A chain runs the shared 1/5..3/5 sequence twice, so without a marker the progress
 * list replays from the start halfway through and reads as the connect having
 * restarted. The renderer keys off this to track the two hops as separate stages.
 *
 * The phase is load-bearing, not decoration. A chain buys both hops and only then
 * handshakes both, so the roles are announced twice each in the order entry, exit,
 * entry, exit. Keyed on the role alone, the renderer drove each hop's state straight
 * off the last marker and the display went backwards mid-build: the exit returned to
 * "pending" and the entry to "active" when the handshakes began. With the phase, each
 * hop's stage only ever moves forward.
 */
export function sendChainHopProgress(role: 'entry' | 'exit', phase: 'buy' | 'provision' | 'handshake'): void {
  sendProgress(`hop:${role}:${phase}`, role === 'entry' ? 'Entry hop' : 'Exit hop')
}

/**
 * Smart connect's progress markers, on the same channel (the chain-hop
 * precedent). `detail` names the node being tried and which attempt this is,
 * so the modal can show honest per-attempt state instead of replaying the
 * 1/5..5/5 purchase steps.
 */
export function sendPlanProgress(phase: 'rank' | 'buy' | 'session' | 'handshake', detail: string): void {
  sendProgress(`plan:${phase}`, detail)
}

/**
 * Which hop of a chain an error came from. Recorded on the error object itself
 * (non-enumerable, so it never shows up in a serialized log line) rather than by
 * wrapping it, because the callers still need `err instanceof V2RayPolicyError` and
 * the axios `response` body that describeHandshakeError reads.
 *
 * Without it every failure from performChainHandshake reached the caller untagged and
 * was attributed to the entry hop: a cleartext EXIT produced `Node "<entry moniker>"
 * only offers unencrypted (VLess-none) inbounds`, naming the wrong node to replace at
 * the exact moment the user is deciding what to buy instead.
 */
const CHAIN_HOP_ROLE = 'chainHopRole'

function tagChainHopRole<T>(err: T, role: 'entry' | 'exit'): T {
  if (err !== null && typeof err === 'object') {
    try {
      Object.defineProperty(err, CHAIN_HOP_ROLE, { value: role, enumerable: false, configurable: true })
    } catch { /* frozen error object — the message still carries the role */ }
  }
  return err
}

/** The hop an error was tagged with, or null when it wasn't hop-specific. */
export function chainHopRoleOf(err: unknown): 'entry' | 'exit' | null {
  const role = (err as Record<string, unknown> | null)?.[CHAIN_HOP_ROLE]
  return role === 'entry' || role === 'exit' ? role : null
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
  /**
   * Route this hop's handshake through a proxy instead of dialling it directly. Set for
   * the EXIT hop, whose request must appear to come from the entry node rather than from
   * the user (see startProvisioningProxy). The SDK's own handshake cannot take an agent,
   * so an agent means our own equivalent request — proven byte-identical to the SDK's in
   * node-handshake.test.ts.
   */
  agent?: https.Agent,
): Promise<HopSpec> {
  try {
    const keygen = new V2Ray()
    const peerRequest = { uuid: keygen.getKey() }
    const result = await withTimeout(
      agent
        ? postHandshake(
            hop.remoteUrl,
            await buildHandshakeBody(hop.sessionId, peerRequest, privKey),
            { agent, timeoutMs: HANDSHAKE_TIMEOUT_MS },
          )
        : sdkHandshake(Long.fromString(hop.sessionId, true), peerRequest, privKey, hop.remoteUrl),
      agent ? PROXIED_HANDSHAKE_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS,
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
  } catch (err) {
    // Everything in here is attributable to ONE node, so say which before it reaches
    // establishChainOrRefund, whose own failedRole only ever covers the two endpoint
    // resolves (see chainHopRoleOf).
    throw tagChainHopRole(err, role)
  }
}

// Where to resolve the EXIT hop's hostname, when the user has not picked a resolver
// of their own. Any of DOH_ENDPOINTS would do; this is the app's existing default
// (DEFAULT_KILLSWITCH_DNS).
const DEFAULT_EXIT_DOH = DOH_ENDPOINTS['1.1.1.1']!
const EXIT_RESOLVE_TIMEOUT_MS = 5000

/**
 * Resolve the EXIT hop's hostname over DNS-over-HTTPS, before the tunnel exists.
 *
 * Nodes advertise themselves by hostname, and every outbound address has to be an
 * IPv4 literal by the time xray runs: pinV2RayNodeAddresses does that with `getent`,
 * i.e. the system resolver, i.e. the user's ISP. For the ENTRY that costs nothing (we
 * are about to dial it directly, in the open). For the EXIT it hands the local network
 * the one fact a chain is bought to hide: which exit was chosen. No packet is ever
 * sent to that address directly, so the DNS query was the entire leak.
 *
 * Doing it here, rather than leaving the exit as a hostname for the entry node to
 * resolve, is deliberate. Not pinning it would be the cleaner fix ONLY if xray never
 * resolves a detoured destination locally; if it ever does, the query is emitted after
 * the TUN is up, routes into the tunnel, and needs the exit reachable in order to
 * resolve the exit. That is the v2ray DNS deadlock, on a path that has already spent
 * two deposits, so this takes the version that cannot deadlock.
 *
 * Best-effort by design: on any failure the address is left as a hostname and
 * pinV2RayNodeAddresses resolves it the old way at connect time. A resolver the user
 * chose is preferred over the default, and either way the query goes to a DoH provider
 * over HTTPS rather than to the ISP in cleartext.
 */
async function resolveExitHostPrivately(host: string): Promise<string | null> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host
  // Bare hostname only. Anything else (a host:port, a URL, an IPv6 literal) is left
  // alone for the existing path to deal with.
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) return null
  const endpoint = DOH_ENDPOINTS[loadSettings().dnsResolver] ?? DEFAULT_EXIT_DOH
  try {
    const res = await net.fetch(`${endpoint.url}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(EXIT_RESOLVE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = await res.json() as { Answer?: { type?: number; data?: string }[] }
    const answer = (body.Answer ?? []).find(
      (a) => a.type === 1 && typeof a.data === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a.data),
    )
    return answer?.data ?? null
  } catch {
    return null
  }
}

/** The exit hop's addresses with any hostname replaced by a privately-resolved IPv4. */
async function withPrivatelyResolvedAddrs(addrs: string[]): Promise<string[]> {
  return Promise.all(addrs.map(async (a) => {
    if (typeof a !== 'string' || a === '') return a
    return (await resolveExitHostPrivately(a)) ?? a
  }))
}

/**
 * A chain's handshakes happen in THREE phases, not one, because the exit hop must never
 * be contacted from the user's own address:
 *
 *   1. `handshakeChainEntry` — direct. The entry is the hop this device dials, so it
 *      sees the address no matter what we do.
 *   2. the caller stands up an entry-only proxy from that spec (see
 *      buildEntryOnlyConfig / startProvisioningProxy)
 *   3. `handshakeChainExit` — through that proxy, so the exit sees the ENTRY.
 *   4. `finalizeChain` — build the chained config and persist it under both ids.
 *
 * They were one function until the exit's exposure was found; splitting them is what
 * lets a live entry sit between the two. The caller (establishChainOrRefund) still owns
 * cancelling whatever has been paid for if any phase throws, and nothing is persisted
 * until `finalizeChain`, so a half-built chain leaves no stale config behind.
 */
export async function handshakeChainEntry(entry: ChainHopParams, privKey: Uint8Array): Promise<HopSpec> {
  sendChainHopProgress('entry', 'handshake')
  sendProgress('4/5', 'Handshaking entry node...')
  return handshakeChainHop(entry, privKey, 'entry')
}

/**
 * Handshake the exit THROUGH `agent`, which must be a proxy that egresses via the entry
 * hop. Passing no agent would silently restore the leak this exists to close, so it is
 * required rather than optional.
 *
 * `exitPrivKey` is the account that paid for the exit session: a node verifies the
 * handshake against the session's own `accAddress`, so signing it with the entry's key
 * is rejected outright once the hops are on separate wallets.
 */
export async function handshakeChainExit(
  exit: ChainHopParams,
  exitPrivKey: Uint8Array,
  agent: https.Agent,
): Promise<HopSpec> {
  sendChainHopProgress('exit', 'handshake')
  sendProgress('4/5', 'Handshaking exit node through the entry...')
  return handshakeChainHop(exit, exitPrivKey, 'exit', agent)
}

/**
 * Build the chained config from the two hop specs and save it under BOTH session ids, so
 * a reconnect from either hop rebuilds the whole chain and `SavedSessionConfig` stays as
 * it is (one protocol, one config string, one node address per file).
 *
 * The result always runs on the **xray** binary regardless of the hops' node types:
 * xray-core is a v2ray-core fork and a strict superset of what we emit (vmess + vless,
 * tcp/ws/grpc, tls + reality), so one runtime covers every entry/exit combination and
 * there is no v2ray-vs-xray binary decision to get wrong at bring-up.
 */
export async function finalizeChain(params: {
  entry: ChainHopParams
  exit: ChainHopParams
  entrySpec: HopSpec
  exitSpec: HopSpec
}): Promise<{ protocol: 'xray'; configString: string }> {
  const { entry, exit, entrySpec, exitSpec } = params

  // The exit's address is resolved HERE, over DoH, so the ISP never sees a lookup for
  // it (see resolveExitHostPrivately). The entry is left alone: it is dialled directly
  // anyway, and the kill switch needs the same IP getent would return.
  const exitPinned: HopSpec = { ...exitSpec, addrs: await withPrivatelyResolvedAddrs(exitSpec.addrs) }

  const configString = JSON.stringify(buildMultihopConfig(entrySpec, exitPinned), null, 2)

  for (const [hop, peer, role] of [[entry, exit, 'entry'], [exit, entry, 'exit']] as const) {
    saveSessionConfig({
      walletId: hop.walletId,
      sessionId: hop.sessionId,
      protocol: 'xray',
      configString,
      nodeAddress: hop.nodeAddress,
      nodeMoniker: hop.nodeMoniker,
      nodeCountry: hop.nodeCountry,
      nodeType: hop.nodeType,
      chainPeerSessionId: peer.sessionId,
      chainRole: role,
    })
  }

  return { protocol: 'xray', configString }
}
