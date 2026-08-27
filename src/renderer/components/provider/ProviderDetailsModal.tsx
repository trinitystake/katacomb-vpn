import { useState } from 'react'
import type { MyProvider, ProviderDetailsInput } from '../../types'
import { providerDetailsProblem } from '../../../shared/provider-details'
import { displayConnectError } from '../../utils/connect-errors'
import Spinner from '../Spinner'
import ProviderDetailsFields from './ProviderDetailsFields'

/**
 * Edit the provider record on chain.
 *
 * Pre-filled from the current record, and that is not a nicety: the hub's
 * MsgUpdateProviderDetails handler keeps the stored name when the message carries
 * an empty one but overwrites identity, website and description UNCONDITIONALLY.
 * A blank-by-default form would therefore wipe three fields on every save, which
 * is why this one starts from what the chain already holds and sends all four
 * back.
 */
export default function ProviderDetailsModal({ provider, onClose, onSaved }: {
  provider: MyProvider
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [details, setDetails] = useState<ProviderDetailsInput>({
    name: provider.name,
    identity: provider.identity,
    website: provider.website,
    description: provider.description,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The name is optional to the chain here, but blanking it in a form that was
  // pre-filled means "I cleared this", and the chain would silently keep the old
  // one. Requiring it makes the field mean what it looks like it means.
  const problem = providerDetailsProblem(details, { requireName: true })
  const unchanged =
    details.name === provider.name &&
    details.identity === provider.identity &&
    details.website === provider.website &&
    details.description === provider.description

  async function handleSave() {
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.api.providerUpdateDetails({ ...details, name: details.name.trim() })
      // Awaited before closing, so the card behind is already showing the new
      // details rather than the old ones for the length of a chain round-trip.
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update your provider details')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={busy ? undefined : onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-6 space-y-4 rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-text-primary text-base font-semibold">Edit provider details</h2>
          {!busy && (
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
              ×
            </button>
          )}
        </div>

        <p className="text-text-tertiary text-xs">
          All four fields are written to the chain together, so whatever is shown here is what
          subscribers will see. Clearing one clears it on chain.
        </p>

        <ProviderDetailsFields details={details} onChange={setDetails} disabled={busy} />

        {(error || problem) && (
          <div className="bg-danger-subtle border border-danger rounded-sm px-3 py-2">
            <p className="text-danger text-xs">{error ? displayConnectError(error) : problem}</p>
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary text-xs py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || Boolean(problem) || unchanged}
            className="btn btn-primary text-xs py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
            title={unchanged ? 'Nothing has changed yet' : undefined}
          >
            {busy && <Spinner size="sm" />}
            {busy ? 'Saving…' : 'Save to chain'}
          </button>
        </div>

        <p className="text-text-tertiary text-[11px]">
          This is an on-chain transaction, and costs the network fee only.
        </p>
      </div>
    </div>
  )
}
