import { useConnection } from '../hooks/useConnection'

export default function ConnectedBar() {
  const { status } = useConnection()
  const connected = status.state === 'connected'
  const reconnecting = status.state === 'reconnecting'

  if (!connected && !reconnecting) return null

  return (
    <div className="flex items-center gap-3 text-xs">
      {reconnecting ? (
        <>
          <span className="status-dot status-dot-pending" />
          <span className="text-warning">
            Reconnecting ({status.reconnectAttempt}/{status.reconnectMaxAttempts})...
          </span>
        </>
      ) : (
        <>
          <span className="status-dot status-dot-active" />
          {status.nodeType && (
            <span className={`px-1.5 py-0.5 border text-xs rounded-sm ${
              status.nodeType === 1
                ? 'border-info text-info'
                : 'border-warning text-warning'
            }`}>
              {status.nodeType === 1 ? 'WG' : (status.v2raySummary || 'V2Ray')}
            </span>
          )}
          {status.killSwitchFailed && (
            <span
              className="px-1.5 py-0.5 border border-danger text-danger text-xs rounded-sm"
              title="The kill switch could not be enabled — your real IP is NOT protected if the tunnel drops. Try reconnecting; if it persists, check that the VPN helper/daemon is installed."
            >
              ⚠ Kill switch inactive
            </span>
          )}
          {status.nodeMoniker && (
            <span className="text-text-primary">{status.nodeMoniker}</span>
          )}
          {status.sessionId && (
            <span className="text-text-secondary font-mono">#{status.sessionId}</span>
          )}
        </>
      )}
    </div>
  )
}
