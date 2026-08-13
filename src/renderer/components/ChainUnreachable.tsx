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

  // Both states mean the query failed, but only one of them is the endpoint's
  // doing — pointing at the RPC settings when our own kill switch is dropping
  // the traffic sends the user to fix something that isn't broken.
  if (state === 'blocked') {
    return (
      <p className="text-warning text-xs">
        The kill switch is blocking all traffic, so {what} couldn't be loaded. Restore internet to see it.
      </p>
    )
  }

  return (
    <p className="text-warning text-xs">
      Couldn't reach the blockchain, so {what} may be incomplete.{' '}
      <button onClick={() => openSettings('network')} className="underline hover:text-accent transition-colors">
        Check the RPC endpoint
      </button>
    </p>
  )
}
