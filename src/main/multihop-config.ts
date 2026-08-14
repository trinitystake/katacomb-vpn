// Pure builder for a TWO-HOP (multihop) v2ray/xray CLIENT config: one process,
// two outbounds, where the exit outbound dials THROUGH the entry outbound via
// v2ray-core's native `proxySettings.tag`. Physical path:
//
//     this host --> entry node --> exit node --> internet
//
// Only the ENTRY is a direct connection from this host, so it is the only endpoint
// that needs an IPv4 pin, a tun2socks bypass route and a kill-switch whitelist. The
// exit is reached inside the entry tunnel, so the entry node resolves it for us.
// `extractV2RayRemoteHost` (vpn-manager.ts) picks the entry back out by looking for
// the outbound WITHOUT `proxySettings` — keep that contract if the shape changes.
//
// The output is the same JSON shape single-hop emits, so it flows through the
// existing transforms (pinV2RayNodeAddresses / withV2RayDiagnosticLog /
// assertSafeV2RayConfig / withV2RayDoH) and tun2socks routing with no changes.
// The EXIT outbound is deliberately first: v2ray/xray treat outbounds[0] as the
// default egress, and the user's traffic must leave via the exit. withV2RayDoH's
// `outbounds[0]` fallback therefore also lands on the exit, which is what DNS wants.
//
// ---------------------------------------------------------------------------
// The two enums are NOT the same. Verified against sentinel-go-sdk master:
//   v2ray/transport.go  0=unspecified 1=domainsocket 2=gun 3=grpc 4=http
//                       5=mkcp 6=quic 7=tcp 8=websocket
//   xray/transport.go   0=unspecified 1=tcp 2=websocket 3=grpc 4=httpupgrade 5=xhttp
// So `transport_protocol: 1` means DOMAINSOCKET on a v2ray node and TCP on an xray
// one. Decoding with the wrong table silently builds a config for the wrong
// transport, so every lookup goes through the node's own protocol.
// TransportSecurity agrees across both (1=none, 2=tls) and xray adds 3=reality.
// ---------------------------------------------------------------------------
//
// Node data is UNTRUSTED (see the node-trust invariant in config-guard.ts). This
// module only shapes JSON from scalars — the node never supplies config structure —
// and assertSafeV2RayConfig still runs before anything is written or spawned.
//
// Electron-free + unit-tested (native runner), like xray-config.ts.

export type HopProtocol = 'v2ray' | 'xray'

/** One inbound a node advertises. Shape is the go-sdk ServerMetadata plus xray's
 *  reality fields; both protocols' handshakes return this. */
export interface HopMetadataEntry {
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

/** Everything one hop contributes, taken straight from its own handshake. */
export interface HopSpec {
  protocol: HopProtocol
  metadata: HopMetadataEntry[]
  /** `result.addrs` — bare hosts; the port comes from the metadata entry. */
  addrs: string[]
  uuid: string
}

export type HopRole = 'entry' | 'exit'

export const ENTRY_TAG = 'entry-out'
export const EXIT_TAG = 'exit-out'
export const SOCKS_TAG = 'socks'

const SOCKS_LISTEN = '127.0.0.1'
const SOCKS_PORT = 1080

const PROXY_VLESS = 1
const PROXY_VMESS = 2
const SECURITY_NONE = 1
const SECURITY_TLS = 2
const SECURITY_REALITY = 3
const FLOW_VISION = 2

const V2RAY_TRANSPORT: Record<number, string> = {
  // 1 = domainsocket is deliberately absent: a UNIX socket is not remotely dialable.
  2: 'gun', 3: 'grpc', 4: 'http', 5: 'mkcp', 6: 'quic', 7: 'tcp', 8: 'websocket',
}
const XRAY_TRANSPORT: Record<number, string> = {
  1: 'tcp', 2: 'websocket', 3: 'grpc', 4: 'httpupgrade', 5: 'xhttp',
}

/**
 * Transports we emit correct streamSettings for. Deliberately narrow: naming a
 * transport we cannot configure would build a config that fails to route rather
 * than one that refuses to build. Widen only with a live-verified node.
 */
const NETWORK_BY_TRANSPORT: Record<string, string> = {
  tcp: 'tcp',
  websocket: 'ws',
  grpc: 'grpc',
}

/**
 * UDP-based transports. An EXIT hop rides a TCP stream proxied through the entry,
 * so it can never be one of these. An entry hop could be (we dial it directly),
 * but none are emittable today — this set exists so widening NETWORK_BY_TRANSPORT
 * for the entry can't silently make a UDP exit legal.
 */
const UDP_TRANSPORTS = new Set(['mkcp', 'quic'])

/** Decode a hop's transport enum with ITS OWN protocol's table. */
export function transportName(protocol: HopProtocol, value: number): string | null {
  const table = protocol === 'xray' ? XRAY_TRANSPORT : V2RAY_TRANSPORT
  return table[value] ?? null
}

/**
 * Is this inbound cleartext at the proxy layer? Mirrors `classifyV2RayInbound` in
 * config-guard.ts: VMess carries its own AEAD cipher and any TLS/Reality transport
 * is protected; only VLess with no transport security is cleartext. Inlined rather
 * than imported to keep this module import-free for the native test runner — the
 * test asserts the two agree, the same arrangement connect-errors.ts uses.
 */
export function isCleartextEntry(entry: HopMetadataEntry): boolean {
  if (entry.proxy_protocol === PROXY_VMESS) return false
  if (entry.transport_security === SECURITY_TLS) return false
  if (entry.transport_security === SECURITY_REALITY) return false
  return entry.proxy_protocol === PROXY_VLESS && entry.transport_security === SECURITY_NONE
}

function parsePort(raw: string | number): number | null {
  const port = typeof raw === 'string' ? parseInt(raw, 10) : raw
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

/**
 * Pick the inbound to build this hop's outbound from. Requires: an emittable
 * transport, a usable port, and not cleartext. An `exit` additionally may not be a
 * UDP transport. Prefers Reality, then TLS, then whatever is left (VMess-none) —
 * the same "prefer encrypted" ordering the single-hop paths use.
 *
 * Returns null when the node offers nothing buildable; callers turn that into a
 * throw so the session is refunded rather than connected insecurely.
 */
export function selectHopEntry(spec: HopSpec, role: HopRole): HopMetadataEntry | null {
  const usable = spec.metadata.filter((m) => {
    const name = transportName(spec.protocol, m.transport_protocol)
    if (name === null) return false
    if (role === 'exit' && UDP_TRANSPORTS.has(name)) return false
    if (NETWORK_BY_TRANSPORT[name] === undefined) return false
    if (parsePort(m.port) === null) return false
    return !isCleartextEntry(m)
  })
  if (usable.length === 0) return null
  return (
    usable.find((m) => m.transport_security === SECURITY_REALITY) ??
    usable.find((m) => m.transport_security === SECURITY_TLS) ??
    usable[0]
  )
}

/**
 * Build one hop's outbound. `dialThrough`, when set, makes this outbound establish
 * its connection through the outbound carrying that tag — the whole mechanism
 * behind chaining (v2ray-core v4/v5 and xray-core all support it).
 */
export function buildHopOutbound(
  spec: HopSpec,
  entry: HopMetadataEntry,
  address: string,
  tag: string,
  dialThrough?: string,
): Record<string, unknown> {
  const name = transportName(spec.protocol, entry.transport_protocol)
  const network = name === null ? 'tcp' : NETWORK_BY_TRANSPORT[name] ?? 'tcp'
  const port = parsePort(entry.port)
  const isVless = entry.proxy_protocol === PROXY_VLESS

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
  } else if (entry.transport_security === SECURITY_TLS) {
    streamSettings.security = 'tls'
    // Sentinel nodes use self-signed certs — the chain-side signature authenticates
    // the node, not the certificate. SNI stays the advertised host so vhost routing
    // still matches after pinV2RayNodeAddresses rewrites the dial address to an IP.
    streamSettings.tlsSettings = { serverName: address, allowInsecure: true }
  }
  if (network === 'grpc') streamSettings.grpcSettings = {}
  if (network === 'ws') streamSettings.wsSettings = {}

  const user = isVless
    ? { id: spec.uuid, encryption: 'none', flow: entry.flow === FLOW_VISION ? 'xtls-rprx-vision' : '' }
    : { id: spec.uuid, alterId: 0 }

  const outbound: Record<string, unknown> = {
    tag,
    protocol: isVless ? 'vless' : 'vmess',
    settings: { vnext: [{ address, port, users: [user] }] },
    streamSettings,
  }
  if (dialThrough) outbound.proxySettings = { tag: dialThrough }
  return outbound
}

function firstAddress(spec: HopSpec, role: HopRole): string {
  const address = Array.isArray(spec.addrs)
    ? spec.addrs.find((a) => typeof a === 'string' && a.length > 0)
    : undefined
  if (!address) throw new Error(`Multihop ${role} node returned no address`)
  return address
}

function requireEntry(spec: HopSpec, role: HopRole): HopMetadataEntry {
  if (!Array.isArray(spec.metadata) || spec.metadata.length === 0) {
    throw new Error(`Multihop ${role} node returned no service metadata`)
  }
  const picked = selectHopEntry(spec, role)
  if (picked) return picked
  // Distinguish the two failure causes — the exit-only one is actionable ("pick a
  // different exit"), the cleartext one is a policy refusal.
  const anyEncrypted = spec.metadata.some((m) => !isCleartextEntry(m))
  if (!anyEncrypted) {
    throw new Error(`Multihop ${role} node offers only cleartext (VLess without TLS) inbounds`)
  }
  throw new Error(
    role === 'exit'
      ? 'Multihop exit node offers no TCP-based transport (tcp, websocket or grpc) — ' +
        'a UDP transport such as mkcp or quic cannot be carried through the entry hop. ' +
        'Pick a different exit node.'
      : 'Multihop entry node offers no supported transport (tcp, websocket or grpc)',
  )
}

/**
 * Build the chained client config. Throws (→ the caller refunds both sessions) when
 * either hop offers nothing buildable, is cleartext-only, or returned no address.
 */
export function buildMultihopConfig(entryHop: HopSpec, exitHop: HopSpec): Record<string, unknown> {
  const entryMeta = requireEntry(entryHop, 'entry')
  const exitMeta = requireEntry(exitHop, 'exit')
  const entryAddress = firstAddress(entryHop, 'entry')
  const exitAddress = firstAddress(exitHop, 'exit')

  const entryOutbound = buildHopOutbound(entryHop, entryMeta, entryAddress, ENTRY_TAG)
  const exitOutbound = buildHopOutbound(exitHop, exitMeta, exitAddress, EXIT_TAG, ENTRY_TAG)

  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: SOCKS_TAG,
        listen: SOCKS_LISTEN,
        port: SOCKS_PORT,
        protocol: 'socks',
        settings: { udp: true },
      },
    ],
    // Exit first: outbounds[0] is v2ray/xray's default egress.
    outbounds: [exitOutbound, entryOutbound],
  }
}
