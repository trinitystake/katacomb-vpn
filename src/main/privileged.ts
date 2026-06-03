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
import { isDaemonAvailable, daemonRequest } from './daemon-client'

const HELPER_PATH = '/usr/local/bin/sentinel-vpn-helper'

export async function runPrivileged(args: string[]): Promise<void> {
  if (isDaemonAvailable()) {
    await runViaDaemon(args)
    return
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
