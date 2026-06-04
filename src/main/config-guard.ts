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

/**
 * Throw if a WireGuard config string contains any directive outside the
 * allow-list. This is the guard for the wg-quick `PostUp` root-exec LPE.
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

const MAX_BYPASS_ROUTES = 64

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
  let egress: Record<string, unknown> | null = null
  const proxyRule = rules.find((r) =>
    r !== null && typeof r === 'object' &&
    Array.isArray((r as Record<string, unknown>).inboundTag) &&
    ((r as Record<string, unknown>).inboundTag as unknown[]).includes('proxy') &&
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
    { type: 'field', inboundTag: ['proxy'], port: 53, outboundTag: 'dns-out' },
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
// Enum values mirror the Sentinel SDK (ProxyProtocol / TransportSecurity); kept
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
