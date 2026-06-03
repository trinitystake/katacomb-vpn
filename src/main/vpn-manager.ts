import { execSync, execFileSync, spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { Wireguard, V2Ray } from '@sentinel-official/sentinel-js-sdk'
import {
  assertSafeWireguardConfig,
  assertSafeV2RayConfig,
  sanitizeBypassRoutes,
  extractWireguardEndpointHost,
} from './config-guard'

const WG_IFACE = 'sntl0'
const HELPER_PATH = '/usr/local/bin/sentinel-vpn-helper'

// Create a private temp directory for config files (mode 0o700, not predictable)
const SECURE_TMPDIR = mkdtempSync(join(tmpdir(), 'sentinel-dvpn-'))
const V2RAY_CONFIG = join(SECURE_TMPDIR, 'v2ray.json')

// SHA-256 hashes of bundled binaries (verified at download time)
const BUNDLED_HASHES: Record<string, string> = {
  v2ray: '751f52a3d9324c993953b7ebb6aab79e77115542a8ca1ef83078cb215c03dea8',
  tun2socks: '42ce074a9a225825ef5e3f21b3657af7ed25187f7cd4e6d11e0646d5d166eb04',
}

/** Verify a bundled binary's SHA-256 hash matches the expected value */
function verifyBinaryIntegrity(path: string, name: string): boolean {
  const expected = BUNDLED_HASHES[name]
  if (!expected) return true // no hash registered — skip check
  try {
    const data = readFileSync(path)
    const actual = createHash('sha256').update(data).digest('hex')
    return actual === expected
  } catch {
    return false
  }
}

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
        `Refusing to run — reinstall the app to restore the verified binary.`
      )
    }
    return bundled
  }
  return name // fall back to system PATH
}

function resolveV2RayBinary(): string {
  return resolveBundled('v2ray')
}

function resolveTun2Socks(): string {
  return resolveBundled('tun2socks')
}

const TUN_IFACE = 'sntl-tun'
const SOCKS_ADDR = '127.0.0.1:1080'

let activeChild: ChildProcess | null = null
let activeProtocol: 'wireguard' | 'v2ray' | null = null
let activeConfigFile: string | null = null
let v2rayStderr = ''
let tunActive = false
let v2rayExitCallback: (() => void) | null = null

export function binaryExists(name: string): boolean {
  // Only allow simple binary names (no paths, no shell metacharacters)
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return false
  try {
    execSync(`which ${name}`, { stdio: 'ignore' })
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

function helperInstalled(): boolean {
  return existsSync(HELPER_PATH)
}

/** Run a privileged command via the helper script (polkit cached) */
export function runPrivileged(args: string[]): void {
  if (!helperInstalled()) {
    throw new Error('VPN helper not installed. Please restart the app to set it up.')
  }
  // Pass args as separate shell-escaped tokens — no shell interpolation
  const escaped = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  execSync(`pkexec ${HELPER_PATH} ${escaped}`, { stdio: 'pipe', timeout: 60000 })
}

/** Check if our Sentinel WireGuard interface (sntl0) is currently up */
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

/** Bring down ALL WireGuard interfaces — single password prompt via helper */
function bringDownAllWireGuard(): void {
  if (!isAnyWireGuardUp()) return

  try {
    runPrivileged(['down'])
  } catch {
    // Best-effort
  }

  // Clean up our temp config file
  const ourConfig = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  if (existsSync(ourConfig)) {
    try { unlinkSync(ourConfig) } catch { /* ignore */ }
  }
}

/** Bring up WireGuard from a config file path (must be named sntl0.conf) */
function bringUpWireGuard(configFile: string): void {
  try {
    runPrivileged(['up', configFile])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('dismissed') || msg.includes('cancelled') || msg.includes('Not authorized')) {
      throw new Error('Admin authentication was cancelled. WireGuard requires root privileges.')
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

/** Extract V2Ray remote server IP from the active config file, resolving hostnames to IPs */
function extractV2RayRemoteHost(): string | null {
  try {
    const configPath = activeConfigFile || V2RAY_CONFIG
    if (!existsSync(configPath)) return null
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    for (const ob of config.outbounds || []) {
      const addr = ob?.settings?.vnext?.[0]?.address
      if (addr && addr !== '127.0.0.1') {
        // If it's already an IP, return it directly
        if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return addr
        // Validate hostname before passing to shell (no shell metacharacters)
        if (!/^[a-zA-Z0-9._-]+$/.test(addr)) return null
        // Resolve hostname to IP (must happen before tunnel routes are set up)
        try {
          const resolved = execSync(`getent ahostsv4 '${addr}' | head -1 | awk '{print $1}'`, {
            stdio: 'pipe', timeout: 5000,
          }).toString().trim()
          if (resolved && /^\d+\.\d+\.\d+\.\d+$/.test(resolved)) return resolved
        } catch { /* ignore */ }
        return null // can't resolve — don't pass raw hostname to ip route
      }
    }
  } catch { /* ignore */ }
  return null
}

/** Get the current default gateway and interface */
function getDefaultRoute(): { gateway: string; iface: string } | null {
  try {
    const output = execSync('ip route show default', { stdio: 'pipe' }).toString().trim()
    const gwMatch = output.match(/default via (\S+)/)
    const ifMatch = output.match(/dev (\S+)/)
    if (gwMatch && ifMatch) return { gateway: gwMatch[1], iface: ifMatch[1] }
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
function bringUpTun(): void {
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
  const { loadSettings } = require('./settings') as typeof import('./settings')
  const settings = loadSettings()
  const bypassRoutes = sanitizeBypassRoutes(settings.splitTunnelRoutes).join(',')

  const args = ['tun-up', tun2socksBin, SOCKS_ADDR, remoteHost, defaultRoute.gateway, defaultRoute.iface]
  if (bypassRoutes) args.push(bypassRoutes)

  try {
    runPrivileged(args)
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
}

/** Bring down tun2socks TUN interface and restore routing */
function bringDownTun(): void {
  if (!tunActive && !isTunUp()) return

  try {
    runPrivileged(['tun-down'])
  } catch {
    // Best-effort
  }
  tunActive = false
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
  return major >= 5 ? ['run', '-config', configFile] : ['-config', configFile]
}

/** Spawn v2ray process and wait briefly to confirm it stays alive */
function spawnV2Ray(configFile: string): ChildProcess {
  const bin = resolveV2RayBinary()
  const args = v2rayArgs(bin, configFile)

  // Set V2RAY_LOCATION_ASSET so v2ray can find geoip/geosite if bundled alongside
  const binDir = join(bin, '..')
  const env = { ...process.env, V2RAY_LOCATION_ASSET: binDir }

  // Capture both stdout and stderr — V2Ray v4 outputs errors to stdout
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })

  v2rayStderr = ''
  const collectOutput = (chunk: Buffer): void => {
    v2rayStderr += chunk.toString()
    // Keep only last 4KB
    if (v2rayStderr.length > 4096) v2rayStderr = v2rayStderr.slice(-4096)
  }
  child.stdout?.on('data', collectOutput)
  child.stderr?.on('data', collectOutput)

  child.on('exit', (code) => {
    if (activeChild === child) {
      console.error(`v2ray exited with code ${code}. output: ${v2rayStderr}`)
      // V2Ray died — tear down TUN interface too
      if (tunActive || isTunUp()) {
        try { bringDownTun() } catch { /* best-effort */ }
      }
      activeChild = null
      activeProtocol = null
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
    activeProtocol = 'wireguard'
    activeConfigFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  }

  // Check for stale tun2socks from a previous crash
  if (isTunUp() && !activeChild) {
    console.log('[startup] Stale TUN interface detected — cleaning up')
    try {
      bringDownTun()
    } catch {
      // Best-effort cleanup
    }
  }
}

export function connectV2Ray(v2ray: V2Ray): void {
  const bin = resolveV2RayBinary()
  if (bin === 'v2ray' && !binaryExists('v2ray')) {
    throw new Error('v2ray binary not found. The bundled binary is missing and no system v2ray is installed.')
  }

  // Use SDK to write config, then spawn ourselves (SDK hardcodes V5 CLI syntax)
  const configFile = v2ray.writeConfig()
  // Node-supplied config: reject log file-paths / non-loopback inbounds before spawn.
  assertSafeV2RayConfig(JSON.parse(readFileSync(configFile, 'utf-8')))
  const child = spawnV2Ray(configFile)

  activeChild = child
  activeProtocol = 'v2ray'
  activeConfigFile = configFile
}

/** Bring up tun2socks after V2Ray is confirmed running — called from IPC handler */
export function bringUpV2RayTunnel(): void {
  bringUpTun()
}

export function connectWireGuard(wg: Wireguard): void {
  if (!binaryExists('wg-quick')) {
    throw new Error(
      'wg-quick not found in PATH. Install wireguard-tools: sudo apt install wireguard-tools'
    )
  }

  if (isWireGuardUp()) {
    bringDownAllWireGuard()
  }

  // Use buildConfigString and write to our own sntl0.conf instead of SDK's wgsent0.conf
  // This ensures we always use the sntl0 interface name, compatible with the helper script
  const configString = wg.buildConfigString()
  if (!configString) {
    throw new Error('Failed to build WireGuard config')
  }

  // Node operators are untrusted: reject any config carrying script-executing
  // directives (PostUp/PreUp/…) before wg-quick runs it as root.
  assertSafeWireguardConfig(configString)

  const configFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  writeFileSync(configFile, configString, { mode: 0o600 })

  bringUpWireGuard(configFile)

  activeProtocol = 'wireguard'
  activeConfigFile = configFile
}

export function connectWireGuardFromConfig(configString: string): void {
  if (!binaryExists('wg-quick')) {
    throw new Error(
      'wg-quick not found in PATH. Install wireguard-tools: sudo apt install wireguard-tools'
    )
  }

  if (isWireGuardUp()) {
    bringDownAllWireGuard()
  }

  // Saved/reconnect configs are equally untrusted — guard before wg-quick (root).
  assertSafeWireguardConfig(configString)

  const configFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  writeFileSync(configFile, configString, { mode: 0o600 })

  try {
    bringUpWireGuard(configFile)
  } catch (err) {
    if (existsSync(configFile)) unlinkSync(configFile)
    throw err
  }

  activeProtocol = 'wireguard'
  activeConfigFile = configFile
}

export function connectV2RayFromConfig(configString: string): void {
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
  assertSafeV2RayConfig(parsed)

  writeFileSync(V2RAY_CONFIG, configString, { mode: 0o600 })

  const child = spawnV2Ray(V2RAY_CONFIG)

  activeChild = child
  activeProtocol = 'v2ray'
  activeConfigFile = V2RAY_CONFIG
}

export function disconnect(): void {
  // Tear down tun2socks TUN interface first (before killing V2Ray)
  if (tunActive || isTunUp()) {
    bringDownTun()
  }

  // Kill V2Ray process if running
  if (activeProtocol === 'v2ray' && activeChild) {
    try {
      activeChild.kill('SIGTERM')
    } catch { /* ignore */ }
    activeChild = null
  }

  // Bring down WireGuard interface
  if (activeProtocol === 'wireguard' || isWireGuardUp()) {
    bringDownAllWireGuard()
  }

  // Clean up V2Ray config
  if (existsSync(V2RAY_CONFIG)) {
    try { unlinkSync(V2RAY_CONFIG) } catch { /* ignore */ }
  }

  activeProtocol = null
  activeConfigFile = null
  activeChild = null
}

export function getConnectionStatus(): { connected: boolean; protocol: string | null } {
  // V2Ray: check if our spawned process is still running
  if (activeProtocol === 'v2ray' && activeChild && activeChild.exitCode === null) {
    return { connected: true, protocol: 'v2ray' }
  }

  // V2Ray process exited unexpectedly — clean up stale state
  if (activeProtocol === 'v2ray') {
    activeProtocol = null
    activeConfigFile = null
    activeChild = null
  }

  // Check if the WireGuard interface is actually up (works even after app restart)
  if (isWireGuardUp()) {
    if (!activeProtocol) activeProtocol = 'wireguard'
    return { connected: true, protocol: 'wireguard' }
  }

  // WG was supposed to be active but interface is gone
  if (activeProtocol === 'wireguard') {
    activeProtocol = null
    activeConfigFile = null
  }

  return { connected: false, protocol: null }
}

/** Check if any VPN (WireGuard or V2Ray+tun2socks) is currently active */
export function isVpnActive(): boolean {
  if (isWireGuardUp()) return true
  if (isTunUp()) return true
  if (activeProtocol === 'v2ray' && activeChild && activeChild.exitCode === null) return true
  return false
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

/** Detect non-Sentinel VPN connections that might conflict */
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

  // Check for TUN interfaces (OpenVPN, etc.) — exclude our own sntl-tun
  try {
    const output = execSync('ip -o link show type tun', { stdio: 'pipe' }).toString().trim()
    if (output) {
      for (const line of output.split('\n')) {
        const match = line.match(/^\d+:\s+(\S+):/)
        if (match && match[1] !== TUN_IFACE) {
          found.push({ type: 'tun', name: `Tunnel (${match[1]})`, iface: match[1] })
        }
      }
    }
  } catch { /* ignore */ }

  return found
}

export function killAllTunnels(): void {
  // Tear down tun2socks first
  if (tunActive || isTunUp()) {
    bringDownTun()
  }

  if (activeChild && !activeChild.killed) {
    activeChild.kill('SIGTERM')
  }

  if (isWireGuardUp()) {
    bringDownAllWireGuard()
  }

  if (existsSync(V2RAY_CONFIG)) {
    try { unlinkSync(V2RAY_CONFIG) } catch { /* ignore */ }
  }

  activeChild = null
  activeProtocol = null
  activeConfigFile = null
}
