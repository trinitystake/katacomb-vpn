// Single entry point for every privileged VPN operation. Routes to the root
// daemon over the Unix socket when it's installed (deb → no password), and falls
// back to the per-op `pkexec` helper otherwise (AppImage / `npm run dev`).
//
// Callers keep using the helper's verb+args vocabulary (e.g. `['up', file]`);
// this module maps those to the daemon's JSON ops. For `up` we read the (app's
// own, 0600) config file and send its CONTENT — the daemon writes its own
// root-owned copy, so no user-controlled path ever reaches root.

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { isDaemonAvailable, daemonRequest, DaemonUnreachableError } from './daemon-client'

const HELPER_PATH = '/usr/local/bin/katacomb-vpn-helper'

/**
 * Is there any route to root right now — the daemon socket or the installed
 * helper? The connect preflight checks this before charging for a session that
 * needs a privileged bring-up (WireGuard/AmneziaWG).
 */
export function canEscalatePrivileges(): boolean {
  return isDaemonAvailable() || existsSync(HELPER_PATH)
}

export async function runPrivileged(args: string[]): Promise<void> {
  if (isDaemonAvailable()) {
    try {
      await runViaDaemon(args)
      return
    } catch (err) {
      // Only fall back to pkexec when the daemon is unreachable (dead process,
      // stale socket after an OOM/crash). A live daemon that *rejected* the op
      // (validation failure) must propagate — never silently retry it as root.
      if (!(err instanceof DaemonUnreachableError)) throw err
      // fall through to the pkexec path below with the same args
    }
  }
  if (!existsSync(HELPER_PATH)) {
    throw new Error('VPN helper not installed. Please restart the app to set it up.')
  }
  // No shell (see vpn-manager history): keep pkexec's parent the long-lived
  // Electron process so polkit's auth cache persists on the fallback path.
  execFileSync('pkexec', [HELPER_PATH, ...args], { stdio: 'pipe', timeout: 60000 })
}

async function runViaDaemon(args: string[]): Promise<void> {
  const [verb, ...rest] = args
  switch (verb) {
    case 'up': {
      const configString = readFileSync(rest[0], 'utf-8')
      await daemonRequest('wireguard_up', { configString })
      return
    }
    case 'down':
      await daemonRequest('wireguard_down')
      return
    case 'awg-up': {
      // rest = [configPath, binDir] — content is sent like `up`; the bindir is
      // dropped because the daemon resolves + SHA-pins its own AWG trio.
      const configString = readFileSync(rest[0], 'utf-8')
      await daemonRequest('amneziawg_up', { configString })
      return
    }
    case 'awg-down':
      await daemonRequest('amneziawg_down')
      return
    case 'ovpn-up': {
      // rest = [configPath] — content only; the daemon writes its own root-owned
      // copy and resolves its own openvpn binary.
      const configString = readFileSync(rest[0], 'utf-8')
      await daemonRequest('openvpn_up', { configString })
      return
    }
    case 'ovpn-down':
      await daemonRequest('openvpn_down')
      return
    case 'tun-up': {
      // rest = [tun2socksBin, socksAddr, remoteHost, gateway, iface, bypassCsv?]
      // The daemon resolves+pins its own tun2socks, so the bin arg is dropped.
      const [, socksAddr, remoteHost, gateway, iface, bypassCsv] = rest
      const bypassRoutes = bypassCsv ? bypassCsv.split(',') : []
      await daemonRequest('tun_up', { socksAddr, remoteHost, gateway, iface, bypassRoutes })
      return
    }
    case 'tun-down':
      await daemonRequest('tun_down')
      return
    case 'killswitch-on': {
      const [iface, remoteHost, dnsIp] = rest
      await daemonRequest('killswitch_on', { iface, remoteHost, dnsIp })
      return
    }
    case 'killswitch-off':
      await daemonRequest('killswitch_off')
      return
    case 'dns-set':
      await daemonRequest('dns_set', { dnsIp: rest[0] })
      return
    case 'dns-restore':
      await daemonRequest('dns_restore')
      return
    default:
      throw new Error(`unknown privileged verb: ${verb}`)
  }
}
