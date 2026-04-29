import { useState } from 'react'
import { useConnection } from '../hooks/useConnection'
import { useNodeTest } from '../hooks/useNodeTest'
import TrafficStats from './TrafficStats'
import Spinner from './Spinner'

export default function ConnectedBar() {
  const { status, disconnect } = useConnection()
  const { speedResult, speedTesting, testSpeed } = useNodeTest()
  const [disconnecting, setDisconnecting] = useState(false)
  const connected = status.state === 'connected'
  const reconnecting = status.state === 'reconnecting'

  if (!connected && !reconnecting) return null

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await disconnect()
    } finally {
      setDisconnecting(false)
    }
  }

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
              {status.nodeType === 1 ? 'WG' : 'V2Ray'}
            </span>
          )}
          {status.nodeMoniker && (
            <span className="text-text-primary">{status.nodeMoniker}</span>
          )}
          {status.sessionId && (
            <span className="text-text-secondary font-mono">#{status.sessionId}</span>
          )}
          <TrafficStats connected />

          {speedTesting ? (
            <span className="text-text-tertiary flex items-center gap-1">
              <Spinner className="text-accent" /> Testing...
            </span>
          ) : speedResult ? (
            <span className="text-text-secondary font-mono">
              {speedResult.downloadMbps > 0 && (
                <span className="text-success">{speedResult.downloadMbps} Mbps</span>
              )}
              {speedResult.googleLatencyMs !== null && (
                <span className={speedResult.googleReachable ? 'text-success' : 'text-danger'}>
                  {speedResult.downloadMbps > 0 ? ' · ' : ''}Google: {speedResult.googleLatencyMs}ms
                </span>
              )}
              {speedResult.error && !speedResult.downloadMbps && (
                <span className="text-danger">Failed</span>
              )}
            </span>
          ) : null}

          <button
            onClick={testSpeed}
            disabled={speedTesting}
            className="text-text-secondary hover:text-accent text-xs transition-colors disabled:opacity-30"
          >
            {speedResult ? 'Retest' : 'Speed Test'}
          </button>
        </>
      )}

      <button
        onClick={handleDisconnect}
        disabled={disconnecting}
        className="text-danger hover:text-danger transition-colors text-xs flex items-center gap-1 ml-1 opacity-70 hover:opacity-100"
      >
        {disconnecting ? <><Spinner className="text-danger" /> Disconnecting...</> : 'Disconnect'}
      </button>
    </div>
  )
}
