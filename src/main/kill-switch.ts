import { execSync } from 'child_process'
import { existsSync } from 'fs'

const HELPER_PATH = '/usr/local/bin/sentinel-vpn-helper'

function runPrivileged(args: string[]): void {
  if (!existsSync(HELPER_PATH)) {
    throw new Error('VPN helper not installed. Please restart the app to set it up.')
  }
  const escaped = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  execSync(`pkexec ${HELPER_PATH} ${escaped}`, { stdio: 'pipe', timeout: 60000 })
}

/** Enable kill switch — blocks all traffic except through the VPN interface and to the VPN server */
export function enableKillSwitch(vpnInterface: string, remoteHost: string, dnsIp?: string): void {
  runPrivileged([
    'killswitch-on',
    vpnInterface,
    remoteHost,
    ...(dnsIp && dnsIp !== 'system' ? [dnsIp] : []),
  ])
}

/** Disable kill switch — flush rules and restore normal traffic */
export function disableKillSwitch(): void {
  try {
    runPrivileged(['killswitch-off'])
  } catch {
    // Best-effort — chain may not exist
  }
}
