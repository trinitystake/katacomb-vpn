import { isChainUnreachable } from '../../shared/rpc-health'
import { useRpcHealth } from '../hooks/useRpcHealth'
import { useNavigation } from '../contexts/NavigationContext'

/**
 * One line for the places where main degrades an RPC failure into an empty list.
 * Without it "you have no subscriptions" and "we couldn't ask the chain" look
 * identical. Renders nothing while the endpoint is healthy, or while our own
 * tunnel is up (where empty is expected).
 */
export default function ChainUnreachable({ what }: { what: string }) {
  const { state } = useRpcHealth()
  const { openSettings } = useNavigation()
  if (!isChainUnreachable(state)) return null

  return (
    <p className="text-warning text-xs">
      Couldn't reach the blockchain, so {what} may be incomplete.{' '}
      <button onClick={() => openSettings('network')} className="underline hover:text-accent transition-colors">
        Check the RPC endpoint
      </button>
    </p>
  )
}
