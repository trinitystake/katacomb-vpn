/**
 * Pure validators that sit between untrusted VPN-node data and the privileged
 * helper / child processes. Node operators are part of the threat model: a
 * node's WireGuard config can carry `PostUp`/`PreUp`/… directives that
 * `wg-quick` runs as root, and its V2Ray config / split-tunnel routes feed
 * `ip route` (also root). These functions reject anything outside a strict
 * allow-list before it reaches those sinks.
 *
 * No Electron/Node-fs (or runtime SDK) imports here — kept pure so it is
 * unit-testable in isolation (see config-guard.test.ts). The single SDK import
 * is type-only (erased at runtime), so the module stays dependency-free.
 */
import type { V2RayMetadata } from '@sentinel-official/sentinel-js-sdk'

// WireGuard keys we accept. Anything else (notably the script-executing
// PostUp/PreUp/PostDown/PreDown, plus Table/SaveConfig/FwMark) is rejected.
const WG_INTERFACE_KEYS = new Set(['privatekey', 'address', 'dns', 'mtu', 'listenport'])
const WG_PEER_KEYS = new Set([
  'publickey',
  'presharedkey',
  'allowedips',
  'endpoint',
  'persistentkeepalive',
])

// Value shapes for the allow-listed keys. Hosts allow letters (hostnames), digits,
// dots/colons (IPv6), underscores and hyphens — but NOT whitespace, commas-in-item,
// or shell/control characters. List fields (address/allowedips/dns) are split on
// commas first. This is format hardening behind the key allow-list; it deliberately
// stays lenient enough to never reject legitimate SDK-generated configs (incl.
// full-tunnel `AllowedIPs = 0.0.0.0/0, ::/0`).
const WG_HOST_OR_CIDR = /^\[?[A-Za-z0-9.:_-]+\]?(\/\d{1,3})?$/
const WG_ENDPOINT = /^\[?[A-Za-z0-9.:_-]+\]?:\d{1,5}$/
// Any base64 string — we only care that keys carry no shell/control characters,
// not that they're a specific length (a valid-shaped wrong key just fails the
// handshake harmlessly; enforcing 44 chars would false-reject test fixtures and
// any future key sizing).
const WG_KEY = /^[A-Za-z0-9+/]+={0,2}$/
const WG_UINT = /^\d{1,7}$/

function assertWgListValue(key: string, value: string): void {
  for (const raw of value.split(',')) {
    const item = raw.trim()
    if (item === '') continue
    if (!WG_HOST_OR_CIDR.test(item)) {
      throw new Error(`WireGuard config: "${key}" entry "${item}" is malformed`)
    }
  }
}

/**
 * Throw if the VALUE for an allow-listed WireGuard key is malformed. Complements
 * the key allow-list: keeps shell/control characters and other garbage out of the
 * root-owned wg-quick config even for keys that are permitted (finding: config
 * value-format validation, defense-in-depth behind C1).
 */
function assertSafeWireguardValue(key: string, value: string): void {
  const v = value.trim()
  switch (key) {
    case 'mtu':
    case 'listenport':
    case 'persistentkeepalive':
      if (!WG_UINT.test(v)) throw new Error(`WireGuard config: "${key}" must be a number`)
      break
    case 'privatekey':
    case 'publickey':
    case 'presharedkey':
      if (!WG_KEY.test(v)) throw new Error(`WireGuard config: "${key}" is not a valid key`)
      break
    case 'endpoint':
      if (!WG_ENDPOINT.test(v)) throw new Error(`WireGuard config: "${key}" must be host:port`)
      break
    case 'address':
    case 'allowedips':
    case 'dns':
      assertWgListValue(key, value)
      break
    default:
      break
  }
}

/**
 * Throw if a WireGuard config string contains any directive outside the
 * allow-list, or an allow-listed key whose value is malformed. This is the guard
 * for the wg-quick `PostUp` root-exec LPE, plus value-format hardening.
 */
export function assertSafeWireguardConfig(config: string): void {
  let section: 'interface' | 'peer' | null = null

  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue

    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      const name = sectionMatch[1].trim().toLowerCase()
      if (name !== 'interface' && name !== 'peer') {
        throw new Error(`WireGuard config: section [${sectionMatch[1]}] is not allowed`)
      }
      section = name
      continue
    }

    const eq = line.indexOf('=')
    if (eq === -1) {
      throw new Error(`WireGuard config: malformed line is not allowed: ${line}`)
    }
    const key = line.slice(0, eq).trim().toLowerCase()
    if (!section) {
      throw new Error(`WireGuard config: key "${key}" outside any section is not allowed`)
    }
    const allowed = section === 'interface' ? WG_INTERFACE_KEYS : WG_PEER_KEYS
    if (!allowed.has(key)) {
      throw new Error(`WireGuard config: key "${key}" in [${section}] is not allowed`)
    }
    assertSafeWireguardValue(key, line.slice(eq + 1).trim())
  }
}

/**
 * Extract the host portion of the WireGuard `Endpoint = host:port` line, or
 * null if absent. Used to whitelist the real server in the kill switch.
 */
export function extractWireguardEndpointHost(config: string): string | null {
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim().toLowerCase() !== 'endpoint') continue

    const value = line.slice(eq + 1).trim()
    if (value.startsWith('[')) {
      // bracketed IPv6: [::1]:51820
      const close = value.indexOf(']')
      return close > 0 ? value.slice(1, close) : null
    }
    const colon = value.lastIndexOf(':')
    return colon > 0 ? value.slice(0, colon) : value || null
  }
  return null
}

/**
 * Rewrite `Endpoint = host:port` to `Endpoint = <ipv4>:port`, resolving the host
 * once, before the tunnel exists. Same medicine pinV2RayNodeAddresses applies to
 * v2ray/xray and the inline pin applies to hysteria2/openvpn — WireGuard and
 * AmneziaWG were the only protocols still handing a hostname to the tunnel.
 *
 * Why it is load-bearing here, in two separate ways:
 *  - The kill switch whitelists the server by IP (`-d host/32 -j ACCEPT`). With a
 *    hostname Endpoint, getWireGuardRemoteHost() finds no IPv4 and the whitelist
 *    ends up covering nothing, so the DROP-all rule blackholes the tunnel's OWN
 *    outer UDP. The interface comes up, wg reports no error, and not one packet
 *    is ever answered.
 *  - wg-quick re-resolves the hostname on every `up`. On a reconnect with the kill
 *    switch armed that lookup goes into a tunnel that isn't carrying traffic yet —
 *    the same deadlock the v2ray fix was written for.
 *
 * Unresolvable hostnames are left untouched (best effort, matching the v2ray
 * helper); the caller decides whether to arm the kill switch without an IP.
 */
export function pinWireguardEndpoint(
  config: string,
  resolve: (host: string) => string | null,
): string {
  return config
    .split('\n')
    .map((raw) => {
      const eq = raw.indexOf('=')
      if (eq === -1) return raw
      if (raw.slice(0, eq).trim().toLowerCase() !== 'endpoint') return raw
      const value = raw.slice(eq + 1).trim()
      // Bracketed IPv6 has no IPv4 to pin to; leave it alone.
      if (value.startsWith('[')) return raw
      const colon = value.lastIndexOf(':')
      if (colon <= 0) return raw
      const host = value.slice(0, colon)
      const port = value.slice(colon + 1)
      if (isIPv4(host)) return raw
      const ip = resolve(host)
      if (!ip || !isIPv4(ip)) return raw
      return `${raw.slice(0, eq)}= ${ip}:${port}`
    })
    .join('\n')
}

const MAX_BYPASS_ROUTES = 64

/**
 * Trailing sentinel appended to the helper's `killswitch-on` argv to request the
 * local-network ACCEPT rules. A sentinel rather than a fourth positional arg
 * because the DNS arg before it is optional. **The bash helper hardcodes this
 * same literal** (LAN_SHARING_ARG) — change both together.
 */
export const LAN_SHARING_ARG = 'lan-sharing'

/**
 * True if `cidr` is a well-formed IPv4 CIDR safe to install as a split-tunnel
 * bypass route. Rejects the default-route swallow vectors (`/0`, `0.0.0.0/x`)
 * and out-of-range octets/prefixes.
 */
export function isAllowedBypassCidr(cidr: string): boolean {
  const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/)
  if (!m) return false
  const octets = [m[1], m[2], m[3], m[4]].map((o) => parseInt(o, 10))
  const prefix = parseInt(m[5], 10)
  if (octets.some((o) => o > 255)) return false
  if (prefix < 1 || prefix > 32) return false
  if (octets.every((o) => o === 0)) return false // 0.0.0.0/x — would bypass the whole tunnel
  return true
}

/** Trim, drop invalid entries, and cap the count of split-tunnel bypass routes. */
export function sanitizeBypassRoutes(routes: unknown): string[] {
  if (!Array.isArray(routes)) return []
  return routes
    .map((r) => (typeof r === 'string' ? r.trim() : ''))
    .filter((r) => isAllowedBypassCidr(r))
    .slice(0, MAX_BYPASS_ROUTES)
}

// DNS resolvers the app is allowed to switch to. The daemon re-checks this (a
// socket client is untrusted) so a local attacker can't point DNS at their own
// resolver; 'system' means "no override" and is handled by the caller.
export const ALLOWED_DNS_RESOLVERS = new Set([
  '1.1.1.1', '1.0.0.1', '8.8.8.8', '9.9.9.9', '45.90.28.0',
])

export function isAllowedDnsResolver(ip: string): boolean {
  return ALLOWED_DNS_RESOLVERS.has(ip)
}

/**
 * True if `remoteUrl` is a safe node API / probe endpoint: http(s) only (after an
 * optional scheme-less `host:port` form), with no embedded credentials. Mirrors the
 * check in chain-service.resolveNodeRemoteUrl so the node-probe IPC path gets the
 * same guarantee as the handshake path (finding M3).
 */
export function isSafeNodeApiUrl(remoteUrl: unknown): boolean {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') return false
  const s = remoteUrl.trim()
  // If it declares a scheme it must be http(s); anything else (file:, ftp:, …) is
  // rejected rather than silently https-prefixed into a look-alike host. A
  // scheme-less `host:port` is treated as https.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)
  if (hasScheme && !/^https?:\/\//i.test(s)) return false
  let parsed: URL
  try { parsed = new URL(hasScheme ? s : `https://${s}`) } catch { return false }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.username || parsed.password) return false
  return true
}

/** Strict IPv4 literal (octets 0-255). */
export function isIPv4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return m !== null && [m[1], m[2], m[3], m[4]].every((o) => parseInt(o, 10) <= 255)
}

/** Linux interface name: alphanumeric/underscore/hyphen, 1-15 chars. */
export function isValidInterfaceName(s: string): boolean {
  return /^[a-zA-Z0-9_-]{1,15}$/.test(s)
}

/** `ipv4:port` SOCKS address. */
export function isValidSocksAddr(s: string): boolean {
  const m = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/)
  if (!m) return false
  const port = parseInt(m[2], 10)
  return isIPv4(m[1]) && port > 0 && port <= 65535
}

/**
 * Return a copy of a parsed V2Ray config with diagnostic logging enabled. The
 * SDK hardcodes `log.loglevel = "none"`, which makes a wedged outbound (v2ray
 * process alive but unable to reach the node) completely silent and
 * undiagnosable. We route errors to stderr (captured by the spawner) at warning
 * level — never to a file, so the output still satisfies assertSafeV2RayConfig.
 */
export function withV2RayDiagnosticLog(config: unknown): unknown {
  const cfg = (config && typeof config === 'object') ? { ...(config as Record<string, unknown>) } : {}
  cfg.log = { access: 'none', error: '', loglevel: 'warning' }
  return cfg
}

/**
 * Pin every V2Ray outbound endpoint that is a hostname to a concrete IPv4,
 * using the supplied resolver. Returns a new config (pure — input untouched).
 *
 * Why this is load-bearing: the node endpoint must be an IP literal so v2ray
 * never performs a runtime DNS lookup for it. Once the tun2socks tunnel is up,
 * ALL DNS is routed *through* the tunnel — so any re-resolution of the node
 * hostname deadlocks (DNS needs the node, the node needs DNS) and permanently
 * wedges the connection while the v2ray process stays alive (the observed bug).
 * Resolving once, before the tunnel exists, and pinning the result removes the
 * dependency. Unresolvable hostnames are left as-is (best effort — connect then
 * fails loudly downstream rather than silently here).
 */
export function pinV2RayNodeAddresses(
  config: unknown,
  resolve: (host: string) => string | null,
): unknown {
  if (config === null || typeof config !== 'object') return config
  const cfg = { ...(config as Record<string, unknown>) }
  if (!Array.isArray(cfg.outbounds)) return cfg

  cfg.outbounds = cfg.outbounds.map((ob) => {
    if (ob === null || typeof ob !== 'object') return ob
    const settings = (ob as Record<string, unknown>).settings
    if (settings === null || typeof settings !== 'object') return ob
    const vnext = (settings as Record<string, unknown>).vnext
    if (!Array.isArray(vnext)) return ob

    const newVnext = vnext.map((v) => {
      if (v === null || typeof v !== 'object') return v
      const addr = (v as Record<string, unknown>).address
      if (typeof addr !== 'string' || isIPv4(addr)) return v
      const ip = resolve(addr)
      return ip ? { ...(v as Record<string, unknown>), address: ip } : v
    })

    return { ...(ob as Record<string, unknown>), settings: { ...(settings as Record<string, unknown>), vnext: newVnext } }
  })

  return cfg
}

const V2RAY_LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Throw if a parsed V2Ray config is outside the shape this app expects from a
 * node: it must have outbounds, must not point its log at an arbitrary file
 * path, and must only listen on loopback. Conservative — it rejects the known
 * abuse vectors without over-constraining the SDK's generated structure.
 */
export function assertSafeV2RayConfig(config: unknown): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('V2Ray config is invalid: expected an object')
  }
  const cfg = config as Record<string, unknown>

  if (!Array.isArray(cfg.outbounds) || cfg.outbounds.length === 0) {
    throw new Error('V2Ray config is invalid: missing outbounds')
  }

  const log = cfg.log
  if (log && typeof log === 'object') {
    for (const field of ['access', 'error'] as const) {
      const v = (log as Record<string, unknown>)[field]
      if (typeof v === 'string' && v !== '' && v !== 'none') {
        throw new Error(`V2Ray config: log.${field} file path is not allowed`)
      }
    }
  }

  if (Array.isArray(cfg.inbounds)) {
    for (const inbound of cfg.inbounds) {
      const listen = inbound && typeof inbound === 'object' ? (inbound as Record<string, unknown>).listen : undefined
      if (typeof listen === 'string' && !V2RAY_LOOPBACK.has(listen)) {
        throw new Error(`V2Ray config: inbound listen "${listen}" must be loopback`)
      }
    }
  }
}

/**
 * True if `pin` is a SHA-256 cert fingerprint: 64 hex chars, optionally
 * colon-separated (the format hysteria2's pinSHA256 accepts). Kept inline so this
 * module stays self-contained and unit-testable in isolation; hysteria-config.ts has
 * its own copy for the build (the two pure modules never runtime-import each other).
 */
function isHexCertPin(pin: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(pin.replace(/:/g, ''))
}

/** Extract the host portion of a `host:port` (or `[ipv6]:port`) listen string. */
function hostOfListen(listen: string): string {
  if (listen.startsWith('[')) {
    const close = listen.indexOf(']')
    return close > 0 ? listen.slice(1, close) : listen
  }
  const colon = listen.lastIndexOf(':')
  return colon > 0 ? listen.slice(0, colon) : listen
}

/**
 * Throw if a synthesized Hysteria2 client config is outside the shape this app
 * builds (see hysteria-config.ts). Unlike WireGuard/V2Ray — where the node hands us
 * a whole config — we synthesize the hysteria2 config from a few node scalars, so
 * this is a tight trust-boundary re-check before spawn: the server must be host:port,
 * the SOCKS5 listener must stay on loopback (never an open proxy), the TLS cert must
 * be pinned (an unpinned hysteria2 tunnel is MITM-able — the analogue of VLess-none),
 * and no traffic-redirecting keys (acl / outbounds) may be present (we never emit them).
 */
export function assertSafeHysteria2Config(config: unknown): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Hysteria2 config is invalid: expected an object')
  }
  const cfg = config as Record<string, unknown>

  // Host is an IPv4 (after pinning) or hostname; port required. No IPv6 literals emitted.
  if (typeof cfg.server !== 'string' || !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(cfg.server)) {
    throw new Error('Hysteria2 config: server must be host:port')
  }

  const socks5 = cfg.socks5
  const listen = socks5 && typeof socks5 === 'object' ? (socks5 as Record<string, unknown>).listen : undefined
  if (typeof listen !== 'string') {
    throw new Error('Hysteria2 config: missing socks5.listen')
  }
  if (!V2RAY_LOOPBACK.has(hostOfListen(listen))) {
    throw new Error(`Hysteria2 config: socks5.listen "${listen}" must be loopback`)
  }

  const tls = cfg.tls
  const pin = tls && typeof tls === 'object' ? (tls as Record<string, unknown>).pinSHA256 : undefined
  if (typeof pin !== 'string' || !isHexCertPin(pin)) {
    throw new Error('Hysteria2 config: tls.pinSHA256 must be a valid cert pin (an unpinned tunnel is MITM-able)')
  }

  // hysteria2's `acl` can reference external files / reject-route, and `outbounds`
  // can chain traffic to an arbitrary proxy — we never emit either, so their
  // presence means tampering.
  for (const key of ['acl', 'outbounds'] as const) {
    if (key in cfg) throw new Error(`Hysteria2 config: "${key}" is not allowed`)
  }
}

// --- AmneziaWG config guard ---

// AmneziaWG keys accepted on top of the plain-WireGuard set. awg-quick is a
// wg-quick fork, so the same script-executing directives (PostUp/PreUp/…) exist
// and are rejected the same way: allow-list, not blocklist.
const AWG_INTERFACE_KEYS = new Set([
  ...WG_INTERFACE_KEYS,
  'jc', 'jmin', 'jmax',
  's1', 's2', 's3', 's4',
  'h1', 'h2', 'h3', 'h4',
  'i1', 'i2', 'i3', 'i4', 'i5',
])
const AWG_UINT16_KEYS = new Set(['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'])
const AWG_UINT32_KEYS = new Set(['h1', 'h2', 'h3', 'h4'])
const AWG_I_KEYS = new Set(['i1', 'i2', 'i3', 'i4', 'i5'])
// awg signature-packet tag grammar (amneziawg-config.ts has its own copy — the
// two pure modules never runtime-import each other).
const AWG_I_TAGS = /^(<b 0x[0-9a-fA-F]+>|<r \d{1,5}>|<rd \d{1,5}>|<rc \d{1,5}>|<t>)+$/
const AWG_I_MAX_LENGTH = 4096

function assertSafeAmneziaWgValue(key: string, value: string): void {
  const v = value.trim()
  if (AWG_UINT16_KEYS.has(key)) {
    if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) {
      throw new Error(`AmneziaWG config: "${key}" must be a uint16`)
    }
    return
  }
  if (AWG_UINT32_KEYS.has(key)) {
    // The plain-WG WG_UINT (\d{1,7}) is too narrow for uint32 header values.
    if (!/^\d{1,10}$/.test(v) || Number(v) > 4294967295) {
      throw new Error(`AmneziaWG config: "${key}" must be a uint32`)
    }
    return
  }
  if (AWG_I_KEYS.has(key)) {
    if (v.length > AWG_I_MAX_LENGTH || !AWG_I_TAGS.test(v)) {
      throw new Error(`AmneziaWG config: "${key}" signature packet is malformed`)
    }
    return
  }
  assertSafeWireguardValue(key, value)
}

/**
 * Throw if an AmneziaWG config string contains any directive outside the
 * allow-list, or an allow-listed key whose value is malformed. Same LPE guard as
 * assertSafeWireguardConfig (awg-quick executes PostUp/… as root identically);
 * kept separate so the plain-WireGuard allow-list never loosens.
 */
export function assertSafeAmneziaWgConfig(config: string): void {
  let section: 'interface' | 'peer' | null = null

  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue

    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      const name = sectionMatch[1].trim().toLowerCase()
      if (name !== 'interface' && name !== 'peer') {
        throw new Error(`AmneziaWG config: section [${sectionMatch[1]}] is not allowed`)
      }
      section = name
      continue
    }

    const eq = line.indexOf('=')
    if (eq === -1) {
      throw new Error(`AmneziaWG config: malformed line is not allowed: ${line}`)
    }
    const key = line.slice(0, eq).trim().toLowerCase()
    if (!section) {
      throw new Error(`AmneziaWG config: key "${key}" outside any section is not allowed`)
    }
    const allowed = section === 'interface' ? AWG_INTERFACE_KEYS : WG_PEER_KEYS
    if (!allowed.has(key)) {
      throw new Error(`AmneziaWG config: key "${key}" in [${section}] is not allowed`)
    }
    assertSafeAmneziaWgValue(key, line.slice(eq + 1).trim())
  }
}

// --- OpenVPN config guard ---

// OpenVPN's grammar is space-separated directives plus inline <tag>…</tag> PKI
// blocks, so the WireGuard INI scanner does not transfer. The LPE surface is
// larger than wg-quick's: `up`/`down`/`route-up`/`ipchange`/`client-connect`/
// `tls-verify`/`auth-user-pass-verify`/`learn-address`/`plugin` all execute code
// as root, and `script-security` would re-enable them. Every one of those is
// rejected by omission from this allow-list — the same discipline as WG's
// PostUp. Operational directives the app itself needs (--daemon, --writepid,
// --log, --script-security 0) are deliberately NOT allowed here: the privileged
// helper passes them on the command line after --config, so they can only ever
// come from us, never from a node.
const OVPN_IFACE_NAME = 'sntl-ovpn'

// directive -> validator for its argument ('' when the directive takes none).
// A Map (not an object) so a directive named `constructor` can't hit the prototype.
const OVPN_DIRECTIVES = new Map<string, RegExp>([
  ['client', /^$/],
  ['dev', new RegExp(`^${OVPN_IFACE_NAME}$`)],
  ['dev-type', /^tun$/],
  ['proto', /^(tcp|udp)$/],
  ['remote', /^\[?[A-Za-z0-9.:_-]+\]?[ \t]+\d{1,5}$/],
  ['nobind', /^$/],
  ['auth-nocache', /^$/],
  ['auth', /^[A-Za-z0-9-]{1,32}$/],
  ['data-ciphers', /^[A-Za-z0-9:-]{1,128}$/],
  ['data-ciphers-fallback', /^[A-Za-z0-9-]{1,64}$/],
  ['tls-cipher', /^[A-Za-z0-9:-]{1,128}$/],
  ['tls-client', /^$/],
  ['tls-version-min', /^1\.[23]$/],
  ['remote-cert-tls', /^server$/],
  ['redirect-gateway', /^[A-Za-z0-9 \t-]{0,64}$/], // def1 ipv6 bypass-dhcp
  ['topology', /^subnet$/],
  ['explicit-exit-notify', /^[1-3]$/],
  ['persist-key', /^$/],
  ['persist-tun', /^$/],
])

const OVPN_INLINE_TAGS = new Set(['ca', 'cert', 'key', 'tls-crypt'])
// PEM armor or its base64/hex body. The builder decodes and re-armors every node
// blob, so nothing else can legitimately appear inside a block.
const OVPN_PEM_LINE = /^(-----(BEGIN|END) [A-Za-z0-9 ]{1,48}-----|[A-Za-z0-9+/]+={0,2})$/
// Without these the tunnel would either not be a client tunnel or would drop the
// tls-crypt channel wrapper — a downgrade a socket client must not be able to ask
// root to run.
const OVPN_REQUIRED = ['client', 'dev', 'proto', 'remote']

/**
 * Throw if an OpenVPN config string contains any directive outside the allow-list,
 * an allow-listed directive with a malformed value, an unknown inline block, a
 * repeated directive, or a missing essential. Mirrored in bash by
 * validate_openvpn_config in the polkit helper (last line of defense if the
 * daemon is bypassed or the helper is invoked directly).
 */
export function assertSafeOpenVpnConfig(config: string): void {
  let openBlock: string | null = null
  const seenBlocks = new Set<string>()
  const seenDirectives = new Set<string>()

  for (const raw of config.split('\n')) {
    const line = raw.trim()

    if (openBlock) {
      if (line === `</${openBlock}>`) {
        openBlock = null
        continue
      }
      if (line === '') continue
      if (!OVPN_PEM_LINE.test(line)) {
        throw new Error('OpenVPN config: inline block contains a non-PEM line')
      }
      continue
    }

    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue

    const opening = line.match(/^<([A-Za-z0-9-]+)>$/)
    if (opening) {
      const tag = opening[1].toLowerCase()
      if (!OVPN_INLINE_TAGS.has(tag)) {
        throw new Error(`OpenVPN config: inline block <${tag}> is not allowed`)
      }
      if (seenBlocks.has(tag)) {
        throw new Error(`OpenVPN config: inline block <${tag}> is repeated`)
      }
      seenBlocks.add(tag)
      openBlock = tag
      continue
    }
    if (line.startsWith('<')) {
      throw new Error(`OpenVPN config: stray tag is not allowed: ${line}`)
    }

    const split = line.search(/[ \t]/)
    const directive = (split === -1 ? line : line.slice(0, split)).toLowerCase()
    const value = split === -1 ? '' : line.slice(split + 1).trim()

    const validator = OVPN_DIRECTIVES.get(directive)
    if (!validator) {
      throw new Error(`OpenVPN config: directive "${directive}" is not allowed`)
    }
    if (seenDirectives.has(directive)) {
      // e.g. a second `remote` (failover) that the kill switch wouldn't whitelist.
      throw new Error(`OpenVPN config: directive "${directive}" is repeated`)
    }
    seenDirectives.add(directive)
    if (!validator.test(value)) {
      throw new Error(`OpenVPN config: directive "${directive}" has a malformed value`)
    }
  }

  if (openBlock) {
    throw new Error(`OpenVPN config: inline block <${openBlock}> is unterminated`)
  }
  for (const tag of OVPN_INLINE_TAGS) {
    if (!seenBlocks.has(tag)) {
      throw new Error(`OpenVPN config: inline block <${tag}> is missing`)
    }
  }
  for (const directive of OVPN_REQUIRED) {
    if (!seenDirectives.has(directive)) {
      throw new Error(`OpenVPN config: directive "${directive}" is missing`)
    }
  }
}

/**
 * Extract the host from the OpenVPN `remote <host> <port>` line, or null if
 * absent. Used to whitelist the real server in the kill switch (analogue of
 * extractWireguardEndpointHost).
 */
export function extractOpenVpnRemoteHost(config: string): string | null {
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    const split = line.search(/[ \t]/)
    if (split === -1) continue
    if (line.slice(0, split).toLowerCase() !== 'remote') continue

    const host = line.slice(split + 1).trim().split(/[ \t]+/)[0]
    if (!host) return null
    if (host.startsWith('[')) {
      const close = host.indexOf(']')
      return close > 0 ? host.slice(1, close) : null
    }
    return host
  }
  return null
}

/**
 * DoH endpoints for each resolver the app allows, keyed by the plaintext resolver
 * IP the user picks (a subset of ALLOWED_DNS_RESOLVERS). Each entry pairs a
 * hostname URL (so v2ray validates the TLS certificate against a real name) with
 * the resolver's IPs pinned in `hosts` — the same "pin so v2ray never re-resolves
 * through the tunnel" trick as pinV2RayNodeAddresses, which avoids a DNS bootstrap
 * deadlock (resolving the DoH host would itself need DNS). Resolvers absent here
 * fall back to plaintext (the caller leaves the config untouched).
 */
export const DOH_ENDPOINTS: Record<string, { url: string; host: string; ips: string[] }> = {
  '1.1.1.1': { url: 'https://cloudflare-dns.com/dns-query', host: 'cloudflare-dns.com', ips: ['1.1.1.1', '1.0.0.1'] },
  '1.0.0.1': { url: 'https://cloudflare-dns.com/dns-query', host: 'cloudflare-dns.com', ips: ['1.1.1.1', '1.0.0.1'] },
  '8.8.8.8': { url: 'https://dns.google/dns-query', host: 'dns.google', ips: ['8.8.8.8', '8.8.4.4'] },
  '9.9.9.9': { url: 'https://dns.quad9.net/dns-query', host: 'dns.quad9.net', ips: ['9.9.9.9', '149.112.112.112'] },
  '45.90.28.0': { url: 'https://dns.nextdns.io/dns-query', host: 'dns.nextdns.io', ips: ['45.90.28.0', '45.90.30.0'] },
}

/**
 * Inject DNS-over-HTTPS into a parsed V2Ray config so the exit node sees only an
 * opaque HTTPS connection to the resolver, never the plaintext domain. Returns a
 * new config (pure — input untouched). If `resolverIp` isn't a known DoH endpoint
 * (e.g. 'system'), the config is returned unchanged → plaintext fallback.
 *
 * The mechanism lives entirely inside the v2ray process: a built-in `dns` outbound
 * answers the OS's UDP-53 queries (forwarded in by tun2socks) using the DoH server
 * in the `dns` block; that DoH request, tagged `dns-module`, is itself routed
 * through the node's balancer so it's tunnelled. Two rules are *prepended* — the
 * port-53 intercept MUST precede the SDK's `inboundTag:["proxy"]` catch-all or DNS
 * would be proxied raw (plaintext) instead of re-resolved over DoH.
 *
 * The intercept is keyed on the config's OWN inbound tags, not the literal "proxy":
 * only the SDK's v2ray config uses that name, so assuming it left xray (inbound tag
 * "socks") with a rule that matched nothing and no DoH at all.
 */
export function withV2RayDoH(config: unknown, resolverIp: string): unknown {
  if (config === null || typeof config !== 'object') return config
  const endpoint = DOH_ENDPOINTS[resolverIp]
  if (!endpoint) return config

  const cfg = { ...(config as Record<string, unknown>) }

  const routing = (cfg.routing && typeof cfg.routing === 'object' && !Array.isArray(cfg.routing))
    ? { ...(cfg.routing as Record<string, unknown>) }
    : {}
  const rules = Array.isArray(routing.rules) ? routing.rules : []

  // Where the DNS module's own DoH egress should go: the same balancer the proxy
  // inbound uses (so DoH is tunnelled through the node), falling back to the first
  // balancer, then the first outbound. If none can be found we add no egress rule
  // and let it fall through to the default (first) outbound, which is the node.
  const tagOf = (o: unknown): string | null =>
    o !== null && typeof o === 'object' && typeof (o as Record<string, unknown>).tag === 'string'
      ? ((o as Record<string, unknown>).tag as string)
      : null
  // The inbound(s) carrying user traffic, read off the config rather than assumed.
  // The SDK's v2ray config tags its socks inbound "proxy", but buildXRayConfig and
  // buildMultihopConfig tag theirs "socks" — hardcoding "proxy" made the port-53
  // intercept below match nothing for those, silently leaving DoH inert.
  // Only `socks` inbounds qualify: the SDK also ships a dokodemo-door "api" inbound
  // with its own routing rule, and the intercept is prepended, so including it would
  // hijack v2ray's own API port.
  const inboundTags = (Array.isArray(cfg.inbounds) ? cfg.inbounds : [])
    .filter((i) =>
      i !== null && typeof i === 'object' &&
      (i as Record<string, unknown>).protocol === 'socks',
    )
    .map(tagOf)
    .filter((t): t is string => t !== null)
  const interceptTags = inboundTags.length > 0 ? inboundTags : ['proxy']

  let egress: Record<string, unknown> | null = null
  const proxyRule = rules.find((r) =>
    r !== null && typeof r === 'object' &&
    Array.isArray((r as Record<string, unknown>).inboundTag) &&
    ((r as Record<string, unknown>).inboundTag as unknown[]).some((t) => interceptTags.includes(t as string)) &&
    typeof (r as Record<string, unknown>).balancerTag === 'string',
  ) as Record<string, unknown> | undefined
  if (proxyRule) {
    egress = { balancerTag: proxyRule.balancerTag }
  } else if (Array.isArray(routing.balancers) && tagOf(routing.balancers[0])) {
    egress = { balancerTag: tagOf(routing.balancers[0]) }
  } else if (Array.isArray(cfg.outbounds) && tagOf(cfg.outbounds[0])) {
    egress = { outboundTag: tagOf(cfg.outbounds[0]) }
  }

  // Resolve via DoH; pin the resolver host to its IPs (no bootstrap lookup).
  // UseIPv4 because the tun2socks TUN is v4-only — AAAA answers would be
  // unroutable / leak-prone.
  cfg.dns = {
    hosts: { [endpoint.host]: endpoint.ips },
    servers: [endpoint.url],
    queryStrategy: 'UseIPv4',
    tag: 'dns-module',
  }

  const outbounds = Array.isArray(cfg.outbounds) ? [...cfg.outbounds] : []
  cfg.outbounds = [...outbounds, { protocol: 'dns', tag: 'dns-out' }]

  const newRules: unknown[] = [
    { type: 'field', inboundTag: interceptTags, port: 53, outboundTag: 'dns-out' },
  ]
  if (egress) newRules.push({ type: 'field', inboundTag: ['dns-module'], ...egress })
  routing.rules = [...newRules, ...rules]
  cfg.routing = routing

  return cfg
}

// --- V2Ray inbound encryption policy ---
//
// A node's handshake offers one or more inbounds, each with a proxy protocol
// (VMess/VLess) and transport security (TLS/none). The genuinely-unsafe combo is
// VLess + none: VLess has no proxy-layer cipher of its own, so without TLS the
// hop to the node is cleartext at the proxy layer. VMess (AEAD) and any TLS
// inbound are fine. We prefer encrypted inbounds and reject nodes that offer
// only cleartext ones.
//
// Enum values mirror the vendored JS SDK (ProxyProtocol / TransportSecurity); kept
// as named constants so this module needs no runtime SDK import. Must match the
// SDK enums.
const PROXY_VLESS = 1 // ProxyProtocol.VLess
const PROXY_VMESS = 2 // ProxyProtocol.VMess
const SECURITY_NONE = 1 // TransportSecurity.None
const SECURITY_TLS = 2 // TransportSecurity.TLS

export type V2RayInboundClass = 'acceptable' | 'cleartext'

/**
 * Classify one V2Ray inbound by whether the hop to the node is protected:
 * - VMess (carries its own AEAD cipher) or any TLS transport → 'acceptable'.
 * - VLess with no transport security → 'cleartext'.
 * Unknown/odd combos default to 'acceptable' — we only drop the known-bad
 * VLess-none, we don't whitelist.
 */
export function classifyV2RayInbound(meta: V2RayMetadata): V2RayInboundClass {
  if (meta.proxy_protocol === PROXY_VMESS) return 'acceptable'
  if (meta.transport_security === SECURITY_TLS) return 'acceptable'
  if (meta.proxy_protocol === PROXY_VLESS && meta.transport_security === SECURITY_NONE) {
    return 'cleartext'
  }
  return 'acceptable'
}

/**
 * Keep only acceptable inbounds when at least one exists; otherwise return [] so
 * the caller can reject the node. "Prefer encrypted": a node that offers any
 * acceptable inbound is never connected over a VLess-none one. Pure — input
 * array is not mutated.
 */
export function filterV2RayMetadata(metadata: V2RayMetadata[]): V2RayMetadata[] {
  const acceptable = metadata.filter((m) => classifyV2RayInbound(m) === 'acceptable')
  return acceptable.length > 0 ? acceptable : []
}

/** True when the node offers inbounds but every one is cleartext (VLess-none). */
export function isAllCleartext(metadata: V2RayMetadata[]): boolean {
  return metadata.length > 0 && metadata.every((m) => classifyV2RayInbound(m) === 'cleartext')
}

/**
 * Compact human badge for a set of V2Ray inbounds, e.g. "VMess", "VMess+TLS",
 * "VLess+TLS", or "VLess ⚠" when the set is cleartext-only. Drives the active
 * connection bar and the remembered node-list badge.
 */
export function v2raySecurityBadge(metadata: V2RayMetadata[]): string {
  if (metadata.length === 0) return 'unknown'
  if (isAllCleartext(metadata)) return 'VLess ⚠'
  const hasVMess = metadata.some((m) => m.proxy_protocol === PROXY_VMESS)
  const hasTLS = metadata.some((m) => m.transport_security === SECURITY_TLS)
  const proto = hasVMess ? 'VMess' : 'VLess'
  return hasTLS ? `${proto}+TLS` : proto
}
