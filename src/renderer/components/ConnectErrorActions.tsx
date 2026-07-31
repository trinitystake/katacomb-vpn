import { displayConnectError, isDnsProvisionFailure, isInsufficientFunds, isRpcUnreachable } from '../utils/connect-errors'
import InsufficientFunds from './InsufficientFunds'
import { useNavigation } from '../contexts/NavigationContext'

interface Props {
  error: string
  /**
   * The already-paid session, when one exists — i.e. the tx landed and only the
   * tunnel bring-up failed. Set it to null when the payment itself failed, or
   * when the session can't be retried; that falls back to plain "Try Again".
   */
  paidSessionId: string | null
  onRetryTunnel: () => void
  onStartOver: () => void
  /**
   * WireGuard/AmneziaWG only: retry with the tunnel's DNS stripped. Offered when
   * the failure was wg-quick/awg-quick not finding resolvconf.
   */
  onRetryWithoutDns?: () => void
}

/**
 * Error panel shared by the connect flows. When the paying tx already landed,
 * the primary action retries the tunnel against that session — main still holds
 * its config until disconnect. Dropping the user back on the subscribe form
 * (the "Start over" path) would buy a second session.
 */
export default function ConnectErrorActions({
  error,
  paidSessionId,
  onRetryTunnel,
  onStartOver,
  onRetryWithoutDns,
}: Props) {
  const dnsFailure = isDnsProvisionFailure(error)
  const { openSettings } = useNavigation()

  // The chain was never reached, so retrying against the same endpoint mostly
  // repeats the wait. Point at the endpoint list, and keep the plain retry for
  // the case where it was a blip.
  if (isRpcUnreachable(error)) {
    return (
      <div className="space-y-3">
        <div className="bg-danger-subtle border border-danger p-3 rounded-md">
          <p className="text-danger text-sm">{displayConnectError(error)}</p>
        </div>
        <button onClick={() => openSettings('network')} className="btn btn-primary w-full">
          Open network settings
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="text-text-tertiary hover:text-text-secondary text-xs w-full text-center transition-colors"
        >
          Try again
        </button>
      </div>
    )
  }

  // Nothing was charged, so this isn't a tunnel failure to retry — it's a top-up
  // prompt. "Try Again" below returns to the form, which re-checks the balance.
  if (isInsufficientFunds(error)) {
    return (
      <div className="space-y-3">
        <InsufficientFunds message={displayConnectError(error)} />
        <button onClick={onStartOver} className="btn btn-primary w-full">
          Try Again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="bg-danger-subtle border border-danger p-3 rounded-md">
        <p className="text-danger text-sm">{displayConnectError(error)}</p>
      </div>

      {dnsFailure && onRetryWithoutDns && (
        <div className="space-y-2">
          <p className="text-text-tertiary text-xs">
            This system has no <span className="font-mono">resolvconf</span>, so the tunnel's DNS couldn't be
            applied. You can connect anyway using your system DNS — but then DNS queries may leave the tunnel
            and your provider can see which sites you look up.
          </p>
          <button onClick={onRetryWithoutDns} className="btn btn-primary w-full">
            Retry without VPN DNS
          </button>
        </div>
      )}

      {paidSessionId ? (
        <>
          <p className="text-text-tertiary text-xs">
            Session {paidSessionId} is already paid for — retrying the connection won't charge you again.
          </p>
          <button
            onClick={onRetryTunnel}
            className={dnsFailure && onRetryWithoutDns ? 'btn btn-secondary w-full' : 'btn btn-primary w-full'}
          >
            Retry connection
          </button>
          <button
            type="button"
            onClick={onStartOver}
            className="text-text-tertiary hover:text-text-secondary text-xs w-full text-center transition-colors"
          >
            Start over
          </button>
        </>
      ) : (
        <button onClick={onStartOver} className="btn btn-primary w-full">
          Try Again
        </button>
      )}
    </div>
  )
}
