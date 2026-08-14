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
  /**
   * SHA-256 of the node's self-signed TLS certificate, issued per session and sent
   * in the handshake response (go-sdk `ServerMetadata.TLSPin`). REQUIRED for a TLS
   * inbound — see buildHopOutbound. Encoding differs by SDK: v2ray/server.go
   * base64-encodes it, xray/server.go hex-encodes it, so it is normalised on read.
   */
  tls_pin?: string
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
 * The EXIT hop must be plain TCP. Established by experiment against xray 26.3.27
 * (two local vless servers, one transport each, chained through `proxySettings`):
 *
 *   entry tcp  -> exit tcp   WORKS  (also proven live on mainnet, ES -> TR)
 *   entry tcp  -> exit grpc  FAILS  (entry relays the TCP connection, exit never
 *                                    completes a session)
 *   entry tcp  -> exit ws    FAILS  ("connection reset by peer")
 *   entry grpc -> exit tcp   WORKS
 *
 * Controls: grpc and ws both work fine as a DIRECT single hop, so this is a
 * property of chaining, not of the transports. Only plain TCP delegates dialing to
 * xray's detour dialer; grpc brings its own HTTP/2 dialer and ws its own upgrade
 * handshake, and neither routes through the entry.
 *
 * Note which hop this constrains: only the exit rides the detour, so the ENTRY may
 * use any transport we can emit. bluecli requires TCP on both ends; that is stricter
 * than necessary and needlessly shrinks the entry pool.
 */
const EXIT_TRANSPORTS = new Set(['tcp'])

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

/**
 * Normalise a node's TLS pin to the lower-case hex SHA-256 that xray-core's
 * `pinnedPeerCertSha256` requires, or null when it isn't a usable 32-byte digest.
 *
 * Both encodings are accepted regardless of which SDK the hop came from — v2ray
 * base64-encodes the pin and xray hex-encodes it (v2ray/server.go vs
 * xray/server.go, same `sha256.Sum256(cert.Raw)`), and detecting by shape rather
 * than by protocol means a node that switches encoding can't silently break the
 * connect path. Anything that doesn't decode to exactly 32 bytes is rejected: a
 * malformed pin must fail the build, never fall through to an unverified TLS
 * session.
 */
export function normalizeTlsPin(pin: string | undefined): string | null {
  if (typeof pin !== 'string' || pin.length === 0) return null
  const trimmed = pin.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase()
  if (!/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(trimmed)) return null
  try {
    const buf = Buffer.from(trimmed, 'base64')
    // Buffer.from is lenient, so verify the round-trip rather than trusting length.
    if (buf.length !== 32 || buf.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
      return null
    }
    return buf.toString('hex')
  } catch {
    return null
  }
}

function parsePort(raw: string | number): number | null {
  const port = typeof raw === 'string' ? parseInt(raw, 10) : raw
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

/**
 * Pick the inbound to build this hop's outbound from. Requires: an emittable
 * transport, a usable port, and not cleartext. An `exit` additionally must be plain
 * TCP (see EXIT_TRANSPORTS). Prefers Reality, then TLS, then whatever is left
 * (VMess-none) — the same "prefer encrypted" ordering the single-hop paths use.
 *
 * Returns null when the node offers nothing buildable; callers turn that into a
 * throw so the session is refunded rather than connected insecurely.
 */
export function selectHopEntry(spec: HopSpec, role: HopRole): HopMetadataEntry | null {
  const usable = spec.metadata.filter((m) => {
    const name = transportName(spec.protocol, m.transport_protocol)
    if (name === null) return false
    if (role === 'exit' && !EXIT_TRANSPORTS.has(name)) return false
    if (NETWORK_BY_TRANSPORT[name] === undefined) return false
    if (parsePort(m.port) === null) return false
    // A TLS inbound is only usable if the node sent a pin we can verify it against.
    // Without one there is no way to authenticate a self-signed cert, and xray no
    // longer offers an "accept anything" mode — the go-sdk's own client config makes
    // the same check (client_config.go: TransportSecurityTLS && TLSPin == "" → error).
    if (m.transport_security === SECURITY_TLS && normalizeTlsPin(m.tls_pin) === null) return false
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
    // Sentinel nodes use self-signed certs, so the certificate is authenticated by
    // PINNING the digest the node sent in its own handshake — NOT by name, and not
    // by trusting anything (`allowInsecure` was removed outright in xray 26.x and is
    // now a hard config error). This mirrors upstream's own xray client template,
    // which likewise sends fingerprint + pin and no serverName: once the exact
    // certificate is pinned, hostname verification adds nothing, and the dial
    // address is an IP by then anyway (pinV2RayNodeAddresses).
    //
    // selectHopEntry guarantees a usable pin exists for any TLS entry it returns, so
    // this cannot silently degrade to an unverified session.
    streamSettings.tlsSettings = {
      fingerprint: entry.reality_fingerprint || 'chrome',
      pinnedPeerCertSha256: normalizeTlsPin(entry.tls_pin),
    }
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
  // Distinguish "TLS but unpinnable" from "wrong transport": the node's cert is
  // self-signed, so without its pin there is nothing to verify it against.
  const pinnableBlocked = spec.metadata.some(
    (m) => m.transport_security === SECURITY_TLS && normalizeTlsPin(m.tls_pin) === null,
  )
  if (pinnableBlocked && !spec.metadata.some((m) => normalizeTlsPin(m.tls_pin) !== null)) {
    throw new Error(
      `Multihop ${role} node offered a TLS inbound but no usable certificate pin ` +
      '(tls_pin), so its self-signed certificate cannot be verified. Pick a different node.',
    )
  }
  throw new Error(
    role === 'exit'
      ? 'Multihop exit node offers no plain-TCP inbound. Only TCP can be carried through ' +
        'the entry hop — grpc and websocket bring their own dialer and fail when chained. ' +
        'Pick a different exit node (the entry may use any transport).'
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
