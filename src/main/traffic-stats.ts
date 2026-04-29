import { execSync } from 'child_process'
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

/** Parse /proc/net/dev for a given interface, returning rx and tx bytes */
function readProcNetDev(iface: string): { rx: number; tx: number } | null {
  try {
    const content = readFileSync('/proc/net/dev', 'utf-8')
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
  } catch { /* ignore */ }
  return null
}

/** Get WireGuard transfer stats via `wg show sntl0 transfer` */
function readWireGuardStats(): { rx: number; tx: number } | null {
  try {
    const output = execSync('wg show sntl0 transfer', { stdio: 'pipe', timeout: 5000 }).toString().trim()
    if (!output) return null
    // Output format: <peer-pubkey>\t<rx>\t<tx>
    let totalRx = 0
    let totalTx = 0
    for (const line of output.split('\n')) {
      const parts = line.split('\t')
      if (parts.length >= 3) {
        totalRx += parseInt(parts[1], 10) || 0
        totalTx += parseInt(parts[2], 10) || 0
      }
    }
    return { rx: totalRx, tx: totalTx }
  } catch { /* ignore */ }
  return null
}

/** Get current traffic stats from the active VPN interface */
export function getTrafficStats(): TrafficStats {
  const now = Date.now()

  // Try WireGuard first, then TUN interface
  const stats = readWireGuardStats() || readProcNetDev('sntl-tun')

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
