// Root daemon core logic. Plain Node only (NO electron import) so it bundles
// into a standalone process run via `ELECTRON_RUN_AS_NODE=1 <electron> daemon.js`.
// The auto-start lives in daemon.ts; this module is import-safe for unit tests.
//
// SECURITY: the socket is reachable by any local user (Mullvad model), so this
// is the sole trust boundary. EVERY request is validated here with config-guard
// before any privileged helper verb runs. Configs are written by the daemon to
// a root-owned file (the client never supplies a path), the tun2socks binary is
// resolved + SHA-pinned here (client paths ignored), and DNS is allow-listed.

import { createServer, type Socket } from 'net'
import { writeFileSync, existsSync, unlinkSync, mkdirSync, chmodSync, chownSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import {
  assertSafeWireguardConfig,
  isAllowedBypassCidr,
  isAllowedDnsResolver,
  isIPv4,
  isValidInterfaceName,
  isValidSocksAddr,
} from './config-guard'
import { verifyBinaryIntegrity } from './binary-integrity'
import {
  DAEMON_DIR,
  DAEMON_SOCKET_PATH,
  DAEMON_PROTOCOL_VERSION,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon-protocol'

const HELPER_PATH = '/usr/local/bin/sentinel-vpn-helper'
const WG_CONFIG_PATH = join(DAEMON_DIR, 'sntl0.conf')
const MAX_MESSAGE_BYTES = 256 * 1024
// Only members of this group may drive the privileged daemon socket (finding C1).
// The .deb postinstall creates it and adds the installing user.
const SOCKET_GROUP = 'sentinel-dvpn'

function log(msg: string): void {
  process.stderr.write(`[sentinel-daemon] ${msg}\n`)
}

/** gid of `group` via getent, or null when the group doesn't exist (dev/unpackaged). */
function lookupGid(group: string): number | null {
  try {
    const line = execFileSync('getent', ['group', group], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
    const gid = parseInt(line.split(':')[2], 10) // name:x:gid:members
    return Number.isInteger(gid) ? gid : null
  } catch {
    return null
  }
}

/**
 * Lock the socket to the `sentinel-dvpn` group (root:sentinel-dvpn, 0660) so only
 * group members — not every local user — can send privileged VPN ops (finding C1).
 * When the group is absent (dev / unpackaged run) fall back to the old world-
 * accessible 0666 rather than lock the GUI out entirely; that path has no daemon
 * anyway (it uses the pkexec helper).
 */
function secureSocketPermissions(): void {
  const gid = lookupGid(SOCKET_GROUP)
  if (gid !== null) {
    try {
      chownSync(DAEMON_SOCKET_PATH, 0, gid)
      chmodSync(DAEMON_SOCKET_PATH, 0o660)
      return
    } catch (err) {
      log(`could not group-restrict socket, falling back to 0666: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try { chmodSync(DAEMON_SOCKET_PATH, 0o666) } catch { /* ignore */ }
}

/** Side-effecting operations, injectable so the dispatcher is unit-testable. */
export interface DaemonDeps {
  /** Invoke a helper verb (daemon is already root — no pkexec). Returns stdout. */
  runHelper: (args: string[]) => string
  /** Write the (already-validated) WireGuard config to a root-owned 0600 file; return its path. */
  writeWgConfig: (content: string) => string
  /** Resolve + SHA-pin the bundled tun2socks; throws on tamper/missing. */
  resolveTun2Socks: () => string
  /** Read kernel interface state (world-readable). */
  checkStatus: () => { wgUp: boolean; tunUp: boolean }
}

function ifaceUp(name: string): boolean {
  try {
    execFileSync('ip', ['link', 'show', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export const defaultDeps: DaemonDeps = {
  runHelper: (args) =>
    execFileSync(HELPER_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).toString(),
  writeWgConfig: (content) => {
    if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o755 })
    writeFileSync(WG_CONFIG_PATH, content, { mode: 0o600 })
    return WG_CONFIG_PATH
  },
  resolveTun2Socks: () => {
    const bundled = join(__dirname, '../linux/v2ray/tun2socks')
    if (!existsSync(bundled)) throw new Error('bundled tun2socks not found')
    if (!verifyBinaryIntegrity(bundled, 'tun2socks')) {
      throw new Error('tun2socks failed SHA-256 integrity check')
    }
    return bundled
  },
  checkStatus: () => ({ wgUp: ifaceUp('sntl0'), tunUp: ifaceUp('sntl-tun') }),
}

/**
 * Validate + dispatch one request. ALL validation happens here (not in deps),
 * so it holds regardless of how the daemon is wired. Never throws — failures
 * become `{ ok: false }` responses.
 */
export function handleRequest(req: DaemonRequest, deps: DaemonDeps): DaemonResponse {
  const reply = (result?: unknown): DaemonResponse => ({ id: req.id, ok: true, result })
  const fail = (error: string): DaemonResponse => ({ id: req.id, ok: false, error })
  const args = (req && req.args) || {}

  try {
    switch (req.op) {
      case 'protocol_version':
        return reply({ version: DAEMON_PROTOCOL_VERSION })

      case 'status':
        return reply(deps.checkStatus())

      case 'wireguard_up': {
        const configString = (args as Record<string, unknown>).configString
        if (typeof configString !== 'string') return fail('wireguard_up: configString required')
        assertSafeWireguardConfig(configString) // throws on PostUp/PreUp/unknown keys
        const path = deps.writeWgConfig(configString)
        deps.runHelper(['up', path])
        return reply()
      }

      case 'wireguard_down':
        deps.runHelper(['down'])
        // Remove the root-owned WG config (holds the private key). It lives on tmpfs
        // but otherwise persists until the next connect overwrites it (finding L5).
        try { if (existsSync(WG_CONFIG_PATH)) unlinkSync(WG_CONFIG_PATH) } catch { /* best-effort */ }
        return reply()

      case 'tun_up': {
        const a = args as Record<string, unknown>
        if (typeof a.socksAddr !== 'string' || !isValidSocksAddr(a.socksAddr)) return fail('tun_up: invalid socksAddr')
        if (typeof a.remoteHost !== 'string' || !isIPv4(a.remoteHost)) return fail('tun_up: invalid remoteHost')
        if (typeof a.gateway !== 'string' || !isIPv4(a.gateway)) return fail('tun_up: invalid gateway')
        if (typeof a.iface !== 'string' || !isValidInterfaceName(a.iface)) return fail('tun_up: invalid iface')
        const bypass = (Array.isArray(a.bypassRoutes) ? a.bypassRoutes : [])
          .filter((r): r is string => typeof r === 'string' && isAllowedBypassCidr(r))
        const tun2socksBin = deps.resolveTun2Socks() // pinned; any client-supplied path is ignored
        const helperArgs = ['tun-up', tun2socksBin, a.socksAddr, a.remoteHost, a.gateway, a.iface]
        if (bypass.length) helperArgs.push(bypass.join(','))
        deps.runHelper(helperArgs)
        return reply()
      }

      case 'tun_down':
        deps.runHelper(['tun-down'])
        return reply()

      case 'killswitch_on': {
        const a = args as Record<string, unknown>
        if (typeof a.iface !== 'string' || !isValidInterfaceName(a.iface)) return fail('killswitch_on: invalid iface')
        if (typeof a.remoteHost !== 'string' || !isIPv4(a.remoteHost)) return fail('killswitch_on: invalid remoteHost')
        const helperArgs = ['killswitch-on', a.iface, a.remoteHost]
        if (a.dnsIp !== undefined && a.dnsIp !== null) {
          if (typeof a.dnsIp !== 'string' || !isIPv4(a.dnsIp)) return fail('killswitch_on: invalid dnsIp')
          helperArgs.push(a.dnsIp)
        }
        deps.runHelper(helperArgs)
        return reply()
      }

      case 'killswitch_off':
        deps.runHelper(['killswitch-off'])
        return reply()

      case 'dns_set': {
        const dnsIp = (args as Record<string, unknown>).dnsIp
        if (typeof dnsIp !== 'string' || !isAllowedDnsResolver(dnsIp)) return fail('dns_set: DNS resolver not allowed')
        deps.runHelper(['dns-set', dnsIp])
        return reply()
      }

      case 'dns_restore':
        deps.runHelper(['dns-restore'])
        return reply()

      default:
        return fail(`unknown op: ${req.op}`)
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

function handleConnection(socket: Socket, deps: DaemonDeps): void {
  let buf = ''
  socket.setEncoding('utf-8')
  socket.on('data', (chunk: string) => {
    buf += chunk
    if (buf.length > MAX_MESSAGE_BYTES) {
      socket.destroy()
      return
    }
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let req: DaemonRequest
      try {
        req = JSON.parse(line) as DaemonRequest
      } catch {
        socket.write(JSON.stringify({ id: 0, ok: false, error: 'invalid JSON' }) + '\n')
        continue
      }
      const res = handleRequest(req, deps)
      if (!res.ok) log(`op ${req?.op} rejected: ${res.error}`)
      socket.write(JSON.stringify(res) + '\n')
    }
  })
  socket.on('error', () => { /* client went away */ })
}

/** Bind the Unix socket and serve. Socket is group-restricted to `sentinel-dvpn` (0660) when that group exists (finding C1), else 0666. */
export function startDaemon(deps: DaemonDeps = defaultDeps): void {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o755 })
  if (existsSync(DAEMON_SOCKET_PATH)) {
    try { unlinkSync(DAEMON_SOCKET_PATH) } catch { /* ignore */ }
  }
  const server = createServer((socket) => handleConnection(socket, deps))
  server.on('error', (err) => log(`server error: ${err.message}`))
  server.listen(DAEMON_SOCKET_PATH, () => {
    secureSocketPermissions()
    log(`listening on ${DAEMON_SOCKET_PATH} (protocol v${DAEMON_PROTOCOL_VERSION})`)
  })
}
