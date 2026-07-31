import { useState } from 'react'
import type { WalletStoreStatus } from '../types'
import Spinner from './Spinner'

interface Props {
  status: WalletStoreStatus
  /** Re-read the store and the active wallet after a switch or a delete. */
  onChanged: () => Promise<void>
  /** Go to the import/create screen without discarding what's stored. */
  onAddAnother: () => void
}

/**
 * Shown when seeds are stored but none is active — after Lock, or when the
 * active one couldn't be restored. Before this existed, that state rendered the
 * import screen, so the only visible way back in was to retype a seed the app
 * already had: the path that produced duplicate entries for one address.
 */
export default function WalletPicker({ status, onChanged, onAddAnother }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function use(walletId: string) {
    setBusyId(walletId)
    setError('')
    try {
      const { address } = await window.api.walletSwitch(walletId)
      if (!address) {
        setError('That wallet could not be unlocked. Import its seed phrase again.')
        return
      }
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open that wallet')
    } finally {
      setBusyId(null)
    }
  }

  async function deleteAll() {
    const count = status.wallets.length
    const confirmed = confirm(
      `Delete ${count} stored wallet${count === 1 ? '' : 's'} and start fresh?\n\n` +
      status.wallets.map((w) => `• ${w.name} — ${w.address || 'address unknown'}`).join('\n') +
      `\n\nThis removes the encrypted seeds from this device. Without your written-down ` +
      `recovery phrase they cannot be restored. Funds stay on-chain, reachable only by ` +
      `re-importing the phrase.\n\nApp settings are kept.`,
    )
    if (!confirmed) return

    setBusyId('all')
    setError('')
    try {
      await window.api.walletDeleteAll()
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete wallets')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-8">
        <div className="space-y-3">
          <h1 className="text-accent font-semibold text-2xl">Welcome back</h1>
          <p className="text-text-secondary text-sm leading-relaxed">
            {status.wallets.length === 1
              ? 'A wallet is already stored on this device.'
              : `${status.wallets.length} wallets are already stored on this device.`}{' '}
            Choose one to continue, or add another.
          </p>
        </div>

        {error && (
          <div className="bg-danger-subtle border border-danger p-3 rounded-md">
            <p className="text-danger text-sm">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          {status.wallets.map((w) => (
            <div
              key={w.id}
              className={`border rounded-md px-4 py-3 flex items-center gap-3 ${
                w.unlockable ? 'border-border bg-bg-tertiary' : 'border-warning bg-warning-subtle'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-text-primary text-sm font-medium">{w.name}</div>
                <div className="text-text-secondary font-mono text-xs truncate mt-0.5">
                  {w.address || 'address not yet derived'}
                </div>
                {!w.unlockable && (
                  <p className="text-warning text-xs mt-1.5">
                    Saved under the app's previous name, so its seed can no longer be unlocked.
                    Import the same recovery phrase again — your funds are on-chain and unaffected.
                  </p>
                )}
              </div>
              {w.unlockable && (
                <button
                  onClick={() => use(w.id)}
                  disabled={busyId !== null}
                  className="btn btn-primary text-sm px-4 shrink-0 disabled:opacity-50 flex items-center gap-2"
                >
                  {busyId === w.id && <Spinner />}
                  Use
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <button onClick={onAddAnother} disabled={busyId !== null} className="btn btn-secondary w-full disabled:opacity-50">
            Add another wallet
          </button>
          <button
            onClick={deleteAll}
            disabled={busyId !== null}
            className="text-text-tertiary hover:text-danger text-xs w-full text-center transition-colors disabled:opacity-50"
          >
            Delete all wallets and start fresh
          </button>
        </div>
      </div>
    </div>
  )
}
