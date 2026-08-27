import { useCallback, useState } from 'react'
import type { LeaseSummary, MyPlan, MyProvider } from '../../types'
import { displayConnectError } from '../../utils/connect-errors'
import { STATUS_ACTIVE, formatSince } from '../../utils/provider-format'
import { useConfirm } from '../ConfirmModal'
import Spinner from '../Spinner'
import ProviderDetailsModal from './ProviderDetailsModal'

/**
 * The provider record as the chain holds it, plus the two actions that change it,
 * plus the tab's one refresh affordance.
 *
 * Shows all four metadata fields rather than just the name: they are what
 * subscribers see next to the plans, they were previously unreachable once
 * registered, and a provider with no way to read back what it published cannot
 * tell a typo from a rendering choice.
 *
 * The refresh cluster exists because nothing on this tab polls: chain-side
 * changes (a lease renewing, a subscription sold) are invisible until an action
 * re-reads, so the data age is shown and a manual re-read offered.
 */
export default function ProviderIdentityCard({ provider, plans, leases, stale, fetchedAt, onRefresh, onChanged }: {
  provider: MyProvider
  plans: MyPlan[]
  leases: LeaseSummary[]
  /** Read-only mode: the data is cached and the chain unreachable, so actions are disabled. */
  stale: boolean
  /** When the data was read from the chain (ms), or null before the first read. */
  fetchedAt: number | null
  onRefresh: () => Promise<void>
  /** Resolves once the chain has been re-read, so the button can stay busy until then. */
  onChanged: () => Promise<void>
}) {
  const active = provider.status === STATUS_ACTIVE
  // The status being APPLIED, or null when idle.
  //
  // Not a plain boolean, because `active` is live chain data that changes UNDER
  // this button: `onChanged()` calls setData while it runs, and `setBusy(false)`
  // only lands a microtask later, so there is a render with the new status and
  // the spinner still going. Reading the label off `active` there made a freshly
  // activated provider say "Deactivating…" mid-spin. While an action is in
  // flight the button describes the ACTION, and holds its pre-action styling,
  // so the whole thing settles in exactly one visible step.
  const [pendingTarget, setPendingTarget] = useState<boolean | null>(null)
  const busy = pendingTarget !== null
  // Pre-action status is the opposite of what we are moving to.
  const showActive = pendingTarget === null ? active : !pendingTarget
  const [editing, setEditing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  const setStatus = useCallback(async (next: boolean) => {
    if (!(await requestConfirm(next ? activateQuestion() : deactivateQuestion(plans, leases)))) return
    setPendingTarget(next)
    setError(null)
    try {
      await window.api.providerSetStatus(next)
      // Awaited: clearing busy when the TX returns would re-render the PRE-tx
      // status for as long as the chain re-read takes, so the label bounces back
      // to "Activate" for a beat before settling on "Deactivate".
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status change failed')
    } finally {
      setPendingTarget(null)
    }
  }, [leases, onChanged, plans, requestConfirm])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      await onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [onRefresh])

  const since = formatSince(provider.statusAt)
  const age = fetchedAt !== null ? formatSince(new Date(fetchedAt).toISOString()) : null
  const dataOld = stale || (fetchedAt !== null && Date.now() - fetchedAt > 10 * 60 * 1000)

  return (
    <div className="border-b border-border bg-bg-secondary px-5 py-3 shrink-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className={`status-dot ${active ? 'status-dot-active' : 'status-dot-inactive'}`} />
            <span className="text-text-primary text-base font-semibold truncate">
              {provider.name || 'Unnamed provider'}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none ${
              active ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
            }`}>
              {active ? 'Active' : 'Inactive'}
            </span>
            {since && <span className="text-text-tertiary text-[11px]">since {since}</span>}
          </div>
          <div className="text-text-tertiary font-mono text-[11px] mt-0.5 truncate">{provider.address}</div>

          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-1.5 text-[11px]">
            {provider.website && (
              <a
                href={provider.website}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline truncate max-w-xs"
              >
                {provider.website}
              </a>
            )}
            {provider.identity && (
              <span className="text-text-tertiary">
                identity <span className="text-text-secondary font-mono">{provider.identity}</span>
              </span>
            )}
          </div>
          {provider.description && (
            <p className="text-text-secondary text-xs mt-1.5 line-clamp-2">{provider.description}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {age && (
            <span className="flex items-center gap-1.5 text-text-tertiary text-[11px]" title="When this tab last read the chain">
              <span className={`status-dot ${dataOld ? 'status-dot-pending' : 'status-dot-active'}`} />
              Updated {age}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={busy || refreshing || stale}
            title={stale ? 'The chain is not reachable while the VPN is connected' : 'Re-read your provider, plans and leases from the chain'}
            className="btn btn-secondary text-xs py-1.5 px-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {refreshing ? <Spinner size="sm" /> : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy || stale}
            className="btn btn-secondary text-xs py-1.5 px-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Edit details
          </button>
          <button
            type="button"
            onClick={() => setStatus(!active)}
            disabled={busy || stale}
            className={`btn text-xs py-1.5 px-3 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 min-w-[132px] ${
              showActive ? 'btn-secondary' : 'btn-primary'
            }`}
          >
            {busy && <Spinner size="sm" />}
            {pendingTarget === null
              ? (active ? 'Deactivate' : 'Activate')
              : (pendingTarget ? 'Activating…' : 'Deactivating…')}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2 mt-2">
          <p className="text-danger text-xs">{displayConnectError(error)}</p>
        </div>
      )}
      {editing && (
        <ProviderDetailsModal provider={provider} onClose={() => setEditing(false)} onSaved={onChanged} />
      )}
      {confirmDialog}
    </div>
  )
}

function activateQuestion() {
  return {
    title: 'Activate this provider?',
    body: [
      'Your active plans become visible to subscribers, and the chain will start accepting plan and lease transactions from you.',
      'This is an on-chain transaction.',
    ],
    confirmLabel: 'Activate',
  }
}

/**
 * Deactivating is the closest thing the chain has to cancelling a provider, and
 * it is far more destructive than "your plans stop being offered".
 *
 * Three hooks fire in sentinelhub v12: x/lease's ProviderInactivePreHook ends
 * EVERY lease, each ended lease fires x/plan's LeaseInactivePreHook which unlinks
 * that node from every plan, and x/plan's ProviderInactivePreHook deactivates
 * every active plan. So the counts are read off the state we already hold and
 * stated plainly, rather than discovered afterwards.
 */
function deactivateQuestion(plans: MyPlan[], leases: LeaseSummary[]) {
  const activePlans = plans.filter((p) => p.status === STATUS_ACTIVE).length
  const nodes = new Set(leases.map((l) => l.nodeAddress)).size
  const consequences: string[] = []
  if (leases.length > 0) {
    consequences.push(`${leases.length} lease${leases.length === 1 ? '' : 's'} will be ended by the chain and the unspent escrow refunded`)
  }
  if (nodes > 0) {
    consequences.push(`${nodes} node${nodes === 1 ? '' : 's'} will be unlinked from your plans`)
  }
  if (activePlans > 0) {
    consequences.push(`${activePlans} active plan${activePlans === 1 ? '' : 's'} will be deactivated`)
  }

  return {
    title: 'Deactivate this provider?',
    body: [
      consequences.length > 0
        ? `The chain does this for you, all in the same block: ${consequences.join(', ')}.`
        : 'You have no leases or active plans, so nothing else changes.',
      'Reactivating later costs no new deposit, but every lease has to be bought again and every node linked again.',
      'The registration deposit went to the community pool and is not returned. There is no way to remove a provider from the chain, so this is as close to cancelling as it gets.',
      'This is an on-chain transaction.',
    ],
    confirmLabel: 'Deactivate',
    danger: true,
  }
}
