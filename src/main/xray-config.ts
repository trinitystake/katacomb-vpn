// Pure builder for an Xray (VLESS + Reality) CLIENT config from a dVPN node's
// handshake metadata. The bundled JS SDK (its V2Ray class) cannot emit Reality
// configs — its metadata type has no flow/reality_* fields and parseConfig ignores
// them — so for xray nodes (node.type === 4) we build the outbound ourselves.
//
// The output is the SAME JSON shape v2ray-core/xray-core consume, so it flows through
// the existing config-guard transforms (pinV2RayNodeAddresses / withV2RayDiagnosticLog
// / assertSafeV2RayConfig / withV2RayDoH) and the tun2socks routing (bringUpTun) with
// no changes — only the binary differs (xray vs v2ray) and the outbound carries Reality.
//
// Enum values are confirmed against the node-list aggregator's decode of live xray
// nodes (it decoded the flagship entry {proxy_protocol:1, transport_protocol:1,
// transport_security:3} as {proxy:'vless', transport:'tcp', security:'reality'}):
//   proxy_protocol      1 = VLESS (the only one we build for the pilot)
//   transport_protocol  1 = tcp   (only transport we can name → only one we emit)
//   transport_security  1 = none, 2 = tls, 3 = reality
//   flow                2 = xtls-rprx-vision, else none
//
// Node data is UNTRUSTED (see the node-trust invariant in config-guard.ts). This
// module only shapes JSON; the security checks still run in assertSafeV2RayConfig
// before the config is written or spawned. Selecting only reality/tls entries (never
// `none`) is also what keeps an xray tunnel from ever being cleartext at the proxy
// layer — the analogue of the V2Ray vless-none policy.
//
// Electron-free + unit-tested (native runner), like vpn-parse.ts.

export interface XRayMetadataEntry {
  port: string | number
  proxy_protocol: number
  transport_protocol: number
  transport_security: number
  flow?: number
  reality_server_name?: string
  reality_short_id?: string
  reality_public_key?: string
  reality_fingerprint?: string
}

const PROXY_VLESS = 1
const SECURITY_TLS = 2
const SECURITY_REALITY = 3
const FLOW_VISION = 2

// Only transports we can name are emitted. tcp is confirmed via the aggregator
// decoding transport_protocol=1 as {transport:'tcp'}; extend as others are confirmed.
const TRANSPORT_NETWORK: Record<number, string> = { 1: 'tcp' }

const SOCKS_LISTEN = '127.0.0.1'
const SOCKS_PORT = 1080

/**
 * Pick the VLESS entry to build an outbound from: prefer Reality, then TLS, over a
 * transport we can name. Never selects `none` (cleartext), so a cleartext-only node
 * yields null → the caller throws rather than building an unencrypted tunnel.
 */
export function selectXRayEntry(metadata: XRayMetadataEntry[]): XRayMetadataEntry | null {
  const usable = metadata.filter(
    (m) => m.proxy_protocol === PROXY_VLESS && TRANSPORT_NETWORK[m.transport_protocol] !== undefined,
  )
  const reality = usable.find((m) => m.transport_security === SECURITY_REALITY)
  if (reality) return reality
  return usable.find((m) => m.transport_security === SECURITY_TLS) ?? null
}

/** Build a single VLESS outbound (reality or tls) for the chosen entry. */
export function buildXRayOutbound(
  entry: XRayMetadataEntry,
  address: string,
  uuid: string,
): Record<string, unknown> {
  const network = TRANSPORT_NETWORK[entry.transport_protocol]
  const port = typeof entry.port === 'string' ? parseInt(entry.port, 10) : entry.port
  const flow = entry.flow === FLOW_VISION ? 'xtls-rprx-vision' : ''

  const streamSettings: Record<string, unknown> = { network }
  if (entry.transport_security === SECURITY_REALITY) {
    streamSettings.security = 'reality'
    streamSettings.realitySettings = {
      serverName: entry.reality_server_name ?? '',
      fingerprint: entry.reality_fingerprint || 'chrome',
      publicKey: entry.reality_public_key ?? '',
      shortId: entry.reality_short_id ?? '',
      spiderX: '',
    }
  } else {
    streamSettings.security = 'tls'
    streamSettings.tlsSettings = {
      serverName: entry.reality_server_name || address,
      fingerprint: entry.reality_fingerprint || 'chrome',
      allowInsecure: false,
    }
  }

  return {
    tag: 'proxy',
    protocol: 'vless',
    settings: {
      vnext: [{ address, port, users: [{ id: uuid, encryption: 'none', flow }] }],
    },
    streamSettings,
  }
}

/**
 * Build the full xray client config: a loopback SOCKS inbound (which tun2socks
 * dials) plus one VLESS outbound derived from the node's handshake metadata.
 * Throws if the node offers no buildable (VLESS + reality/tls over a known
 * transport) entry, or returned no address.
 */
export function buildXRayConfig(
  metadata: XRayMetadataEntry[],
  nodeAddrs: string[],
  uuid: string,
): Record<string, unknown> {
  if (!Array.isArray(metadata) || metadata.length === 0) {
    throw new Error('Xray node returned no service metadata')
  }
  const entry = selectXRayEntry(metadata)
  if (!entry) {
    throw new Error('Xray node offers no supported VLESS config (need VLESS + reality/tls over TCP)')
  }
  const address = Array.isArray(nodeAddrs)
    ? nodeAddrs.find((a) => typeof a === 'string' && a.length > 0)
    : undefined
  if (!address) throw new Error('Xray handshake returned no node address')

  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'socks', listen: SOCKS_LISTEN, port: SOCKS_PORT, protocol: 'socks', settings: { udp: true } },
    ],
    outbounds: [buildXRayOutbound(entry, address, uuid)],
  }
}
