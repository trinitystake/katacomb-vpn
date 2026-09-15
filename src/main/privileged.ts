// Single entry point for every privileged VPN operation. Routes to the root
// daemon over the Unix socket when it's installed (deb → no password), and falls
// back to the per-op `pkexec` helper otherwise (AppImage / `npm run dev`). Both
// are the SAME static Go binary (daemon/): `katacomb-vpn-helper daemon` behind
// the socket, `katacomb-vpn-helper <verb> …` under pkexec.
//
// Callers keep using the helper's verb+args vocabulary (e.g. `['up', file]`);
// this module maps those to the daemon's JSON ops. For `up` we read the (app's
// own, 0600) config file and send its CONTENT — the daemon writes its own
// root-owned copy, so no user-controlled path ever reaches root. The one-shot
// takes the path instead, opens it O_NOFOLLOW, checks it is a regular file owned
// by the invoking user, and reads it once before validating.

import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { promisify } from 'util'
import { isDaemonAvailable, daemonRequest, DaemonUnreachableError } from './daemon-client'
import { LAN_SHARING_ARG } from './config-guard'

const HELPER_PATH = '/usr/local/bin/katacomb-vpn-helper'

/**
 * ASYNC, and that is load-bearing. This used to be `execFileSync`, which blocks the
 * Electron main process for as long as the call takes — and on this path the call is
 * a polkit password dialog, so "as long as it takes" is however long the user stares
 * at it, up to the 60s timeout. Nothing else in main runs meanwhile: no IPC, no status
 * poll, no window. Measured on a bare `sleep 2`, the event loop turned ZERO times.
 * Live symptom: pressing Disconnect froze the whole app, then reported that the kill
 * switch could not be turned off, leaving no internet and no way to retry.
 *
 * `runPrivileged` already returned a Promise and every caller already awaited it, so
 * the sync call was buying nothing. Keep the parent as the long-lived Electron process
 * (polkit's auth cache is keyed to it) and keep the shell out of it.
 */
const execFileAsync = promisify(execFile)

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
      // stale socket after an OOM/crash, or a socket this session may not open).
      // A live daemon that *rejected* the op (validation failure) must propagate —
      // never silently retry it as root.
      if (!(err instanceof DaemonUnreachableError)) throw err
      // Say WHY. This is a silent downgrade from password-free to a polkit prompt,
      // and the two causes need opposite remedies, so discarding the error (as this
      // did) sends you debugging the wrong one. EACCES means the daemon is healthy
      // and THIS SESSION simply is not in the katacomb-vpn group: membership is
      // fixed at login, so a fresh .deb install prompts until the user logs out and
      // back in — and `postrm` groupdel's the group, so a remove/reinstall cycle
      // re-arms it with the same gid. Anything else means the daemon really is gone.
      // Diagnosed live 2026-09-15 from an unexplained prompt on a working deb.
      console.warn(
        /EACCES/.test(err.message)
          ? `[privileged] daemon socket exists but is not accessible to this session (${err.message}). ` +
            'Falling back to pkexec; log out and back in to pick up the katacomb-vpn group.'
          : `[privileged] daemon unreachable (${err.message}). Falling back to pkexec.`,
      )
      // fall through to the pkexec path below with the same args
    }
  }
  if (!existsSync(HELPER_PATH)) {
    throw new Error('VPN helper not installed. Please restart the app to set it up.')
  }
  // No shell (see vpn-manager history): keep pkexec's parent the long-lived
  // Electron process so polkit's auth cache persists on the fallback path.
  await execFileAsync('pkexec', [HELPER_PATH, ...args], { timeout: 60000 })
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
      // rest = [configPath, binDir] — content is sent like `up`; the bindir slot is
      // ignored on both doors since the AmneziaWG device was compiled into the helper.
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
      // rest = ['-', socksAddr, remoteHost, gateway, iface, bypassCsv?]
      // The first slot used to name the tun2socks binary. The engine is compiled
      // into the helper now and the slot is ignored (kept so old and new apps
      // share one argv contract); the daemon op never carried it.
      const [, socksAddr, remoteHost, gateway, iface, bypassCsv] = rest
      const bypassRoutes = bypassCsv ? bypassCsv.split(',') : []
      await daemonRequest('tun_up', { socksAddr, remoteHost, gateway, iface, bypassRoutes })
      return
    }
    case 'tun-down':
      await daemonRequest('tun_down')
      return
    case 'killswitch-on': {
      // The helper's argv is positional with an optional dns arg, so the LAN flag
      // rides as a trailing sentinel — strip it before destructuring the rest.
      const lanSharing = rest[rest.length - 1] === LAN_SHARING_ARG
      const [iface, remoteHost, dnsIp] = lanSharing ? rest.slice(0, -1) : rest
      await daemonRequest('killswitch_on', { iface, remoteHost, dnsIp, lanSharing })
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
