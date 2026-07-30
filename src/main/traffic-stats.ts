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

/**
 * Return the larger of two byte-count strings (non-numeric/empty → 0). Used to
 * merge a session's on-chain counter with the usage we measured live during the
 * last connect: after disconnect the chain lags, so we keep showing whichever is
 * bigger. Once the chain settles (>= the remembered value) it wins automatically,
 * so there's no double-counting.
 */
export function maxUsageBytes(a: string, b: string): string {
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  const va = isNaN(na) ? 0 : na
  const vb = isNaN(nb) ? 0 : nb
  return String(Math.max(va, vb))
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
  // WireGuard/AmneziaWG, sntl-tun for the tun2socks protocols, sntl-ovpn for
  // OpenVPN. (`wg show transfer` would need root, since the wg device is owned by
  // the root-created interface, so /proc/net/dev — which is world-readable — is the
  // right source for every protocol.)
  const stats = readProcNetDev('sntl0') || readProcNetDev('sntl-tun') || readProcNetDev('sntl-ovpn')

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
