import { useState } from 'react'
import { useConnection } from '../hooks/useConnection'
import Spinner from './Spinner'

export default function DisconnectButton() {
  const { status, disconnect } = useConnection()
  const [disconnecting, setDisconnecting] = useState(false)

  if (status.state !== 'connected' && status.state !== 'reconnecting') return null

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await disconnect()
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <button
      onClick={handleDisconnect}
      disabled={disconnecting}
      title="Disconnect"
      aria-label="Disconnect"
      className="text-danger transition-opacity opacity-70 hover:opacity-100 disabled:opacity-40 flex items-center"
    >
      {disconnecting ? (
        <Spinner className="text-danger" />
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M8 1.6v6" />
          <path d="M4.7 4a4.5 4.5 0 1 0 6.6 0" />
        </svg>
      )}
    </button>
  )
}
