import { degradedReason, rpcHealthLabel, rpcHostLabel } from '../../shared/rpc-health'
import { useRpcHealth } from '../hooks/useRpcHealth'
import { useNavigation } from '../contexts/NavigationContext'

/** Shared with the Settings endpoint list, so one state never renders two colours. */
export const STATE_DOT: Record<string, string> = {
  ok: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-danger',
  suspended: 'bg-text-tertiary',
  unknown: 'bg-text-tertiary',
}

/**
 * Health of the blockchain endpoint, in the status bar. Everything the app knows
 * about balances, sessions and plans comes through it, so when it's unhealthy
 * that has to be visible rather than showing up as data that's quietly stale.
 * Click to go straight to the endpoint list.
 */
export default function RpcStatus() {
  const health = useRpcHealth()
  const { openSettings } = useNavigation()

  const host = health.endpoint ? rpcHostLabel(health.endpoint) : 'not configured'
  const tooltip = [
    `RPC: ${host}`,
    health.state === 'suspended'
      ? 'Paused while the VPN is connected — the chain is not reachable through the tunnel.'
      : null,
    health.chainId ? `Chain: ${health.chainId}` : null,
    health.height !== null ? `Height: ${health.height.toLocaleString('en')}` : null,
    health.blockAgeSec !== null ? `Last block: ${health.blockAgeSec}s ago` : null,
    health.error,
    degradedReason(health) === 'lagging' ? 'This endpoint is behind the chain.' : null,
    'Click to change endpoint',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      onClick={() => openSettings('network')}
      title={tooltip}
      className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[health.state]}`} aria-hidden />
      <span className="font-mono">{rpcHealthLabel(health)}</span>
    </button>
  )
}
