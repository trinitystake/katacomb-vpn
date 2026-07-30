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
}

/**
 * Error panel shared by the connect flows. When the paying tx already landed,
 * the primary action retries the tunnel against that session — main still holds
 * its config until disconnect. Dropping the user back on the subscribe form
 * (the "Start over" path) would buy a second session.
 */
export default function ConnectErrorActions({ error, paidSessionId, onRetryTunnel, onStartOver }: Props) {
  return (
    <div className="space-y-3">
      <div className="bg-danger-subtle border border-danger p-3 rounded-md">
        <p className="text-danger text-sm">{error}</p>
      </div>
      {paidSessionId ? (
        <>
          <p className="text-text-tertiary text-xs">
            Session {paidSessionId} is already paid for — retrying the connection won't charge you again.
          </p>
          <button onClick={onRetryTunnel} className="btn btn-primary w-full">
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
