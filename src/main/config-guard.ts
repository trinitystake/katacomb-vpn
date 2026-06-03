/**
 * Pure validators that sit between untrusted VPN-node data and the privileged
 * helper / child processes. Node operators are part of the threat model: a
 * node's WireGuard config can carry `PostUp`/`PreUp`/… directives that
 * `wg-quick` runs as root, and its V2Ray config / split-tunnel routes feed
 * `ip route` (also root). These functions reject anything outside a strict
 * allow-list before it reaches those sinks.
 *
 * No Electron/Node-fs imports here — kept pure so it is unit-testable in
 * isolation (see config-guard.test.ts).
 */

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
