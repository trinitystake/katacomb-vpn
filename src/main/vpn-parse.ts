// Pure parsers/helpers for the VPN layer, extracted from vpn-manager.ts so the
// error-prone external-command-output parsing is unit-testable without Electron.

/** Parse `ip route show default` output into gateway + interface, or null. */
export function parseDefaultRoute(output: string): { gateway: string; iface: string } | null {
  const gwMatch = output.match(/default via (\S+)/)
  const ifMatch = output.match(/dev (\S+)/)
  if (gwMatch && ifMatch) return { gateway: gwMatch[1], iface: ifMatch[1] }
  return null
}

/**
 * v2ray CLI args for a config path. V5 takes a `run` subcommand; V4 (and unknown,
 * i.e. 0) uses the flat `-config` form.
 */
export function v2rayRunArgs(major: number, configFile: string): string[] {
  return major >= 5 ? ['run', '-config', configFile] : ['-config', configFile]
}

/** First IPv4 address in `getent ahostsv4 <host>` output, or null. */
export function firstIPv4FromGetent(output: string): string | null {
  for (const line of output.split('\n')) {
    const ip = line.trim().split(/\s+/)[0]
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip
  }
  return null
}
