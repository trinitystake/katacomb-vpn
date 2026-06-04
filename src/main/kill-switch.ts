import { app } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { runPrivileged } from './privileged'
import { writeFileAtomic } from './fs-utils'

// App-owned marker recording that the kill-switch chain may be installed. Reading
// iptables needs root, so this unprivileged flag is the cheap detector that lets a
// later launch find and clear a chain stranded by a crash/OOM mid-teardown.
function markerPath(): string {
  return join(app.getPath('userData'), 'killswitch-armed.state')
}

export function markKillSwitchArmed(): void {
  try {
    writeFileAtomic(markerPath(), 'armed\n')
  } catch { /* best-effort — marker is only a hint for self-heal */ }
}

export function isKillSwitchArmed(): boolean {
  return existsSync(markerPath())
}

export function clearKillSwitchArmed(): void {
  try {
    unlinkSync(markerPath())
  } catch { /* already gone */ }
}

/** Enable kill switch — blocks all traffic except through the VPN interface and to the VPN server */
export async function enableKillSwitch(vpnInterface: string, remoteHost: string, dnsIp?: string): Promise<void> {
  // Mark BEFORE arming, so even a partial/failed arm (e.g. v4 chain added, v6
  // failed) is still covered by startup self-heal.
  markKillSwitchArmed()
  await runPrivileged([
    'killswitch-on',
    vpnInterface,
    remoteHost,
    ...(dnsIp && dnsIp !== 'system' ? [dnsIp] : []),
  ])
}

/** Disable kill switch — flush rules and restore normal traffic */
export async function disableKillSwitch(): Promise<void> {
  try {
    await runPrivileged(['killswitch-off'])
    // Clear the marker only after a confirmed teardown; if killswitch-off failed
    // (e.g. daemon dead), leave it so the next launch's self-heal retries.
    clearKillSwitchArmed()
  } catch {
    // Best-effort — chain may not exist
  }
}
