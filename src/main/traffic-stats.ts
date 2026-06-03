import { readFileSync } from 'fs'

interface TrafficStats {
  rxBytes: number
  txBytes: number
  rxSpeed: number
  txSpeed: number
}

let prevRx = 0
let prevTx = 0
let prevTimestamp = 0

/**
 * Reset the speed baseline. Called on each (re)connect so the first sample of a
 * new session/interface doesn't diff against the previous session's counters
 * (which produced a bogus 0-speed reading for one interval — finding M10).
 */
export function resetTrafficStats(): void {
  prevRx = 0
  prevTx = 0
  prevTimestamp = 0
}

/** Parse one interface's rx/tx bytes out of /proc/net/dev content (rx=field 1, tx=field 9). */
export function parseProcNetDev(content: string, iface: string): { rx: number; tx: number } | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(`${iface}:`)) {
      const parts = trimmed.split(/\s+/)
      // Format: iface: rx_bytes rx_packets ... tx_bytes tx_packets ...
      const rx = parseInt(parts[1], 10)
      const tx = parseInt(parts[9], 10)
      if (!isNaN(rx) && !isNaN(tx)) return { rx, tx }
    }
  }
  return null
}

/** Read an interface's rx/tx bytes from the world-readable /proc/net/dev. */
function readProcNetDev(iface: string): { rx: number; tx: number } | null {
  try {
    return parseProcNetDev(readFileSync('/proc/net/dev', 'utf-8'), iface)
  } catch {
    return null
  }
}

/** Get current traffic stats from the active VPN interface */
export function getTrafficStats(): TrafficStats {
  const now = Date.now()

  // Read the active interface's byte counters from /proc/net/dev: sntl0 for
  // WireGuard, sntl-tun for V2Ray. (`wg show transfer` would need root, since the
  // wg device is owned by the root-created interface, so /proc/net/dev — which is
  // world-readable — is the right source for both protocols.)
  const stats = readProcNetDev('sntl0') || readProcNetDev('sntl-tun')

  if (!stats) {
    return { rxBytes: 0, txBytes: 0, rxSpeed: 0, txSpeed: 0 }
  }

  let rxSpeed = 0
  let txSpeed = 0

  if (prevTimestamp > 0 && now > prevTimestamp) {
    const elapsed = (now - prevTimestamp) / 1000 // seconds
    if (elapsed > 0 && elapsed < 10) { // ignore stale samples
      rxSpeed = Math.max(0, (stats.rx - prevRx) / elapsed)
      txSpeed = Math.max(0, (stats.tx - prevTx) / elapsed)
    }
  }

  prevRx = stats.rx
  prevTx = stats.tx
  prevTimestamp = now

  return {
    rxBytes: stats.rx,
    txBytes: stats.tx,
    rxSpeed,
    txSpeed,
  }
}
