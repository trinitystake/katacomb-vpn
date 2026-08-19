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
const SOCKS_TAG = 'socks'

const SOCKS_LISTEN = '127.0.0.1'
// Inlined (not imported from shared/socks.ts) so the native test runner can
// load this module directly; the test asserts the built config matches it.
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

/**
 * BOTH hops of a chain must be wrapped in TLS or Reality. This is stricter than the
 * single-hop rule, which also accepts VMess with no transport security — VMess
 * carries its own AEAD cipher, so that is encrypted, just not disguised.
 *
 * The difference matters here and only here. A chain is opt-in, costs two sessions
 * and roughly 20x the latency, and is chosen for exactly one reason: to stop any
 * single party correlating who you are with where you go. The entry hop is the one
 * your own network sees, and VMess over gRPC without TLS is cleartext HTTP/2 on an
 * unusual port — the payload is safe, but the connection is trivially recognisable
 * as "not the web". Paying double for privacy and then announcing the circuit to
 * the nearest observer is not a trade worth offering.
 *
 * Cost measured 2026-08-14: 211 of 241 healthy v9.0.0 nodes still qualify as an
 * entry (30 lost) and 140 as an exit. Single-hop connects are untouched — this
 * function is only reachable through buildMultihopConfig.
 */
function isChainGradeSecurity(entry: HopMetadataEntry): boolean {
  return entry.transport_security === SECURITY_TLS || entry.transport_security === SECURITY_REALITY
}

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

/**
 * Is this Reality inbound one we can actually build a working outbound from?
 *
 * Reality's counterpart to the TLS pin check, and it was missing. A TLS inbound with
 * no usable `tls_pin` is refused (there is nothing to verify the self-signed cert
 * against), but a Reality inbound was taken entirely on trust — and Reality is
 * PREFERRED first, so a node advertising `transport_security: 3` with blank keys was
 * chosen ahead of a perfectly good TLS inbound on the same node. `buildHopOutbound`
 * then emitted `publicKey: ''`, the config built cleanly, and xray rejected it at
 * spawn: a failure that lands AFTER establishChainOrRefund has returned, so neither
 * deposit is refunded and "Retry connection" can never succeed.
 *
 * Two things are required and no more:
 *  - `reality_public_key` must decode to exactly 32 bytes (an x25519 public key).
 *    `xray x25519` emits base64url, but standard base64 is accepted too rather than
 *    silently refusing a node over an encoding difference, the same way
 *    normalizeTlsPin takes either.
 *  - `reality_server_name` must be non-empty: it becomes the SNI of the outer
 *    ClientHello, and the node's Reality server matches its dest against it.
 * `reality_short_id` is deliberately NOT required — an empty short id is a valid,
 * common server configuration.
 */
export function isUsableReality(entry: HopMetadataEntry): boolean {
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

function parsePort(raw: string | number): number | null {
  const port = typeof raw === 'string' ? parseInt(raw, 10) : raw
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

/**
 * Everything about an inbound EXCEPT whether its key material is usable: an emittable
 * transport, a usable port, and TLS/Reality. Split out so requireEntry can tell
 * "wrong shape" from "right shape, unusable keys" and report the one that is actually
 * blocking, instead of blaming a grpc-only node's Reality keys.
 */
function isShapeUsable(spec: HopSpec, role: HopRole, m: HopMetadataEntry): boolean {
  const name = transportName(spec.protocol, m.transport_protocol)
  if (name === null) return false
  if (role === 'exit' && !EXIT_TRANSPORTS.has(name)) return false
  if (NETWORK_BY_TRANSPORT[name] === undefined) return false
  if (parsePort(m.port) === null) return false
  return isChainGradeSecurity(m)
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
    if (!isShapeUsable(spec, role, m)) return false
    // A TLS inbound is only usable if the node sent a pin we can verify it against.
    // Without one there is no way to authenticate a self-signed cert, and xray no
    // longer offers an "accept anything" mode — the go-sdk's own client config makes
    // the same check (client_config.go: TransportSecurityTLS && TLSPin == "" → error).
    if (m.transport_security === SECURITY_TLS && normalizeTlsPin(m.tls_pin) === null) return false
    // The same rule for Reality: an entry whose keys can't build a working outbound
    // must not be selected, or the chain is paid for and then fails at spawn — past
    // the point anything refunds it (see isUsableReality).
    if (m.transport_security === SECURITY_REALITY && !isUsableReality(m)) return false
    // No cleartext check is needed here: TLS/Reality already excludes it, since the
    // only cleartext combination is VLess with no transport security.
    return true
  })
  if (usable.length === 0) return null
  return (
    usable.find((m) => m.transport_security === SECURITY_REALITY) ??
    usable.find((m) => m.transport_security === SECURITY_TLS) ??
    usable[0]
  )
}

/** What a node can serve as, judged from the inbounds it advertises publicly. */
export interface HopEligibility {
  /** Transport names this node advertises, decoded with its own protocol's table. */
  transports: string[]
  /** Has an emittable TLS/Reality inbound — usable as the ENTRY hop of a chain. */
  entry: boolean
  /** Has a TLS/Reality PLAIN-TCP inbound — usable as the EXIT hop of a chain. */
  exit: boolean
  /** How the entry-capable inbound would be wrapped, or null if none qualifies. */
  entrySecurity: 'reality' | 'tls' | null
  /**
   * How the exit-capable inbound would be wrapped, best first, or null when none
   * qualifies. Only ever 'reality' or 'tls' now that both ends require one of them
   * (see isChainGradeSecurity); it is still reported so the picker can show which,
   * rather than making the user take "usable" on trust.
   */
  exitSecurity: 'reality' | 'tls' | null
}

/**
 * Grade a node for each end of a chain from the `service_metadata` it publishes at
 * its ROOT path — the pre-purchase counterpart to `selectHopEntry`. This is what
 * lets the picker refuse an unusable exit BEFORE two sessions are paid for, rather
 * than discovering it in the handshake and refunding.
 *
 * It deliberately checks LESS than selectHopEntry, because the public listing
 * carries less: `port` is reported as `""` and `tls_pin` as `""` on every node
 * measured (241/241 healthy v9 nodes) — both are minted per session and only
 * arrive in the paid handshake response. So this answers "is this node the right
 * SHAPE for this role", and selectHopEntry still has the final say. Anything it
 * passes that the builder then rejects is refunded by establishChainOrRefund.
 *
 * Do NOT be tempted to grade from the node list's `connection` field instead: the
 * aggregator publishes only ONE triple per node (its first inbound), which reports
 * tcp for 16 nodes network-wide while 138 of 241 actually serve a TCP inbound.
 */
export function classifyHopEligibility(
  protocol: HopProtocol,
  metadata: HopMetadataEntry[],
): HopEligibility {
  if (!Array.isArray(metadata)) {
    return { transports: [], entry: false, exit: false, entrySecurity: null, exitSecurity: null }
  }
  const named = metadata.map((m) => ({ entry: m, name: transportName(protocol, m.transport_protocol) }))
  // Chain policy, not the single-hop one: TLS or Reality on both ends.
  const usable = named.filter(
    (n) => n.name !== null && NETWORK_BY_TRANSPORT[n.name] !== undefined && isChainGradeSecurity(n.entry),
  )
  const exits = usable.filter((n) => EXIT_TRANSPORTS.has(n.name as string))
  // Same "prefer encrypted" ordering selectHopEntry uses, so what is shown is what
  // would be built.
  const pick = (from: typeof usable) =>
    from.find((n) => n.entry.transport_security === SECURITY_REALITY)
    ?? from.find((n) => n.entry.transport_security === SECURITY_TLS)
    ?? from[0]
  const label = (n: typeof usable[number] | undefined): 'reality' | 'tls' | null =>
    n === undefined ? null : n.entry.transport_security === SECURITY_REALITY ? 'reality' : 'tls'
  return {
    transports: [...new Set(named.map((n) => n.name).filter((n): n is string => n !== null))],
    entry: usable.length > 0,
    exit: exits.length > 0,
    entrySecurity: label(pick(usable)),
    exitSecurity: label(pick(exits)),
  }
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
  if (!spec.metadata.some((m) => isChainGradeSecurity(m))) {
    // Two different faults, and the distinction is worth keeping: a cleartext-only
    // node is unsafe at any hop, while a VMess-without-TLS node is fine single-hop
    // and refused only by the stricter chain rule.
    throw new Error(
      spec.metadata.every((m) => isCleartextEntry(m))
        ? `Multihop ${role} node offers only cleartext (VLess without TLS) inbounds`
        : `Multihop ${role} node offers no TLS or Reality inbound. Both hops of a chain must be ` +
          'wrapped, so neither the connection to the entry nor the one to the exit is recognisable ' +
          'as a proxy. This node is still usable for an ordinary single-hop connection.',
    )
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
  // The Reality equivalent: an inbound of exactly the right shape for this role,
  // refused only because its keys can't build a working outbound. Worth its own
  // message, because the node looks fully qualified right up to the point xray
  // refuses to start on it.
  if (spec.metadata.some((m) =>
    isShapeUsable(spec, role, m) && m.transport_security === SECURITY_REALITY && !isUsableReality(m)
  )) {
    throw new Error(
      `Multihop ${role} node offered a Reality inbound with no usable public key or ` +
      'server name, so there is nothing to authenticate it with. Pick a different node.',
    )
  }
  throw new Error(
    role === 'exit'
      ? 'Multihop exit node offers no plain-TCP inbound. Only TCP can be carried through ' +
        'the entry hop: grpc and websocket bring their own dialer and fail when chained. ' +
        'Pick a different exit node (the entry may use any transport).'
      : 'Multihop entry node offers no supported transport (tcp, websocket or grpc)',
  )
}

/**
 * Build a config for the ENTRY HOP ALONE, exposing nothing but a loopback SOCKS5
 * listener on `socksPort`.
 *
 * This is what lets the exit hop be provisioned without the exit ever seeing the user's
 * address. The exit's grade, its preflight and above all its signed handshake are
 * session-bound and are followed seconds later by the user's traffic, so a node that
 * records who asked can join the two — the very thing a chain is bought to prevent. Run
 * through this proxy instead, they arrive from the ENTRY.
 *
 * Deliberately minimal, because it exists for a handful of HTTPS requests and is torn
 * down before the real tunnel is built: no exit outbound, no UDP (CONNECT is all the
 * agent needs), and its own port so it cannot collide with the live listener on 1080.
 * The shape is otherwise the chained config's, so it flows through the same
 * pinV2RayNodeAddresses / assertSafeV2RayConfig transforms with no special casing.
 *
 * Graded as an 'entry', the same rule the chain itself applies, so a node that cannot be
 * a chain entry fails here rather than after its session is paid for.
 */
export function buildEntryOnlyConfig(entryHop: HopSpec, socksPort: number): Record<string, unknown> {
  if (!Number.isInteger(socksPort) || socksPort <= 0 || socksPort > 65535) {
    throw new Error(`Multihop provisioning proxy: invalid port ${socksPort}`)
  }
  const entryMeta = requireEntry(entryHop, 'entry')
  const entryAddress = firstAddress(entryHop, 'entry')
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: SOCKS_TAG,
        listen: SOCKS_LISTEN,
        port: socksPort,
        protocol: 'socks',
        settings: { udp: false },
      },
    ],
    outbounds: [buildHopOutbound(entryHop, entryMeta, entryAddress, ENTRY_TAG)],
  }
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
