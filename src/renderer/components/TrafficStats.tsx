import { useTrafficStats } from '../hooks/useTrafficStats'

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} B`
}

function formatSpeed(bytesPerSec: number): string {
  const bitsPerSec = bytesPerSec * 8
  if (bitsPerSec >= 1e9) return `${(bitsPerSec / 1e9).toFixed(1)} Gb/s`
  if (bitsPerSec >= 1e6) return `${(bitsPerSec / 1e6).toFixed(1)} Mb/s`
  if (bitsPerSec >= 1e3) return `${(bitsPerSec / 1e3).toFixed(0)} Kb/s`
  return `${bitsPerSec.toFixed(0)} b/s`
}

interface Props {
  connected: boolean
}

export default function TrafficStats({ connected }: Props) {
  const stats = useTrafficStats(connected)

  if (!connected) return null

  return (
    <div className="flex items-center gap-3 text-xs font-mono">
      <span className="text-info" title="Download">
        {'↓'} {formatBytes(stats.rxBytes)} ({formatSpeed(stats.rxSpeed)})
      </span>
      <span className="text-warning" title="Upload">
        {'↑'} {formatBytes(stats.txBytes)} ({formatSpeed(stats.txSpeed)})
      </span>
    </div>
  )
}
