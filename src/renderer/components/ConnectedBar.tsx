import { useConnection } from '../hooks/useConnection'
import { protocolMeta } from '../utils/protocols'

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
          {status.nodeType !== undefined && (
            <span className={`px-1.5 py-0.5 border text-xs rounded-sm ${
              status.nodeType === 1
                ? 'border-info text-info'
                : 'border-warning text-warning'
            }`}>
              {status.nodeType === 2 ? (status.v2raySummary || protocolMeta(2).short) : protocolMeta(status.nodeType).short}
            </span>
          )}
          {status.killSwitchFailed && (
            <span
              className="px-1.5 py-0.5 border border-danger text-danger text-xs rounded-sm"
              title="The kill switch could not be enabled, so your real IP is NOT protected if the tunnel drops. Try reconnecting; if it persists, check that the VPN helper/daemon is installed."
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
          {/* On a chain, nodeMoniker above is the ENTRY — the node this device
              dials. What the internet sees is the exit, so name it: otherwise the
              bar says Spain while every site reports Turkey. */}
          {status.chainExit && (
            <span
              className="text-accent"
              title={`Two-hop chain. Your device dials ${status.nodeMoniker || 'the entry node'}; traffic leaves from ${status.chainExit.moniker || status.chainExit.address} in ${status.chainExit.country}.`}
            >
              → {status.chainExit.moniker || status.chainExit.country}
              {status.chainExit.sessionId && (
                <span className="text-text-secondary font-mono ml-1.5">#{status.chainExit.sessionId}</span>
              )}
            </span>
          )}
        </>
      )}
    </div>
  )
}
