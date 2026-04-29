import { useState } from 'react'
import { useConnection } from '../hooks/useConnection'
import Spinner from './Spinner'

interface Props {
  compact?: boolean
}

export default function ConnectionStatus({ compact }: Props) {
  const { status, disconnect } = useConnection()
  const connected = status.state === 'connected'
  const [disconnecting, setDisconnecting] = useState(false)

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await disconnect()
    } finally {
      setDisconnecting(false)
    }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className={`status-dot ${connected ? 'status-dot-active' : 'status-dot-inactive'}`} />
        <span className={connected ? 'text-success' : 'text-text-secondary'}>
          {connected ? `${status.nodeMoniker || 'Connected'}` : 'Disconnected'}
        </span>
      </div>
    )
  }

  if (!connected) {
    return (
      <div className="p-6 flex items-center justify-center">
        <p className="text-text-secondary text-sm">Not connected</p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <span className="status-dot status-dot-active" />
        <span className="text-success text-sm font-medium">VPN Active</span>
      </div>

      <div className="space-y-2 text-sm">
        {status.nodeMoniker && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Node</span>
            <span className="text-text-primary">{status.nodeMoniker}</span>
          </div>
        )}
        {status.nodeCountry && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Country</span>
            <span className="text-text-primary">{status.nodeCountry}</span>
          </div>
        )}
        {status.nodeType && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Type</span>
            <span className={status.nodeType === 1 ? 'text-info' : 'text-warning'}>
              {status.nodeType === 1 ? 'WireGuard' : 'V2Ray'}
            </span>
          </div>
        )}
        {status.sessionId && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Session</span>
            <span className="text-text-primary font-mono">{status.sessionId}</span>
          </div>
        )}
      </div>

      <button onClick={handleDisconnect} disabled={disconnecting} className="btn btn-danger w-full text-xs flex items-center justify-center gap-2 disabled:opacity-50">
        {disconnecting ? <><Spinner className="text-white" /> Disconnecting...</> : 'Disconnect'}
      </button>
    </div>
  )
}
