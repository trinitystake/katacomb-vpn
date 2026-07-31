import { useEffect, useState } from 'react'
import Spinner from './Spinner'

interface Props {
  /** Already user-facing: `insufficientFundsMessage(check)` from the pre-check, or the (marker-stripped) error main threw. */
  message: string
  /** Omitted in the post-failure panel, where the retry re-runs the check anyway. */
  onRefresh?: () => void
  refreshing?: boolean
}

/**
 * The "you can't pay for this" panel: why, where to send funds, and a way to
 * re-read the balance without closing the modal. Shown ahead of the pay button
 * (instead of letting the user click into a guaranteed failure) and again in the
 * error panel when main or the chain rejected the tx for funds.
 */
export default function InsufficientFunds({ message, onRefresh, refreshing }: Props) {
  const [address, setAddress] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    window.api.walletGetAddress().then(setAddress).catch(() => setAddress(null))
  }, [])

  async function copyAddress() {
    if (!address) return
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-warning-subtle border border-warning p-3 rounded-md space-y-2">
      <p className="text-warning text-sm">{message}</p>

      {address && (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-text-secondary text-xs">Send P2P to</span>
            <button
              onClick={copyAddress}
              className="text-text-secondary hover:text-accent transition-colors text-xs"
              title="Copy address"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={copyAddress}
            className="text-text-primary font-mono text-xs break-all mt-0.5 text-left w-full hover:text-accent transition-colors"
            title="Copy address"
          >
            {address}
          </button>
        </div>
      )}

      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="btn btn-secondary w-full disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {refreshing && <Spinner />}
          Refresh balance
        </button>
      )}
    </div>
  )
}
