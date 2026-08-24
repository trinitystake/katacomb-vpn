import { useMemo, useState } from 'react'
import type { PlanAllocation, PlanInfo, SubscriptionSummary } from '../../types'
import { usePlansContext } from '../../contexts/PlansContext'
import { useConnection } from '../../hooks/useConnection'
import { formatBytes, formatDuration, formatDateUntil } from '../../utils/format'
import PlanConnectModal from './PlanConnectModal'
import SubscriptionActionModal from './SubscriptionActionModal'

/** One subscription the wallet owns, joined with its plan's details when it has one. */
interface MyPlanRow {
  subscription: SubscriptionSummary
  /** The allocation join for plan subscriptions; null for node (per-GB/hour) subs. */
  allocation: PlanAllocation | null
  /** The catalog's plan row, when the catalog knows the plan. */
  plan: PlanInfo | null
}

const STATUS_META: Record<number, { label: string; dot: string; text: string }> = {
  1: { label: 'Active', dot: 'status-dot-active', text: 'text-success' },
  2: { label: 'Ending', dot: 'status-dot-pending', text: 'text-warning' },
  3: { label: 'Inactive', dot: 'bg-border', text: 'text-text-tertiary' },
}

/**
 * The wallet's subscriptions as actionable rows: Connect (smart) as the
 * primary action on active plan subscriptions, a manual picker as secondary,
 * and Manage for renewal/cancel. Validity dates are shown; the old tab
 * fetched them and never rendered them.
 */
export default function MyPlansPanel({ onBrowse }: { onBrowse: () => void }) {
  const { overview, loading } = usePlansContext()
  const { status } = useConnection()
  const tunnelUp = status.state === 'connected' || status.state === 'reconnecting'
  const [connectTarget, setConnectTarget] = useState<{ row: MyPlanRow; manual: boolean } | null>(null)
  const [manageTarget, setManageTarget] = useState<MyPlanRow | null>(null)

  const rows = useMemo<MyPlanRow[]>(() => {
    const allocById = new Map(overview.allocations.map((a) => [a.subscriptionId, a]))
    const planById = new Map(overview.plans.map((p) => [p.id, p]))
    const list = overview.subscriptions.map((subscription) => ({
      subscription,
      allocation: allocById.get(subscription.id) ?? null,
      plan: planById.get(subscription.planId) ?? null,
    }))
    // Active first, then newest start date.
    list.sort((a, b) => {
      const rank = (r: MyPlanRow) => (r.subscription.status === 1 ? 0 : 1)
      return rank(a) - rank(b) ||
        new Date(b.subscription.startAt || 0).getTime() - new Date(a.subscription.startAt || 0).getTime()
    })
    return list
  }, [overview.subscriptions, overview.allocations, overview.plans])

  if (loading) {
    return <div className="p-5 text-text-tertiary text-sm">Loading your plans...</div>
  }

  if (rows.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        <p className="text-text-primary text-sm font-medium">No plans yet</p>
        <p className="text-text-secondary text-sm text-center max-w-sm">
          A plan is a prepaid bundle from a provider: one purchase covers every node the
          provider links to it, usually cheaper than paying a single node per GB.
        </p>
        <button onClick={onBrowse} className="btn btn-primary text-sm">
          Browse the catalog
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-2">
      {overview.stale && (
        <p className="text-text-tertiary text-xs">
          Showing cached data. The chain is not reachable while the VPN is connected.
        </p>
      )}
      {rows.map((row) => {
        const { subscription: sub, allocation } = row
        const meta = STATUS_META[sub.status] ?? STATUS_META[3]
        const isPlanSub = sub.planId !== '0'
        const size = allocation ? formatBytes(allocation.planBytes) : null
        const duration = allocation ? formatDuration(allocation.planDurationSeconds) : null
        const canConnect = isPlanSub && sub.status === 1 && !tunnelUp && !overview.stale
        return (
          <div key={sub.id} className="bg-bg-tertiary border border-border rounded-md px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {size ? (
                    <span className="text-accent text-sm font-semibold">{size}</span>
                  ) : (
                    <span className="text-text-primary text-sm font-medium">Node subscription</span>
                  )}
                  {isPlanSub && (
                    <span className="text-text-secondary text-xs font-mono">plan #{sub.planId}</span>
                  )}
                  <span className="text-text-tertiary text-xs font-mono">sub #{sub.id}</span>
                  <span className="flex items-center gap-1.5 ml-auto">
                    <span className={`status-dot ${meta.dot}`} />
                    <span className={`text-xs ${meta.text}`}>{meta.label}</span>
                  </span>
                </div>
                <div className="text-text-secondary text-xs mt-1">
                  {isPlanSub
                    ? `${duration ?? 'unknown period'}${sub.inactiveAt ? `, active until ${formatDateUntil(sub.inactiveAt)}` : ''}`
                    : `Pay per use${sub.inactiveAt ? `, active until ${formatDateUntil(sub.inactiveAt)}` : ''}`}
                  {sub.renewalPricePolicy === 0 ? ', will not renew' : ', renews automatically'}
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-2.5">
              {isPlanSub && (
                <>
                  <button
                    onClick={() => setConnectTarget({ row, manual: false })}
                    disabled={!canConnect}
                    title={tunnelUp ? 'Disconnect first to start a new session' : undefined}
                    className="btn btn-primary text-xs px-3 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Connect
                  </button>
                  <button
                    onClick={() => setConnectTarget({ row, manual: true })}
                    disabled={!canConnect}
                    className="btn btn-secondary text-xs px-3 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Choose node
                  </button>
                </>
              )}
              <button
                onClick={() => setManageTarget(row)}
                disabled={overview.stale}
                className="btn btn-secondary text-xs px-3 py-1 ml-auto disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Manage
              </button>
            </div>
          </div>
        )
      })}

      {connectTarget && (
        <PlanConnectModal
          plan={
            connectTarget.row.plan ?? {
              // The catalog may not know a plan the wallet subscribed to
              // elsewhere; the allocation carries enough to connect with.
              id: connectTarget.row.subscription.planId,
              provAddress: connectTarget.row.allocation?.planProvAddress ?? '',
              bytes: connectTarget.row.allocation?.planBytes ?? '0',
              durationSeconds: connectTarget.row.allocation?.planDurationSeconds ?? null,
              prices: [],
              private: false,
              status: 1,
              isTest: false,
            }
          }
          subscriptionId={connectTarget.row.subscription.id}
          startManual={connectTarget.manual}
          onClose={() => setConnectTarget(null)}
        />
      )}

      {manageTarget && (
        <SubscriptionActionModal
          subscription={manageTarget.subscription}
          plan={manageTarget.plan}
          onClose={() => setManageTarget(null)}
        />
      )}
    </div>
  )
}
