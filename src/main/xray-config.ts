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
  /**
   * SHA-256 of the node's self-signed TLS certificate, issued per session in the
   * handshake response (go-sdk `ServerMetadata.TLSPin`). REQUIRED for a TLS entry:
   * the certificate is self-signed, so there is no CA to check it against and the
   * pin is the only thing that authenticates the node. Reality needs none — it
   * authenticates by public key instead.
   */
  tls_pin?: string
  flow?: number
  reality_server_name?: string
  reality_short_id?: string
  reality_public_key?: string
  reality_fingerprint?: string
}

/**
 * Normalise a node's TLS pin to the lower-case hex SHA-256 that xray-core's
 * `pinnedPeerCertSha256` requires, or null when it is not a usable 32-byte digest.
 * Both encodings are accepted by shape: v2ray's SDK base64-encodes the pin and
 * xray's hex-encodes it (same `sha256.Sum256(cert.Raw)`), and detecting by shape
 * rather than by protocol means a node that switches encoding cannot silently
 * break the connect path. Anything that does not decode to exactly 32 bytes is
 * rejected — a malformed pin must fail the build, never fall through to an
 * unverified TLS session.
 *
 * Duplicated from multihop-config.ts rather than imported, because every pure
 * builder in this directory stays import-free for the native test runner (see
 * isCleartextEntry there for the same arrangement). A test asserts the two agree.
 */
export function normalizeXRayTlsPin(pin: string | undefined): string | null {
  if (typeof pin !== 'string' || pin.length === 0) return null
  const trimmed = pin.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase()
  if (!/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(trimmed)) return null
  try {
    const buf = Buffer.from(trimmed, 'base64')
    if (buf.length !== 32 || buf.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
      return null
    }
    return buf.toString('hex')
  } catch {
    return null
  }
}

/**
 * Can this Reality entry build an outbound that xray will actually start on? Requires
 * a `reality_public_key` that decodes to 32 bytes (an x25519 public key, base64url
 * from `xray x25519`, standard base64 also accepted) and a non-empty
 * `reality_server_name` (it becomes the outer ClientHello's SNI). `reality_short_id`
 * is not required — empty is a valid server configuration.
 *
 * Duplicated from multihop-config.ts's isUsableReality for the same reason
 * normalizeXRayTlsPin is; a test asserts the two agree.
 */
export function isUsableXRayReality(entry: XRayMetadataEntry): boolean {
  const name = entry.reality_server_name
  if (typeof name !== 'string' || name.trim() === '') return false
  const key = entry.reality_public_key
  if (typeof key !== 'string') return false
  const trimmed = key.trim()
  if (!/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(trimmed)) return false
  try {
    return Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 32
  } catch {
    return false
  }
}

const PROXY_VLESS = 1
const SECURITY_TLS = 2
const SECURITY_REALITY = 3
const FLOW_VISION = 2

// Only transports we can name are emitted. tcp is confirmed via the aggregator
// decoding transport_protocol=1 as {transport:'tcp'}; extend as others are confirmed.
const TRANSPORT_NETWORK: Record<number, string> = { 1: 'tcp' }

const SOCKS_LISTEN = '127.0.0.1'
// Inlined (not imported from shared/socks.ts) so the native test runner can
// load this module directly; the test asserts the built config matches it.
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
  // Reality entries are checked the same way TLS entries are: an entry whose keys
  // can't build a working outbound must not be selected. It used to be taken on
  // trust, and being PREFERRED meant a node advertising Reality with blank keys was
  // chosen over a pinned TLS inbound on the same node, emitting `publicKey: ''` — a
  // config xray rejects at spawn, which is after the session is paid for.
  const reality = usable.find(
    (m) => m.transport_security === SECURITY_REALITY && isUsableXRayReality(m),
  )
  if (reality) return reality
  // A TLS entry without a usable pin is NOT selectable: the node's certificate is
  // self-signed, so with no pin there is nothing to verify it against and xray no
  // longer offers an "accept anything" mode. The go-sdk's own client makes the same
  // check (client_config.go: TransportSecurityTLS && TLSPin == "" -> error).
  return usable.find(
    (m) => m.transport_security === SECURITY_TLS && normalizeXRayTlsPin(m.tls_pin) !== null,
  ) ?? null
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
    // Sentinel nodes serve self-signed certificates, so the node is authenticated by
    // PINNING the digest it sent in its own handshake — not by name, and not by
    // trusting anything. `allowInsecure` was removed outright in xray 26.x and is now
    // a hard config error, and `serverName` adds nothing once the exact certificate is
    // pinned (the dial address is an IP by then anyway, via pinV2RayNodeAddresses).
    // selectXRayEntry guarantees a usable pin for any TLS entry it returns, so this
    // cannot degrade to an unverified session.
    streamSettings.tlsSettings = {
      fingerprint: entry.reality_fingerprint || 'chrome',
      pinnedPeerCertSha256: normalizeXRayTlsPin(entry.tls_pin),
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
