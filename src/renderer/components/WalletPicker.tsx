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
  // Retained-seed state only: the name for the wallet about to be derived, and a
  // two-step confirm so the seed can't be dropped on a single stray click.
  const [seedWalletName, setSeedWalletName] = useState('')
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  async function deriveFromRetainedSeed() {
    if (!status.retainedSeedId) return
    setBusyId('derive')
    setError('')
    try {
      // Nothing is stored while a seed is retained, so account 0 / address 0 is
      // always free — no need to hunt for the first unused path.
      await window.api.walletDeriveSubaccount({
        sourceWalletId: status.retainedSeedId,
        accountIndex: 0,
        addressIndex: 0,
        name: seedWalletName.trim() || 'Wallet 1',
      })
      const [entry] = await window.api.walletList()
      if (entry) await window.api.walletSwitch(entry.id)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to derive a wallet')
    } finally {
      setBusyId(null)
    }
  }

  async function removeSavedSeed() {
    setBusyId('remove')
    setError('')
    try {
      await window.api.walletDeleteAll()
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove the seed')
    } finally {
      setBusyId(null)
    }
  }

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

  // A seed that outlived its wallets. Without this screen the app would fall
  // through to the import form and the saved seed would be unreachable.
  if (status.wallets.length === 0 && status.retainedSeedId) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="w-full max-w-xl space-y-8">
          <div className="space-y-3">
            <h1 className="text-accent font-semibold text-2xl">Your seed is saved</h1>
            <p className="text-text-secondary text-sm leading-relaxed">
              No wallets derived from the seed. Derive one to carry on. You won't need to
              retype your recovery phrase.
            </p>
          </div>

          {error && (
            <div className="bg-danger-subtle border border-danger p-3 rounded-md">
              <p className="text-danger text-sm">{error}</p>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
              Wallet name
            </label>
            <input
              type="text"
              value={seedWalletName}
              onChange={(e) => setSeedWalletName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && busyId === null && deriveFromRetainedSeed()}
              placeholder="e.g. Wallet 1"
              maxLength={100}
              autoFocus
              className="w-full bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-2 rounded-sm focus:outline-none focus:border-border-focus"
            />
            <button
              onClick={deriveFromRetainedSeed}
              disabled={busyId !== null}
              className="btn btn-primary w-full disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busyId === 'derive' && <Spinner />}
              Derive a wallet
            </button>
          </div>

          {confirmingRemove ? (
            <div className="border border-danger bg-danger-subtle rounded-md p-3 space-y-3">
              <p className="text-danger text-xs font-medium">
                Remove the saved seed from this device?
              </p>
              <p className="text-text-secondary text-xs">
                Without your written-down recovery phrase it cannot be restored. Funds stay
                on-chain, reachable only by importing the phrase again.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingRemove(false)}
                  disabled={busyId !== null}
                  className="text-text-secondary hover:text-text-primary text-xs px-3 py-1.5 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={removeSavedSeed}
                  disabled={busyId !== null}
                  className="btn btn-danger text-xs px-3 py-1.5 disabled:opacity-50 flex items-center gap-2"
                >
                  {busyId === 'remove' && <Spinner />}
                  Remove seed
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingRemove(true)}
              disabled={busyId !== null}
              className="text-text-tertiary hover:text-danger text-xs w-full text-center transition-colors disabled:opacity-50"
            >
              Remove saved seed and start fresh
            </button>
          )}
        </div>
      </div>
    )
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
                    Import the same recovery phrase again. Your funds are on-chain and unaffected.
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
          {confirmingRemove ? (
            <div className="border border-danger bg-danger-subtle rounded-md p-3 space-y-3">
              <p className="text-danger text-xs font-medium">
                Delete {status.wallets.length} stored wallet
                {status.wallets.length === 1 ? '' : 's'} and start fresh?
              </p>
              <ul className="text-text-secondary text-xs space-y-1 list-disc pl-4">
                {status.wallets.map((w) => (
                  <li key={w.id}>
                    <span className="text-text-primary">{w.name}</span> · {w.address || 'address unknown'}
                  </li>
                ))}
              </ul>
              <p className="text-text-secondary text-xs">
                This removes the encrypted seeds from this device. Without your written-down
                recovery phrase they cannot be restored. Funds stay on-chain, reachable only by
                re-importing the phrase. App settings are kept.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingRemove(false)}
                  disabled={busyId !== null}
                  className="text-text-secondary hover:text-text-primary text-xs px-3 py-1.5 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={deleteAll}
                  disabled={busyId !== null}
                  className="btn btn-danger text-xs px-3 py-1.5 disabled:opacity-50 flex items-center gap-2"
                >
                  {busyId === 'all' && <Spinner />}
                  Delete all wallets
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingRemove(true)}
              disabled={busyId !== null}
              className="text-text-tertiary hover:text-danger text-xs w-full text-center transition-colors disabled:opacity-50"
            >
              Delete all wallets and start fresh
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
