import { useState } from 'react'
import type { PlanInfo, SubscriptionSummary } from '../../types'
import { usePlansContext } from '../../contexts/PlansContext'
import { planPriceDisplay, formatDateUntil } from '../../utils/format'
import { displayConnectError } from '../../utils/connect-errors'
import Spinner from '../Spinner'

interface Props {
  subscription: SubscriptionSummary
  /** The subscription's plan row when it is a plan subscription and the catalog knows it. */
  plan: PlanInfo | null
  onClose: () => void
}

const POLICY_LABELS: Record<number, string> = {
  0: 'Never renew',
  7: 'Renew automatically',
}

type Confirming = 'cancel' | 'renew' | null

/**
 * Manage one subscription: renewal policy, renew now, cancel. In-app modal
 * with explicit confirmation and inline errors, replacing the native
 * confirm()/alert() dialogs the old tab used for on-chain money. Every IPC
 * call is caught; a rejection shows here instead of vanishing.
 */
export default function SubscriptionActionModal({ subscription, plan, onClose }: Props) {
  const { refreshOverview } = usePlansContext()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [policy, setPolicy] = useState(subscription.renewalPricePolicy)
  const [done, setDone] = useState<string | null>(null)

  const isPlanSub = subscription.planId !== '0'
  const price = plan ? planPriceDisplay(plan.prices) : null

  /**
   * A null doneMessage closes the modal on success instead of reporting
   * inline. That is the cancel path: the subscription is no longer active, so
   * nothing here can act on it any more, and the snapshot this modal was
   * opened with still says status 1. Leaving it open invited a second cancel,
   * which the chain rejects with a raw "invalid status inactive_pending".
   */
  async function run(label: string, action: () => Promise<void>, doneMessage: string | null) {
    setBusy(label)
    setError(null)
    try {
      await action()
      await refreshOverview()
      if (doneMessage === null) {
        onClose()
        return
      }
      setDone(doneMessage)
      setConfirming(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={busy ? undefined : onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-6 space-y-4 rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-text-primary text-base font-semibold">
            Subscription #{subscription.id}
          </h2>
          {!busy && (
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
              ×
            </button>
          )}
        </div>

        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-text-secondary">Kind</span>
            <span className="text-text-primary">
              {isPlanSub ? `Plan #${subscription.planId}` : 'Node subscription (per GB or hourly)'}
            </span>
          </div>
          {subscription.inactiveAt && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Active until</span>
              <span className="text-text-primary">{formatDateUntil(subscription.inactiveAt)}</span>
            </div>
          )}
        </div>

        {done && (
          <div className="bg-success/10 border border-success/40 rounded-md px-3 py-2 text-success text-sm">
            {done}
          </div>
        )}

        {error && (
          <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2 text-danger text-sm">
            {displayConnectError(error)}
          </div>
        )}

        {/* Renewal policy */}
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-text-secondary">Renewal</span>
          <div className="flex items-center gap-2">
            <select
              value={policy}
              onChange={(e) => setPolicy(parseInt(e.target.value, 10))}
              disabled={busy !== null}
              className="bg-bg-tertiary border border-border text-text-primary text-sm px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus"
            >
              {Object.entries(POLICY_LABELS).map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
            <button
              onClick={() => run(
                'policy',
                () => window.api.subscriptionUpdatePolicy(subscription.id, policy),
                'Renewal policy updated.',
              )}
              disabled={busy !== null || policy === subscription.renewalPricePolicy}
              className="btn btn-secondary text-xs px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === 'policy' ? <Spinner /> : 'Save'}
            </button>
          </div>
        </div>

        {/* Renew now (plan subscriptions only: a node subscription has no plan price). */}
        {isPlanSub && (
          confirming === 'renew' ? (
            <div className="bg-bg-tertiary border border-border rounded-md p-3 space-y-2 text-sm">
              <p className="text-text-primary">
                Renew this subscription for another period now?
                {price?.amount
                  ? ` This charges ${price.amount} ${price.denomLabel} again.`
                  : ' This charges the plan price again at its current on-chain rate.'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => run(
                    'renew',
                    () => window.api.subscriptionRenew(subscription.id, subscription.planId, 'udvpn'),
                    'Renewed. The new period starts when the current one ends.',
                  )}
                  disabled={busy !== null}
                  className="btn btn-primary flex-1 disabled:opacity-40"
                >
                  {busy === 'renew' ? <Spinner /> : 'Renew and pay'}
                </button>
                <button onClick={() => setConfirming(null)} disabled={busy !== null} className="btn btn-secondary flex-1">
                  Keep as is
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setDone(null); setConfirming('renew') }}
              disabled={busy !== null || subscription.status !== 1}
              className="btn btn-secondary w-full text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Renew now{price?.amount ? ` (${price.amount} ${price.denomLabel})` : ''}
            </button>
          )
        )}

        {/* Cancel */}
        {confirming === 'cancel' ? (
          <div className="bg-danger-subtle border border-danger rounded-md p-3 space-y-2 text-sm">
            <p className="text-danger">
              Cancelling marks the subscription inactive and ends its sessions. It is not an
              instant refund: the chain settles what was used first, over up to two hours.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => run(
                  'cancel',
                  () => window.api.subscriptionCancel(subscription.id),
                  null,
                )}
                disabled={busy !== null}
                className="btn btn-danger flex-1 disabled:opacity-40"
              >
                {busy === 'cancel' ? <Spinner /> : 'Cancel subscription'}
              </button>
              <button onClick={() => setConfirming(null)} disabled={busy !== null} className="btn btn-secondary flex-1">
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { setDone(null); setConfirming('cancel') }}
            disabled={busy !== null || subscription.status !== 1}
            className="btn btn-danger w-full text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel subscription
          </button>
        )}

        {subscription.status !== 1 && (
          <p className="text-text-tertiary text-xs">
            This subscription is no longer active, so renewing and cancelling are unavailable.
          </p>
        )}
      </div>
    </div>
  )
}
