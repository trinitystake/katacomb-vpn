import { execSync, execFileSync, spawn, type ChildProcess } from 'child_process'
import { connect as netConnect } from 'node:net'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdtempSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { Wireguard, V2Ray } from '@sentinel-official/sentinel-js-sdk'
import {
  assertSafeWireguardConfig,
  assertSafeAmneziaWgConfig,
  assertSafeV2RayConfig,
  assertSafeHysteria2Config,
  withV2RayDiagnosticLog,
  withV2RayDoH,
  pinV2RayNodeAddresses,
  pinWireguardEndpoint,
  sanitizeBypassRoutes,
  extractWireguardEndpointHost,
  assertSafeOpenVpnConfig,
  extractOpenVpnRemoteHost,
} from './config-guard'
import { verifyBinaryIntegrity } from './binary-integrity'
import { isChildProxyCarryingTraffic } from './connect-decisions'
import { runPrivileged } from './privileged'
import { loadSettings } from './settings'
import { parseDefaultRoute, v2rayRunArgs, firstIPv4FromGetent } from './vpn-parse'
import { isDnsProvisionError } from './connect-decisions'
import { DNS_PROVISION_FAILED } from '../shared/error-markers'
import { SOCKS_PORT } from '../shared/socks'

const WG_IFACE = 'sntl0'

// Create a private temp directory for config files (mode 0o700, not predictable)
const SECURE_TMPDIR = mkdtempSync(join(tmpdir(), 'katacomb-vpn-'))
const V2RAY_CONFIG = join(SECURE_TMPDIR, 'v2ray.json')

/**
 * Resolve path to a bundled binary, falling back to system PATH if absent.
 * A bundled binary that *exists* but fails the SHA-256 check is treated as
 * tampering and throws — falling back to $PATH on hash mismatch would
 * silently weaken the supply-chain guarantee.
 */
function resolveBundled(name: string): string {
  const bundled = is.dev
    ? join(__dirname, '../../resources/linux/v2ray', name)
    : join(process.resourcesPath, 'linux/v2ray', name)

  if (existsSync(bundled)) {
    if (!verifyBinaryIntegrity(bundled, name)) {
      throw new Error(
        `Bundled binary ${name} failed SHA-256 integrity check. ` +
        `Refusing to run. Reinstall the app to restore the verified binary.`
      )
    }
    return bundled
  }
  // No bundled binary present — fall back to system PATH. That binary is NOT
  // integrity-checked (unknown provenance); this is a supported path for system
  // v2ray installs (see BinarySetup), but warn so an operator notices if the
  // bundled binary was unexpectedly removed to force this fallback (finding M1).
  // The root daemon path (daemon-core.resolveTun2Socks) fails closed instead.
  console.warn(`[binary] bundled ${name} not found — using unverified system PATH binary`)
  return name
}

function resolveV2RayBinary(): string {
  return resolveBundled('v2ray')
}

function resolveXRayBinary(): string {
  return resolveBundled('xray')
}

function resolveHysteria2Binary(): string {
  return resolveBundled('hysteria')
}

function resolveTun2Socks(): string {
  return resolveBundled('tun2socks')
}

/**
 * Resolve the bundled AmneziaWG trio's directory. Unlike the child-proxy
 * binaries there is NO system-PATH fallback: awg-quick/awg/amneziawg-go run as
 * root via the helper, so an unverified substitute is never acceptable — missing
 * or tampered fails closed (the daemon's resolveAmneziaWgBinDir does the same).
 */
function resolveAmneziaWgBinDir(): string {
  for (const name of ['amneziawg-go', 'awg', 'awg-quick']) {
    if (resolveBundled(name) === name) {
      throw new Error('AmneziaWG binaries are missing from this build. Reinstall the app.')
    }
  }
  return dirname(resolveBundled('amneziawg-go'))
}

const TUN_IFACE = 'sntl-tun'
// OpenVPN gets its own interface rather than reusing sntl0: a userspace AmneziaWG
// sntl0 is already `type tun`, so a third tun on that name would make adoption and
// teardown ambiguous (awg-down and ovpn-down are not interchangeable).
const OVPN_IFACE = 'sntl-ovpn'
const OVPN_CONFIG_NAME = 'openvpn.conf'
const SOCKS_ADDR = `127.0.0.1:${SOCKS_PORT}`

let activeChild: ChildProcess | null = null
let activeProtocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn' | null = null
/**
 * 'tunnel' = the usual full-device VPN (tun2socks/wg routes everything).
 * 'proxy'  = child-proxy protocols only: the core's local SOCKS5 listener is the
 * whole product — no TUN, no root, no routing changes. Only apps pointed at the
 * SOCKS address are tunneled; everything else keeps using the normal route.
 */
let activeMode: 'tunnel' | 'proxy' = 'tunnel'

// v2ray, xray and hysteria2 are all child-process + tun2socks tunnels with identical
// lifecycle handling (spawn a local SOCKS proxy, route it through tun2socks) — this
// narrows them together at the branch sites.
function isChildProxy(p: typeof activeProtocol): boolean {
  return p === 'v2ray' || p === 'xray' || p === 'hysteria2'
}
let activeConfigFile: string | null = null
// The core's log file for the CURRENT spawn, so disconnect can remove it (it outlives
// the session otherwise, and its contents are the user's browsing failures).
let activeLogPath: string | null = null
let v2rayStderr = ''
let tunActive = false
// The default route the tun2socks bypass route was pinned to at bring-up.
let tunRoute: { gateway: string; iface: string } | null = null
let v2rayExitCallback: (() => void) | null = null

export function binaryExists(name: string): boolean {
  // Only allow simple binary names (no paths, no shell metacharacters)
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return false
  try {
    execFileSync('which', [name], { stdio: 'ignore' }) // execFile, no shell (finding L4)
    return true
  } catch {
    return false
  }
}

/** Check if a binary is available — either bundled or on system PATH */
export function isBinaryAvailable(name: string): boolean {
  const resolved = resolveBundled(name)
  // If resolveBundled returned an absolute path (not just the name), it found & verified the bundled binary
  if (resolved !== name) return true
  // Otherwise check system PATH
  return binaryExists(name)
}

/**
 * Can this install actually bring `protocol` up? Resolves the binaries the
 * bring-up needs (which also runs their SHA-256 integrity check) without
 * spawning anything. Returns null when the runtime is fine, otherwise the
 * reason — the connect preflight uses it to fail BEFORE any funds move.
 */
export function protocolRuntimeError(protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'): string | null {
  try {
    if (protocol === 'wireguard') {
      return binaryExists('wg-quick') ? null : 'wg-quick is not installed. Install the wireguard-tools package.'
    }
    if (protocol === 'amneziawg') {
      resolveAmneziaWgBinDir()
      return null
    }
    if (protocol === 'openvpn') {
      resolveOpenVpnBinary()
      return null
    }
    const bin = protocol === 'v2ray' ? 'v2ray' : protocol === 'xray' ? 'xray' : 'hysteria'
    if (!isBinaryAvailable(bin)) return `The ${bin} binary is missing from this build. Reinstall the app.`
    if (!isBinaryAvailable('tun2socks')) return 'The tun2socks binary is missing from this build. Reinstall the app.'
    return null
  } catch (err) {
    // resolveBundled throws on a failed integrity check, resolveAmneziaWgBinDir
    // when the trio is missing — both are already user-facing messages.
    return err instanceof Error ? err.message : 'Required VPN binaries are unavailable.'
  }
}

/** Check if our WireGuard interface (sntl0) is currently up */
export function isWireGuardUp(): boolean {
  try {
    execSync(`ip link show ${WG_IFACE}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Check if ANY WireGuard interface is up (including third-party VPNs) */
function isAnyWireGuardUp(): boolean {
  try {
    const output = execSync('ip -o link show type wireguard', { stdio: 'pipe' }).toString().trim()
    return output.length > 0
  } catch {
    return false
  }
}

/**
 * Discriminate what a live sntl0 actually is: kernel WireGuard shows up under
 * `type wireguard`, while a userspace AmneziaWG sntl0 is a plain `type tun`
 * device (amneziawg-go). Everything that assumed "sntl0 ⇒ kernel WG" (teardown,
 * adoption, status) branches on this.
 */
function sntl0IsKernelWireGuard(): boolean {
  try {
    const output = execSync('ip -o link show type wireguard', { stdio: 'pipe' }).toString().trim()
    return output.split('\n').some((line) => line.match(/^\d+:\s+(\S+):/)?.[1] === WG_IFACE)
  } catch {
    return false
  }
}

/** Bring down ALL WireGuard interfaces — single password prompt via helper */
async function bringDownAllWireGuard(): Promise<void> {
  if (!isAnyWireGuardUp()) return

  try {
    await runPrivileged(['down'])
  } catch {
    // Best-effort
  }

  // Clean up our temp config file
  const ourConfig = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  if (existsSync(ourConfig)) {
    try { unlinkSync(ourConfig) } catch { /* ignore */ }
  }
}

/** Bring down our AmneziaWG tunnel (userspace sntl0) and clean its config */
async function bringDownAmneziaWg(): Promise<void> {
  try {
    await runPrivileged(['awg-down'])
  } catch {
    // Best-effort
  }

  const ourConfig = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  if (existsSync(ourConfig)) {
    try { unlinkSync(ourConfig) } catch { /* ignore */ }
  }
}

/**
 * Tear down whatever currently owns sntl0 — kernel WireGuard via the `down`
 * verb, userspace AmneziaWG via `awg-down`. The shared pre-connect/teardown
 * step, so a stale tunnel of either protocol never blocks the other's bring-up.
 */
async function ensureSntl0Down(): Promise<void> {
  if (!isWireGuardUp()) return
  if (sntl0IsKernelWireGuard()) {
    await bringDownAllWireGuard()
  } else {
    await bringDownAmneziaWg()
  }
}

/**
 * Tear down a stale OpenVPN tunnel. Separate from ensureSntl0Down because the two
 * live on different interfaces — one tunnel at a time is enforced by the connect
 * lock in ipc-handlers, this just clears a leftover from a crash or a protocol switch.
 */
async function ensureOpenVpnDown(): Promise<void> {
  if (!isOpenVpnUp()) return
  await bringDownOpenVpn()
}

/** Bring up WireGuard from a config file path (must be named sntl0.conf) */
async function bringUpWireGuard(configFile: string): Promise<void> {
  try {
    await runPrivileged(['up', configFile])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('dismissed') || msg.includes('cancelled') || msg.includes('Not authorized')) {
      throw new Error('Admin authentication was cancelled. WireGuard requires root privileges.')
    }
    // Marker prefix so the renderer can offer the DNS-less retry (see
    // isDnsProvisionError). The tunnel itself is fine — only wg-quick's
    // resolvconf step failed.
    if (isDnsProvisionError(msg)) {
      throw new Error(`${DNS_PROVISION_FAILED}: Failed to bring up WireGuard interface: ${msg}`)
    }
    throw new Error(`Failed to bring up WireGuard interface: ${msg}`)
  }
}

/** Check if our TUN interface for tun2socks is up */
function isTunUp(): boolean {
  try {
    execSync(`ip link show ${TUN_IFACE}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a hostname to a single IPv4 via getent. Returns IPs unchanged, null
 * if it can't resolve or the input has shell metacharacters. Used both to pin
 * the v2ray config endpoint (before spawn) and to derive the bypass route — so
 * both see the *same* IP and can never disagree.
 */
function resolveHostToIPv4(host: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host
  // Validate hostname first, then use execFile (no shell) so injection-safety is
  // structural rather than relying only on the regex (finding L4).
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) return null
  try {
    const out = execFileSync('getent', ['ahostsv4', host], { stdio: 'pipe', timeout: 5000 }).toString()
    return firstIPv4FromGetent(out)
  } catch { /* ignore */ }
  return null
}

/**
 * Extract the remote proxy server IP from the active config file, resolving
 * hostnames to IPs. Handles both the v2ray/xray shape (`outbounds[].settings.vnext`)
 * and the hysteria2 shape (a single `server: "host:port"`). Used by bringUpTun for
 * the tun2socks bypass route AND by the kill-switch whitelist, so both see the same IP.
 *
 * It must return the endpoint this host dials DIRECTLY — the only one whose packets
 * reach the physical NIC, and therefore the only one the bypass route and the
 * `-d host -j ACCEPT` rule may name. An outbound carrying `proxySettings` is reached
 * *through* another outbound (a multihop exit hop), so its address never leaves the
 * tunnel and whitelisting it would strand the real connection behind the DROP-all
 * chain — bytes out, ~zero bytes in, UI still "connected". Direct-dial outbounds are
 * therefore preferred; the fallback keeps single-hop behaviour identical, since those
 * configs have no proxySettings at all.
 */
function extractV2RayRemoteHost(): string | null {
  try {
    const configPath = activeConfigFile || V2RAY_CONFIG
    if (!existsSync(configPath)) return null
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    // Hysteria2: a single `server: "host:port"` (no outbounds/vnext).
    if (typeof config.server === 'string') {
      const host = config.server.startsWith('[')
        ? config.server.slice(1, config.server.indexOf(']'))
        : config.server.slice(0, config.server.lastIndexOf(':'))
      if (host && host !== '127.0.0.1') return resolveHostToIPv4(host)
    }
    const outbounds = (config.outbounds || []) as Record<string, unknown>[]
    const addressOf = (ob: unknown): string | null => {
      const addr = (ob as { settings?: { vnext?: { address?: string }[] } })?.settings?.vnext?.[0]?.address
      return addr && addr !== '127.0.0.1' ? addr : null
    }
    // Direct-dial first (no proxySettings), then any outbound at all.
    const direct = outbounds.filter((ob) => !ob?.proxySettings)
    for (const ob of [...direct, ...outbounds]) {
      const addr = addressOf(ob)
      if (addr) {
        // After pinV2RayNodeAddresses this is already an IP; resolve handles the
        // hostname fall-through case (pinning failed) too.
        return resolveHostToIPv4(addr)
      }
    }
  } catch { /* ignore */ }
  return null
}

/** Get the current default gateway and interface */
function getDefaultRoute(): { gateway: string; iface: string } | null {
  try {
    const output = execSync('ip route show default', { stdio: 'pipe' }).toString().trim()
    return parseDefaultRoute(output)
  } catch { /* ignore */ }
  return null
}

/**
 * Bring up tun2socks TUN interface — routes all traffic through the SOCKS proxy.
 *
 * Uses the polkit helper to spawn tun2socks + set up routing in a single privileged call.
 * The helper daemonizes tun2socks (nohup + detached stdio) so execSync returns immediately.
 * Polkit caches the auth so subsequent connects don't prompt for a password.
 */
async function bringUpTun(): Promise<void> {
  const tun2socksBin = resolveTun2Socks()
  if (tun2socksBin === 'tun2socks' && !binaryExists('tun2socks')) {
    throw new Error('tun2socks binary not found. The bundled binary is missing.')
  }

  const defaultRoute = getDefaultRoute()
  if (!defaultRoute) {
    throw new Error('Cannot determine default gateway. Is your network connected?')
  }

  const remoteHost = extractV2RayRemoteHost()
  if (!remoteHost) {
    throw new Error('Cannot determine V2Ray remote server address from config. Config file: ' + (activeConfigFile || V2RAY_CONFIG))
  }
  console.log(`[tun2socks] Remote host: ${remoteHost}, Gateway: ${defaultRoute.gateway} via ${defaultRoute.iface}`)

  // Load split tunnel routes from settings
  const settings = loadSettings()
  const bypassRoutes = sanitizeBypassRoutes(settings.splitTunnelRoutes).join(',')

  const args = ['tun-up', tun2socksBin, SOCKS_ADDR, remoteHost, defaultRoute.gateway, defaultRoute.iface]
  if (bypassRoutes) args.push(bypassRoutes)

  try {
    await runPrivileged(args)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('dismissed') || msg.includes('cancelled') || msg.includes('Not authorized')) {
      throw new Error('Admin authentication was cancelled. VPN tunnel requires root privileges.')
    }
    throw new Error(`Failed to set up VPN tunnel: ${msg}`)
  }

  // Verify TUN came up
  if (!isTunUp()) {
    throw new Error('TUN interface did not appear. tun2socks may have failed to start.')
  }

  console.log(`[tun2socks] TUN interface ${TUN_IFACE} is up, routing configured`)
  tunActive = true
  // The uplink this tunnel's bypass route was built against. See hasDefaultRouteChanged.
  tunRoute = defaultRoute
}

/** Bring down tun2socks TUN interface and restore routing */
async function bringDownTun(): Promise<void> {
  if (!tunActive && !isTunUp()) return

  try {
    await runPrivileged(['tun-down'])
  } catch {
    // Best-effort
  }
  tunActive = false
  tunRoute = null
}

/**
 * Has the physical default route moved since the TUN was brought up?
 *
 * tun2socks does NOT replace the default route (it adds the two /1 halves plus a
 * host route to the node via the gateway that existed at bring-up), so
 * `ip route show default` keeps reporting the real uplink and this comparison stays
 * meaningful for as long as the tunnel is up. When it changes — Wi-Fi to wired, a
 * resume onto a different network — the node bypass route points at a gateway that no
 * longer exists and the tunnel is dead, while the xray process and the TUN both look
 * perfectly healthy.
 *
 * Returns false when there is nothing to compare or the route can't be read: a
 * tunnel must never be torn down because `ip route` hiccuped.
 */
export function hasDefaultRouteChanged(): boolean {
  if (!tunActive || !tunRoute) return false
  const now = getDefaultRoute()
  if (!now) return false
  return now.gateway !== tunRoute.gateway || now.iface !== tunRoute.iface
}

// Cached major version per binary path. The bundled binary is pinned (its hash is
// verified at resolveBundled), so we never re-probe it; system-PATH fallbacks
// are probed once and cached.
const v2rayVersionCache = new Map<string, number>()

function probeV2RayVersion(bin: string): number {
  for (const flag of ['version', '-version']) {
    try {
      const out = execFileSync(bin, [flag], { stdio: 'pipe' }).toString()
      const match = out.match(/V2Ray (\d+)\./)
      if (match) return parseInt(match[1], 10)
    } catch { /* try next flag */ }
  }
  return 0
}

function v2rayArgs(bin: string, configFile: string): string[] {
  // Bundled binary is pinned at V5; resolveBundled() returns the basename
  // 'v2ray' only when falling back to system PATH.
  const isBundled = bin !== 'v2ray'
  let major = v2rayVersionCache.get(bin)
  if (major === undefined) {
    major = isBundled ? 5 : probeV2RayVersion(bin)
    v2rayVersionCache.set(bin, major)
  }
  return v2rayRunArgs(major, configFile)
}

/** V2RAY/XRAY_LOCATION_ASSET so a core can find geoip/geosite if bundled alongside it. */
function coreEnv(bin: string): NodeJS.ProcessEnv {
  const binDir = join(bin, '..')
  return { ...process.env, V2RAY_LOCATION_ASSET: binDir, XRAY_LOCATION_ASSET: binDir }
}

/**
 * Spawn the proxy child (v2ray by default; xray when overridden) and monitor it.
 * xray reuses this whole lifecycle — same stdout/stderr capture, log file, and
 * exit handler that tears down the TUN — differing only in binary, CLI args, and
 * log filename.
 */
function spawnV2Ray(
  configFile: string,
  opts?: { bin?: string; args?: string[]; logName?: string },
): ChildProcess {
  const bin = opts?.bin ?? resolveV2RayBinary()
  const args = opts?.args ?? v2rayArgs(bin, configFile)
  const logName = opts?.logName ?? 'v2ray.log'

  // Capture both stdout and stderr — V2Ray v4 outputs errors to stdout
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: coreEnv(bin),
  })

  // Persist the core's own output to a stable, user-readable file. The in-memory
  // ring buffer below only survives while the process is alive and is only
  // surfaced if it exits — but the failure we hit (process alive, outbound to
  // the node wedged) never exits, so the file is the only way to see why.
  // Truncated per spawn so it always holds the current session.
  const logPath = join(app.getPath('userData'), logName)
  activeLogPath = logPath
  try {
    writeFileSync(logPath, `# ${logName} session started ${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch { /* logging is best-effort */ }

  v2rayStderr = ''
  const collectOutput = (chunk: Buffer): void => {
    const text = chunk.toString()
    v2rayStderr += text
    // Keep only last 4KB in memory
    if (v2rayStderr.length > 4096) v2rayStderr = v2rayStderr.slice(-4096)
    try { appendFileSync(logPath, text) } catch { /* best-effort */ }
  }
  child.stdout?.on('data', collectOutput)
  child.stderr?.on('data', collectOutput)

  child.on('exit', (code) => {
    if (activeChild === child) {
      console.error(`v2ray exited with code ${code}. output: ${v2rayStderr}`)
      // V2Ray died — tear down TUN interface too
      if (tunActive || isTunUp()) {
        bringDownTun().catch(() => { /* best-effort */ })
      }
      activeChild = null
      activeProtocol = null
      activeMode = 'tunnel'
      activeConfigFile = null
      // Notify auto-reconnect handler
      if (v2rayExitCallback) {
        v2rayExitCallback()
      }
    }
  })

  return child
}

/**
 * Detect if VPN is already active on startup (e.g. after app restart).
 * Sets module state so disconnect works properly.
 * Also cleans up stale tun2socks state from a previous crash.
 */
export function detectExistingConnection(): void {
  if (isWireGuardUp()) {
    // A live sntl0 is kernel WG or userspace AmneziaWG (type tun) — adopt the
    // right protocol so disconnect uses the matching teardown verb.
    activeProtocol = sntl0IsKernelWireGuard() ? 'wireguard' : 'amneziawg'
    activeConfigFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  } else if (isOpenVpnUp()) {
    activeProtocol = 'openvpn'
    activeConfigFile = join(SECURE_TMPDIR, OVPN_CONFIG_NAME)
  }

  // Check for stale tun2socks from a previous crash
  if (isTunUp() && !activeChild) {
    console.log('[startup] Stale TUN interface detected — cleaning up')
    bringDownTun().catch(() => { /* best-effort cleanup */ })
  }
}

export function connectV2Ray(v2ray: V2Ray, dohResolverIp?: string | null, opts?: { proxyOnly?: boolean }): void {
  const bin = resolveV2RayBinary()
  if (bin === 'v2ray' && !binaryExists('v2ray')) {
    throw new Error('v2ray binary not found. The bundled binary is missing and no system v2ray is installed.')
  }

  // Use SDK to write config, then spawn ourselves (SDK hardcodes V5 CLI syntax)
  const configFile = v2ray.writeConfig()
  // Pin the node endpoint to an IP (so v2ray never re-resolves it through the
  // tunnel and deadlocks) and turn on v2ray's diagnostic logging (the SDK
  // silences it). Then re-validate: node-supplied config must reject log
  // file-paths / non-loopback inbounds before spawn.
  const cfg = pinV2RayNodeAddresses(
    withV2RayDiagnosticLog(JSON.parse(readFileSync(configFile, 'utf-8'))),
    resolveHostToIPv4,
  )
  assertSafeV2RayConfig(cfg)
  // After validating the node-supplied config, inject our DoH block (trusted,
  // derived only from the allow-listed resolver IP) so OS DNS is re-resolved over
  // HTTPS inside v2ray and tunnelled to the node — the node never sees the query.
  const finalCfg = dohResolverIp ? withV2RayDoH(cfg, dohResolverIp) : cfg
  writeFileSync(configFile, JSON.stringify(finalCfg, null, 2), { mode: 0o600 })
  const child = spawnV2Ray(configFile)

  activeChild = child
  activeProtocol = 'v2ray'
  activeMode = opts?.proxyOnly ? 'proxy' : 'tunnel'
  activeConfigFile = configFile
}

/** Bring up tun2socks after V2Ray is confirmed running — called from IPC handler */
export async function bringUpV2RayTunnel(): Promise<void> {
  await bringUpTun()
}

export async function connectWireGuard(wg: Wireguard): Promise<void> {
  if (!binaryExists('wg-quick')) {
    throw new Error(
      'wg-quick not found in PATH. Install wireguard-tools: sudo apt install wireguard-tools'
    )
  }

  await ensureSntl0Down()

  // Use buildConfigString and write to our own sntl0.conf instead of SDK's wgsent0.conf
  // This ensures we always use the sntl0 interface name, compatible with the helper script
  const built = wg.buildConfigString()
  if (!built) {
    throw new Error('Failed to build WireGuard config')
  }

  // Nodes advertise their endpoint as a hostname (on-chain remoteAddrs), which
  // leaves the kill switch with nothing to whitelist. Pin it while normal DNS
  // still works — before the guard, so what we validate is what we write.
  const configString = pinWireguardEndpoint(built, resolveHostToIPv4)

  // Node operators are untrusted: reject any config carrying script-executing
  // directives (PostUp/PreUp/…) before wg-quick runs it as root.
  assertSafeWireguardConfig(configString)

  const configFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  writeFileSync(configFile, configString, { mode: 0o600 })

  await bringUpWireGuard(configFile)

  activeProtocol = 'wireguard'
  activeMode = 'tunnel'
  activeConfigFile = configFile
}

export async function connectWireGuardFromConfig(raw: string): Promise<void> {
  if (!binaryExists('wg-quick')) {
    throw new Error(
      'wg-quick not found in PATH. Install wireguard-tools: sudo apt install wireguard-tools'
    )
  }

  await ensureSntl0Down()

  // A saved config carries whatever the node advertised at handshake time, so a
  // reconnect needs the same endpoint pin as a fresh connect (and needs it more:
  // by now the kill switch may be the thing blocking the lookup).
  const configString = pinWireguardEndpoint(raw, resolveHostToIPv4)

  // Saved/reconnect configs are equally untrusted — guard before wg-quick (root).
  assertSafeWireguardConfig(configString)

  const configFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  writeFileSync(configFile, configString, { mode: 0o600 })

  try {
    await bringUpWireGuard(configFile)
  } catch (err) {
    if (existsSync(configFile)) unlinkSync(configFile)
    throw err
  }

  activeProtocol = 'wireguard'
  activeMode = 'tunnel'
  activeConfigFile = configFile
}

/** Bring up AmneziaWG from a config file via the bundled awg-quick (helper verb) */
async function bringUpAmneziaWg(configFile: string, binDir: string): Promise<void> {
  try {
    await runPrivileged(['awg-up', configFile, binDir])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('dismissed') || msg.includes('cancelled') || msg.includes('Not authorized')) {
      throw new Error('Admin authentication was cancelled. AmneziaWG requires root privileges.')
    }
    if (msg.includes('unknown op')) {
      // A pre-AWG daemon is still running (deb upgraded but the unit restart failed).
      throw new Error(
        'The Katacomb privileged service is out of date. Restart it (sudo systemctl restart katacomb-vpn-daemon) or reboot, then reconnect.'
      )
    }
    if (isDnsProvisionError(msg)) {
      throw new Error(`${DNS_PROVISION_FAILED}: Failed to bring up AmneziaWG interface: ${msg}`)
    }
    throw new Error(`Failed to bring up AmneziaWG interface: ${msg}`)
  }
}

export async function connectAmneziaWgFromConfig(raw: string): Promise<void> {
  // Fail fast on missing/tampered bundled binaries before any tunnel state changes.
  const binDir = resolveAmneziaWgBinDir()

  await ensureSntl0Down()

  // Rides the WG branch, so it has the WG endpoint problem too — same pin.
  const configString = pinWireguardEndpoint(raw, resolveHostToIPv4)

  // Node operators are untrusted: same PostUp/PreUp root-exec surface as
  // wg-quick, guarded by the AWG-aware allow-list before awg-quick runs as root.
  assertSafeAmneziaWgConfig(configString)

  const configFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  writeFileSync(configFile, configString, { mode: 0o600 })

  try {
    await bringUpAmneziaWg(configFile, binDir)
  } catch (err) {
    if (existsSync(configFile)) unlinkSync(configFile)
    throw err
  }

  activeProtocol = 'amneziawg'
  activeMode = 'tunnel'
  activeConfigFile = configFile
}

/**
 * Resolve the system openvpn binary from an absolute-path allow-list. Unlike the
 * child proxies there is deliberately no bundled copy: openvpn is a TLS client, so
 * distro packaging (which ships OpenSSL security updates) is a better supply chain
 * than a binary we vendor and would have to re-cut on every CVE. Same shape as
 * plain WireGuard depending on the system wg-quick. `which` is not used — the
 * binary runs as root, so the lookup must not depend on $PATH.
 */
function resolveOpenVpnBinary(): string {
  for (const candidate of ['/usr/sbin/openvpn', '/sbin/openvpn', '/usr/bin/openvpn']) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('openvpn is not installed. Install the openvpn package.')
}

/** Check if our OpenVPN interface (sntl-ovpn) is currently up */
export function isOpenVpnUp(): boolean {
  try {
    execSync(`ip link show ${OVPN_IFACE}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Bring down our OpenVPN tunnel and clean its config (which holds the client key) */
async function bringDownOpenVpn(): Promise<void> {
  try {
    await runPrivileged(['ovpn-down'])
  } catch {
    // Best-effort
  }

  const ourConfig = join(SECURE_TMPDIR, OVPN_CONFIG_NAME)
  if (existsSync(ourConfig)) {
    try { unlinkSync(ourConfig) } catch { /* ignore */ }
  }
}

/** Bring up OpenVPN from a config file via the helper (which daemonizes it) */
async function bringUpOpenVpn(configFile: string): Promise<void> {
  try {
    await runPrivileged(['ovpn-up', configFile])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('dismissed') || msg.includes('cancelled') || msg.includes('Not authorized')) {
      throw new Error('Admin authentication was cancelled. OpenVPN requires root privileges.')
    }
    if (msg.includes('unknown op')) {
      // A pre-OpenVPN daemon is still running (deb upgraded but the unit restart failed).
      throw new Error(
        'The Katacomb privileged service is out of date. Restart it (sudo systemctl restart katacomb-vpn-daemon) or reboot, then reconnect.'
      )
    }
    throw new Error(`Failed to bring up OpenVPN interface: ${msg}`)
  }
}

export async function connectOpenVpnFromConfig(configString: string): Promise<void> {
  // Fail fast before any tunnel state changes. In the daemon path root resolves its
  // own binary; this still catches the missing-package case up front.
  resolveOpenVpnBinary()

  await ensureOpenVpnDown()

  // Node operators are untrusted: an .ovpn can carry up/down/plugin directives that
  // openvpn executes as root, so the allow-list runs before the helper does. The
  // daemon re-validates (its socket is the real trust boundary) and the helper
  // passes --script-security 0 on the command line as a third line of defense.
  assertSafeOpenVpnConfig(configString)

  const configFile = join(SECURE_TMPDIR, OVPN_CONFIG_NAME)
  writeFileSync(configFile, configString, { mode: 0o600 })

  try {
    await bringUpOpenVpn(configFile)
  } catch (err) {
    if (existsSync(configFile)) unlinkSync(configFile)
    throw err
  }

  activeProtocol = 'openvpn'
  activeMode = 'tunnel'
  activeConfigFile = configFile
}

/**
 * Read the OpenVPN endpoint host from the active config, for the kill-switch
 * whitelist. IPv4 only — the same constraint getWireGuardRemoteHost applies,
 * since the kill switch's `-d host` rule needs an address.
 */
export function getOpenVpnRemoteHost(): string | null {
  try {
    const configPath = activeConfigFile || join(SECURE_TMPDIR, OVPN_CONFIG_NAME)
    if (!existsSync(configPath)) return null
    const host = extractOpenVpnRemoteHost(readFileSync(configPath, 'utf-8'))
    if (host && /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host
  } catch { /* ignore */ }
  return null
}

export function connectV2RayFromConfig(configString: string, dohResolverIp?: string | null, opts?: { proxyOnly?: boolean }): void {
  const bin = resolveV2RayBinary()
  if (bin === 'v2ray' && !binaryExists('v2ray')) {
    throw new Error('v2ray binary not found. The bundled binary is missing and no system v2ray is installed.')
  }

  // Validate that configString is actual JSON, not a stale file path
  let parsed: unknown
  try {
    parsed = JSON.parse(configString)
  } catch {
    throw new Error(
      'Invalid V2Ray config. This session was saved with an older version. ' +
      'Please end this session and create a new subscription.'
    )
  }
  const cfg = pinV2RayNodeAddresses(withV2RayDiagnosticLog(parsed), resolveHostToIPv4)
  assertSafeV2RayConfig(cfg)
  // Inject DoH after validation (trusted, allow-listed resolver only) — see connectV2Ray.
  const finalCfg = dohResolverIp ? withV2RayDoH(cfg, dohResolverIp) : cfg

  writeFileSync(V2RAY_CONFIG, JSON.stringify(finalCfg, null, 2), { mode: 0o600 })

  const child = spawnV2Ray(V2RAY_CONFIG)

  activeChild = child
  activeProtocol = 'v2ray'
  activeMode = opts?.proxyOnly ? 'proxy' : 'tunnel'
  activeConfigFile = V2RAY_CONFIG
}

/**
 * Connect an XRAY (VLESS + Reality) tunnel from a config string. xray-core reads the
 * same JSON as v2ray, so this reuses the entire V2Ray path — the untrusted-config
 * guard, node-address pinning, DoH injection, and tun2socks routing — differing only
 * in the binary (xray) and its CLI. The config is built by xray-config.ts (the SDK
 * can't emit Reality) in the handshake, or reloaded from a saved session on reconnect.
 */
export function connectXRayFromConfig(configString: string, dohResolverIp?: string | null, opts?: { proxyOnly?: boolean }): void {
  const bin = resolveXRayBinary()
  if (bin === 'xray' && !binaryExists('xray')) {
    throw new Error('xray binary not found. The bundled binary is missing and no system xray is installed.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(configString)
  } catch {
    throw new Error(
      'Invalid Xray config. This session was saved with an older version. ' +
      'Please end this session and create a new subscription.'
    )
  }
  // Same untrusted-node-config treatment as v2ray: pin endpoints to IPs (no DNS
  // deadlock through the tunnel), force diagnostic logging to stderr, then validate
  // (reject log file-paths / non-loopback inbounds) before spawn.
  const cfg = pinV2RayNodeAddresses(withV2RayDiagnosticLog(parsed), resolveHostToIPv4)
  assertSafeV2RayConfig(cfg)
  const finalCfg = dohResolverIp ? withV2RayDoH(cfg, dohResolverIp) : cfg

  writeFileSync(V2RAY_CONFIG, JSON.stringify(finalCfg, null, 2), { mode: 0o600 })

  const child = spawnV2Ray(V2RAY_CONFIG, { bin, args: ['run', '-c', V2RAY_CONFIG], logName: 'xray.log' })

  activeChild = child
  activeProtocol = 'xray'
  activeMode = opts?.proxyOnly ? 'proxy' : 'tunnel'
  activeConfigFile = V2RAY_CONFIG
}

/**
 * Where the entry-only provisioning proxy listens. Deliberately not 1080: that is the
 * live tunnel's listener, and although the UI refuses to build a chain while connected,
 * a fixed separate port means the two can never fight over it even if that changes.
 */
export const PROVISION_SOCKS_PORT = 1081
const PROVISION_READY_TIMEOUT_MS = 8000

/** A running provisioning proxy. `stop()` is idempotent and must always be called. */
export interface ProvisioningProxy {
  port: number
  stop: () => void
}

/**
 * Start a SHORT-LIVED xray whose only job is to relay a handful of HTTPS requests
 * through the entry hop, so the exit hop is graded, preflighted and handshaked without
 * ever seeing the user's address (see buildEntryOnlyConfig).
 *
 * Deliberately NOT registered as the active connection: it never touches activeChild,
 * activeProtocol, activeConfigFile or activeMode. Registering it would make
 * getConnectionStatus() report "connected" and isVpnActive() return true while a chain
 * is still being bought — which would, among other things, make the app treat the chain
 * as unreachable and serve cached balances mid-purchase.
 *
 * It also has its own spawn rather than reusing spawnV2Ray: it wants none of that
 * function's lifecycle (no shared log file, no shared stderr ring buffer, and above all
 * no exit handler that tears the TUN down). Its output is captured locally and attached
 * to the failure, which is the only place it is useful.
 *
 * Runs on the xray binary for the same reason a chain does: xray-core is a strict
 * superset of what the builder emits, so one runtime covers a v2ray or an xray entry.
 */
export async function startProvisioningProxy(configString: string): Promise<ProvisioningProxy> {
  const bin = resolveXRayBinary()
  if (bin === 'xray' && !binaryExists('xray')) {
    throw new Error('xray binary not found. The bundled binary is missing and no system xray is installed.')
  }

  // Same untrusted-node-config treatment the real connect path applies: pin the entry
  // endpoint to an IP (this one MUST resolve locally — it is the hop we dial directly),
  // force diagnostics to stderr, then validate before spawning.
  const cfg = pinV2RayNodeAddresses(withV2RayDiagnosticLog(JSON.parse(configString)), resolveHostToIPv4)
  assertSafeV2RayConfig(cfg)

  const configFile = join(SECURE_TMPDIR, 'provision.json')
  writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 })

  const child = spawn(bin, ['run', '-c', configFile], { stdio: ['ignore', 'pipe', 'pipe'], env: coreEnv(bin) })
  let output = ''
  const collect = (chunk: Buffer): void => {
    output += chunk.toString()
    if (output.length > 4096) output = output.slice(-4096)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    try { if (existsSync(configFile)) unlinkSync(configFile) } catch { /* best-effort */ }
  }

  try {
    await waitForListener(PROVISION_SOCKS_PORT, child, PROVISION_READY_TIMEOUT_MS)
  } catch (err) {
    stop()
    const detail = output.trim().slice(0, 500)
    throw new Error(
      `Could not start the entry hop for provisioning: ${err instanceof Error ? err.message : String(err)}` +
      (detail ? `\n\nxray output:\n${detail}` : ''),
    )
  }

  return { port: PROVISION_SOCKS_PORT, stop }
}

/**
 * Resolve once the proxy is accepting connections, reject if it dies or never listens.
 * Polling a real TCP connect rather than sleeping a fixed interval: this sits in front
 * of a purchase, so being slower than necessary costs the user time and being faster
 * than the listener costs a false failure.
 */
function waitForListener(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (child.exitCode !== null) {
        reject(new Error(`xray exited with code ${child.exitCode} before it began listening`))
        return
      }
      const probe = netConnect({ host: '127.0.0.1', port })
      probe.once('connect', () => { probe.destroy(); resolve() })
      probe.once('error', () => {
        probe.destroy()
        if (Date.now() > deadline) reject(new Error(`nothing listening on 127.0.0.1:${port} after ${timeoutMs}ms`))
        else setTimeout(attempt, 150)
      })
    }
    attempt()
  })
}

/**
 * Connect a Hysteria2 (QUIC) tunnel from a config string. The hysteria client exposes
 * a loopback SOCKS5 listener that tun2socks routes through — the same path as
 * v2ray/xray — so only the binary (`hysteria client -c`) and the config shape differ.
 * The config is synthesized by hysteria-config.ts in the handshake (the SDK has no
 * Hysteria2 class), or reloaded from a saved session on reconnect. Node data is
 * untrusted: we pin the server to an IP (no DNS deadlock through the tunnel) and
 * re-validate with assertSafeHysteria2Config before spawn. The `.json` extension makes
 * hysteria's viper loader parse the config as JSON. No DoH (hysteria2 has no in-config
 * DoH mechanism — DNS resolves plaintext-through-tunnel, like WireGuard).
 */
export function connectHysteria2FromConfig(configString: string, opts?: { proxyOnly?: boolean }): void {
  const bin = resolveHysteria2Binary()
  if (bin === 'hysteria' && !binaryExists('hysteria')) {
    throw new Error('hysteria binary not found. The bundled binary is missing and no system hysteria is installed.')
  }

  let parsed: any
  try {
    parsed = JSON.parse(configString)
  } catch {
    throw new Error(
      'Invalid Hysteria2 config. This session was saved with an older version. ' +
      'Please end this session and create a new subscription.'
    )
  }

  // Pin the server endpoint to an IP so hysteria never re-resolves it through the
  // tunnel and deadlocks (the DNS-deadlock fix, as pinV2RayNodeAddresses does for v2ray).
  if (typeof parsed.server === 'string') {
    const colon = parsed.server.lastIndexOf(':')
    if (colon > 0) {
      const host = parsed.server.slice(0, colon)
      const port = parsed.server.slice(colon + 1)
      const ip = resolveHostToIPv4(host)
      if (ip) parsed.server = `${ip}:${port}`
    }
  }

  assertSafeHysteria2Config(parsed)

  writeFileSync(V2RAY_CONFIG, JSON.stringify(parsed, null, 2), { mode: 0o600 })

  const child = spawnV2Ray(V2RAY_CONFIG, { bin, args: ['client', '-c', V2RAY_CONFIG], logName: 'hysteria.log' })

  activeChild = child
  activeProtocol = 'hysteria2'
  activeMode = opts?.proxyOnly ? 'proxy' : 'tunnel'
  activeConfigFile = V2RAY_CONFIG
}

export async function disconnect(): Promise<void> {
  // Tear down tun2socks TUN interface first (before killing V2Ray)
  if (tunActive || isTunUp()) {
    await bringDownTun()
  }

  // Kill the proxy child (v2ray/xray) if running
  if (isChildProxy(activeProtocol) && activeChild) {
    try {
      activeChild.kill('SIGTERM')
    } catch { /* ignore */ }
    activeChild = null
  }

  // Bring down a userspace AmneziaWG sntl0 first — it is NOT `type wireguard`,
  // so the WG teardown below would never remove it.
  if (activeProtocol === 'amneziawg' || (isWireGuardUp() && !sntl0IsKernelWireGuard())) {
    await bringDownAmneziaWg()
  }

  // Bring down WireGuard interface
  if (activeProtocol === 'wireguard' || isWireGuardUp()) {
    await bringDownAllWireGuard()
  }

  // Bring down OpenVPN (its own interface, its own resident root process)
  if (activeProtocol === 'openvpn' || isOpenVpnUp()) {
    await bringDownOpenVpn()
  }

  // Clean up V2Ray config
  if (existsSync(V2RAY_CONFIG)) {
    try { unlinkSync(V2RAY_CONFIG) } catch { /* ignore */ }
  }

  // And the core's log. It is only diagnostic while the tunnel is up (getV2RayError
  // reads the in-memory ring buffer, not this file), but at `loglevel: warning` xray
  // records dial failures and the destinations behind them — for a chain, both hops'
  // addresses and the sites that failed to load. Leaving that on disk after the
  // session is over is a record of where the user went, kept by a VPN client.
  if (activeLogPath && existsSync(activeLogPath)) {
    try { unlinkSync(activeLogPath) } catch { /* ignore */ }
  }
  activeLogPath = null

  activeProtocol = null
  activeMode = 'tunnel'
  activeConfigFile = null
  activeChild = null
}

/**
 * Is the spawned child proxy (v2ray/xray/hysteria2) still running?
 *
 * Deliberately NOT the same question as `getConnectionStatus().connected`, which
 * means "traffic is actually being carried". The connect paths spawn the core,
 * wait, and need to know only whether it survived startup: at that point, in
 * tunnel mode, tun2socks has not been brought up yet and nothing is flowing by
 * design. Conflating the two made every tunnel-mode connect report the core as
 * having exited immediately.
 */
export function isProxyChildAlive(): boolean {
  return isChildProxy(activeProtocol) && !!activeChild && activeChild.exitCode === null
}

export function getConnectionStatus(): {
  connected: boolean
  protocol: string | null
  proxyMode: boolean
  socksAddr?: string
} {
  // V2Ray/Xray/Hysteria2: the spawned process is the connection in local-proxy
  // mode, but in tunnel mode it is only half of one — see
  // isChildProxyCarryingTraffic. Until tun2socks' interface exists the child is
  // running and the user's traffic is still leaving by the physical NIC.
  if (isChildProxy(activeProtocol)) {
    const childAlive = !!activeChild && activeChild.exitCode === null
    if (childAlive) {
      const proxyMode = activeMode === 'proxy'
      // Bring-up still in flight (typically the polkit dialog for tun-up). Not
      // connected, and deliberately no state cleanup: the child is fine.
      if (!isChildProxyCarryingTraffic({ childAlive, proxyMode, tunUp: isTunUp() })) {
        return { connected: false, protocol: null, proxyMode: false }
      }
      return {
        connected: true,
        protocol: activeProtocol,
        proxyMode,
        ...(proxyMode ? { socksAddr: SOCKS_ADDR } : {}),
      }
    }
    // Proxy process exited unexpectedly — clean up stale state
    activeProtocol = null
    activeMode = 'tunnel'
    activeConfigFile = null
    activeChild = null
  }

  // Check if the sntl0 interface is actually up (works even after app restart)
  if (isWireGuardUp()) {
    if (!activeProtocol) activeProtocol = sntl0IsKernelWireGuard() ? 'wireguard' : 'amneziawg'
    return { connected: true, protocol: activeProtocol, proxyMode: false }
  }

  // OpenVPN lives on its own interface — same presence check, works after restart.
  if (isOpenVpnUp()) {
    if (!activeProtocol) activeProtocol = 'openvpn'
    return { connected: true, protocol: activeProtocol, proxyMode: false }
  }

  // WG/AWG/OpenVPN was supposed to be active but the interface is gone
  if (activeProtocol === 'wireguard' || activeProtocol === 'amneziawg' || activeProtocol === 'openvpn') {
    activeProtocol = null
    activeConfigFile = null
  }

  return { connected: false, protocol: null, proxyMode: false }
}

/** Check if any VPN (WireGuard or V2Ray+tun2socks) is currently active */
export function isVpnActive(): boolean {
  if (isWireGuardUp()) return true
  if (isTunUp()) return true
  if (isOpenVpnUp()) return true
  // Nothing else redirects system traffic, which is all this function means.
  // Local-proxy mode deliberately leaves routing alone, so the RPC endpoint stays
  // reachable — callers use this to decide whether to fall back to cached chain
  // data, and in proxy mode they shouldn't. A child-proxy TUNNEL is the tun2socks
  // interface already checked above, so a live child without it is a bring-up
  // still in flight, not an active VPN.
  return false
}

/**
 * The live SOCKS5 port when local-proxy mode is what's running, else null.
 *
 * This exists for one caller: the multihop picker's grading probe. In TUNNEL mode
 * nobody needs it, because the OS already carries our probes through the tunnel
 * (wg/awg/openvpn replace the default route; tun2socks owns 0.0.0.0/1 + 128.0.0.0/1,
 * and only the connected node's own /32 bypasses it). Proxy mode is the one state
 * where a tunnel exists and our own traffic does NOT use it, so it's the only place
 * a caller has to route itself.
 *
 * Deliberately NOT isVpnActive()'s inverse: that returns false here on purpose, to
 * mean "system routing is untouched, don't fall back to cached chain data".
 */
export function getActiveProxyPort(): number | null {
  if (activeMode !== 'proxy') return null
  if (!isChildProxy(activeProtocol)) return null
  if (!activeChild || activeChild.exitCode !== null) return null
  return SOCKS_PORT
}

/** Get V2Ray error output if the process crashed */
export function getV2RayError(): string {
  return v2rayStderr
}

/** Get the V2Ray remote server IP from the active config */
export function getV2RayRemoteHost(): string | null {
  return extractV2RayRemoteHost()
}

/**
 * Get the WireGuard server endpoint IP from the active config, for whitelisting
 * in the kill switch. Returns null for hostnames (the helper validates IPv4),
 * which is strictly better than the old `0.0.0.0` placeholder that blocked the
 * tunnel's own re-handshake.
 */
export function getWireGuardRemoteHost(): string | null {
  try {
    const configFile = activeConfigFile || join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
    if (!existsSync(configFile)) return null
    const host = extractWireguardEndpointHost(readFileSync(configFile, 'utf-8'))
    return host && /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : null
  } catch {
    return null
  }
}

/** Register a callback for unexpected V2Ray disconnection */
export function onV2RayUnexpectedExit(callback: () => void): void {
  v2rayExitCallback = callback
}

/** Detect other VPN connections that might conflict */
export function detectOtherVpn(): { type: string; name: string; iface?: string }[] {
  const found: { type: string; name: string; iface?: string }[] = []

  // Check for non-sntl0 WireGuard interfaces (Mullvad, IVPN, manual WG, etc.)
  try {
    const output = execSync('ip -o link show type wireguard', { stdio: 'pipe' }).toString().trim()
    if (output) {
      for (const line of output.split('\n')) {
        const match = line.match(/^\d+:\s+(\S+):/)
        if (match && match[1] !== WG_IFACE) {
          found.push({ type: 'wireguard', name: `WireGuard (${match[1]})`, iface: match[1] })
        }
      }
    }
  } catch { /* ignore */ }

  // Check for third-party TUN interfaces — exclude our own sntl-tun, sntl-ovpn AND
  // sntl0 (a userspace AmneziaWG sntl0 is a plain tun device, not `type wireguard`).
  try {
    const output = execSync('ip -o link show type tun', { stdio: 'pipe' }).toString().trim()
    if (output) {
      for (const line of output.split('\n')) {
        const match = line.match(/^\d+:\s+(\S+):/)
        if (match && match[1] !== TUN_IFACE && match[1] !== WG_IFACE && match[1] !== OVPN_IFACE) {
          found.push({ type: 'tun', name: `Tunnel (${match[1]})`, iface: match[1] })
        }
      }
    }
  } catch { /* ignore */ }

  return found
}

export async function killAllTunnels(): Promise<void> {
  // Tear down tun2socks first
  if (tunActive || isTunUp()) {
    await bringDownTun()
  }

  if (activeChild && !activeChild.killed) {
    activeChild.kill('SIGTERM')
  }

  await ensureSntl0Down()
  await ensureOpenVpnDown()

  if (existsSync(V2RAY_CONFIG)) {
    try { unlinkSync(V2RAY_CONFIG) } catch { /* ignore */ }
  }

  activeChild = null
  activeProtocol = null
  activeConfigFile = null
}
