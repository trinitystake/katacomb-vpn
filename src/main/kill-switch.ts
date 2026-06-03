import { runPrivileged } from './privileged'

/** Enable kill switch — blocks all traffic except through the VPN interface and to the VPN server */
export async function enableKillSwitch(vpnInterface: string, remoteHost: string, dnsIp?: string): Promise<void> {
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
  } catch {
    // Best-effort — chain may not exist
  }
}
