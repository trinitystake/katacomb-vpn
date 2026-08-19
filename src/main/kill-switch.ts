import { app } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { runPrivileged } from './privileged'
import { writeFileAtomic } from './fs-utils'
import { LAN_SHARING_ARG } from './config-guard'

// App-owned marker recording that the kill-switch chain may be installed. Reading
// iptables needs root, so this unprivileged flag is the cheap detector that lets a
// later launch find and clear a chain stranded by a crash/OOM mid-teardown.
function markerPath(): string {
  return join(app.getPath('userData'), 'killswitch-armed.state')
}

function markKillSwitchArmed(): void {
  try {
    writeFileAtomic(markerPath(), 'armed\n')
  } catch { /* best-effort — marker is only a hint for self-heal */ }
}

export function isKillSwitchArmed(): boolean {
  return existsSync(markerPath())
}

function clearKillSwitchArmed(): void {
  try {
    unlinkSync(markerPath())
  } catch { /* already gone */ }
}

/** Enable kill switch — blocks all traffic except through the VPN interface and to the VPN server */
export async function enableKillSwitch(
  vpnInterface: string,
  remoteHost: string,
  opts: { dnsIp?: string; lanSharing?: boolean } = {},
): Promise<void> {
  // Mark BEFORE arming, so even a partial/failed arm (e.g. v4 chain added, v6
  // failed) is still covered by startup self-heal.
  markKillSwitchArmed()
  await runPrivileged([
    'killswitch-on',
    vpnInterface,
    remoteHost,
    ...(opts.dnsIp && opts.dnsIp !== 'system' ? [opts.dnsIp] : []),
    // Trailing — the helper reads it as the last argument.
    ...(opts.lanSharing ? [LAN_SHARING_ARG] : []),
  ])
}

/** Disable kill switch — flush rules and restore normal traffic */
export async function disableKillSwitch(): Promise<boolean> {
  try {
    await runPrivileged(['killswitch-off'])
    // Clear the marker only after a confirmed teardown; if killswitch-off failed
    // (e.g. daemon dead), leave it so the next launch's self-heal retries.
    clearKillSwitchArmed()
    return true
  } catch {
    // Chain may still be installed (e.g. daemon dead) — report so the caller can
    // warn the user their traffic may be blocked until the next-launch self-heal.
    return false
  }
}
