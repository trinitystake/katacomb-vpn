import { execSync, execFileSync, spawn, type ChildProcess } from 'child_process'
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
  sanitizeBypassRoutes,
  extractWireguardEndpointHost,
} from './config-guard'
import { verifyBinaryIntegrity } from './binary-integrity'
import { runPrivileged } from './privileged'
import { loadSettings } from './settings'
import { parseDefaultRoute, v2rayRunArgs, firstIPv4FromGetent } from './vpn-parse'

const WG_IFACE = 'sntl0'

// Create a private temp directory for config files (mode 0o700, not predictable)
const SECURE_TMPDIR = mkdtempSync(join(tmpdir(), 'sentinel-dvpn-'))
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
        `Refusing to run — reinstall the app to restore the verified binary.`
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
const SOCKS_ADDR = '127.0.0.1:1080'

let activeChild: ChildProcess | null = null
let activeProtocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | null = null

// v2ray, xray and hysteria2 are all child-process + tun2socks tunnels with identical
// lifecycle handling (spawn a local SOCKS proxy, route it through tun2socks) — this
// narrows them together at the branch sites.
function isChildProxy(p: typeof activeProtocol): boolean {
  return p === 'v2ray' || p === 'xray' || p === 'hysteria2'
}
let activeConfigFile: string | null = null
let v2rayStderr = ''
let tunActive = false
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
export function protocolRuntimeError(protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2'): string | null {
  try {
    if (protocol === 'wireguard') {
      return binaryExists('wg-quick') ? null : 'wg-quick is not installed — install the wireguard-tools package.'
    }
    if (protocol === 'amneziawg') {
      resolveAmneziaWgBinDir()
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

/** Bring up WireGuard from a config file path (must be named sntl0.conf) */
async function bringUpWireGuard(configFile: string): Promise<void> {
  try {
    await runPrivileged(['up', configFile])
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
    for (const ob of config.outbounds || []) {
      const addr = ob?.settings?.vnext?.[0]?.address
      if (addr && addr !== '127.0.0.1') {
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

  // Set V2RAY/XRAY_LOCATION_ASSET so the core can find geoip/geosite if bundled alongside
  const binDir = join(bin, '..')
  const env = { ...process.env, V2RAY_LOCATION_ASSET: binDir, XRAY_LOCATION_ASSET: binDir }

  // Capture both stdout and stderr — V2Ray v4 outputs errors to stdout
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })

  // Persist the core's own output to a stable, user-readable file. The in-memory
  // ring buffer below only survives while the process is alive and is only
  // surfaced if it exits — but the failure we hit (process alive, outbound to
  // the node wedged) never exits, so the file is the only way to see why.
  // Truncated per spawn so it always holds the current session.
  const logPath = join(app.getPath('userData'), logName)
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
  }

  // Check for stale tun2socks from a previous crash
  if (isTunUp() && !activeChild) {
    console.log('[startup] Stale TUN interface detected — cleaning up')
    bringDownTun().catch(() => { /* best-effort cleanup */ })
  }
}

export function connectV2Ray(v2ray: V2Ray, dohResolverIp?: string | null): void {
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
  const configString = wg.buildConfigString()
  if (!configString) {
    throw new Error('Failed to build WireGuard config')
  }

  // Node operators are untrusted: reject any config carrying script-executing
  // directives (PostUp/PreUp/…) before wg-quick runs it as root.
  assertSafeWireguardConfig(configString)

  const configFile = join(SECURE_TMPDIR, `${WG_IFACE}.conf`)
  writeFileSync(configFile, configString, { mode: 0o600 })

  await bringUpWireGuard(configFile)

  activeProtocol = 'wireguard'
  activeConfigFile = configFile
}

export async function connectWireGuardFromConfig(configString: string): Promise<void> {
  if (!binaryExists('wg-quick')) {
    throw new Error(
      'wg-quick not found in PATH. Install wireguard-tools: sudo apt install wireguard-tools'
    )
  }

  await ensureSntl0Down()

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
        'The Sentinel privileged service is out of date. Restart it (sudo systemctl restart sentinel-dvpn-daemon) or reboot, then reconnect.'
      )
    }
    throw new Error(`Failed to bring up AmneziaWG interface: ${msg}`)
  }
}

export async function connectAmneziaWgFromConfig(configString: string): Promise<void> {
  // Fail fast on missing/tampered bundled binaries before any tunnel state changes.
  const binDir = resolveAmneziaWgBinDir()

  await ensureSntl0Down()

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
  activeConfigFile = configFile
}

export function connectV2RayFromConfig(configString: string, dohResolverIp?: string | null): void {
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
  activeConfigFile = V2RAY_CONFIG
}

/**
 * Connect an XRAY (VLESS + Reality) tunnel from a config string. xray-core reads the
 * same JSON as v2ray, so this reuses the entire V2Ray path — the untrusted-config
 * guard, node-address pinning, DoH injection, and tun2socks routing — differing only
 * in the binary (xray) and its CLI. The config is built by xray-config.ts (the SDK
 * can't emit Reality) in the handshake, or reloaded from a saved session on reconnect.
 */
export function connectXRayFromConfig(configString: string, dohResolverIp?: string | null): void {
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
  activeConfigFile = V2RAY_CONFIG
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
export function connectHysteria2FromConfig(configString: string): void {
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

  // Clean up V2Ray config
  if (existsSync(V2RAY_CONFIG)) {
    try { unlinkSync(V2RAY_CONFIG) } catch { /* ignore */ }
  }

  activeProtocol = null
  activeConfigFile = null
  activeChild = null
}

export function getConnectionStatus(): { connected: boolean; protocol: string | null } {
  // V2Ray/Xray: check if our spawned process is still running
  if (isChildProxy(activeProtocol) && activeChild && activeChild.exitCode === null) {
    return { connected: true, protocol: activeProtocol }
  }

  // Proxy process exited unexpectedly — clean up stale state
  if (isChildProxy(activeProtocol)) {
    activeProtocol = null
    activeConfigFile = null
    activeChild = null
  }

  // Check if the sntl0 interface is actually up (works even after app restart)
  if (isWireGuardUp()) {
    if (!activeProtocol) activeProtocol = sntl0IsKernelWireGuard() ? 'wireguard' : 'amneziawg'
    return { connected: true, protocol: activeProtocol }
  }

  // WG/AWG was supposed to be active but interface is gone
  if (activeProtocol === 'wireguard' || activeProtocol === 'amneziawg') {
    activeProtocol = null
    activeConfigFile = null
  }

  return { connected: false, protocol: null }
}

/** Check if any VPN (WireGuard or V2Ray+tun2socks) is currently active */
export function isVpnActive(): boolean {
  if (isWireGuardUp()) return true
  if (isTunUp()) return true
  if (isChildProxy(activeProtocol) && activeChild && activeChild.exitCode === null) return true
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

  // Check for TUN interfaces (OpenVPN, etc.) — exclude our own sntl-tun AND
  // sntl0 (a userspace AmneziaWG sntl0 is a plain tun device, not `type wireguard`).
  try {
    const output = execSync('ip -o link show type tun', { stdio: 'pipe' }).toString().trim()
    if (output) {
      for (const line of output.split('\n')) {
        const match = line.match(/^\d+:\s+(\S+):/)
        if (match && match[1] !== TUN_IFACE && match[1] !== WG_IFACE) {
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

  if (existsSync(V2RAY_CONFIG)) {
    try { unlinkSync(V2RAY_CONFIG) } catch { /* ignore */ }
  }

  activeChild = null
  activeProtocol = null
  activeConfigFile = null
}
