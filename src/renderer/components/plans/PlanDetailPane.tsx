import { useEffect, useMemo, useState } from 'react'
import type { PlanInfo, ProviderInfo, SentNode, TokenPrice } from '../../types'
import { useNodesContext } from '../../contexts/NodesContext'
import { useConnection } from '../../hooks/useConnection'
import { formatBytes, formatDuration, planPriceDisplay, pricePerGb, formatPerGb } from '../../utils/format'
import { formatUsd } from '../provider/ProviderConsole'
import { protocolMeta } from '../../utils/protocols'
import Spinner from '../Spinner'
import PlanConnectModal from './PlanConnectModal'

interface Props {
  plan: PlanInfo
  provider: ProviderInfo | null
  tokenPrice: TokenPrice | null
  /** Active subscription ids for this plan, so the pane can offer reuse. */
  activeSubscriptionId: string | null
}

/**
 * The selected plan's details: provider identity, honest price (real denom,
 * never free), size and validity, and the linked-node summary fetched on
 * selection rather than in bulk for the whole catalog.
 */
export default function PlanDetailPane({ plan, provider, tokenPrice, activeSubscriptionId }: Props) {
  const { allNodes } = useNodesContext()
  const { status } = useConnection()
  const tunnelUp = status.state === 'connected' || status.state === 'reconnecting'
  const [nodeAddrs, setNodeAddrs] = useState<string[] | null>(null)
  const [nodesFailed, setNodesFailed] = useState(false)
  const [showConnect, setShowConnect] = useState(false)

  useEffect(() => {
    let cancelled = false
    setNodeAddrs(null)
    setNodesFailed(false)
    window.api.planNodes(plan.id)
      .then((addrs) => { if (!cancelled) setNodeAddrs(addrs) })
      .catch(() => { if (!cancelled) { setNodeAddrs([]); setNodesFailed(true) } })
    return () => { cancelled = true }
  }, [plan.id])

  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])
  const nodeSummary = useMemo(() => {
    if (nodeAddrs === null) return null
    const known = nodeAddrs.map((a) => nodeIndex.get(a)).filter((n): n is SentNode => n !== undefined)
    const healthy = known.filter((n) => n.isHealthy && n.isActive).length
    const protocols = [...new Set(known.map((n) => n.type))].sort()
    return { total: nodeAddrs.length, healthy, protocols }
  }, [nodeAddrs, nodeIndex])

  const price = planPriceDisplay(plan.prices)
  const perGb = pricePerGb(plan)
  const usd = price.udvpn !== null && tokenPrice ? formatUsd(price.udvpn, tokenPrice.usd) : null

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-text-primary text-base font-semibold">Plan #{plan.id}</h3>
          {plan.isTest && (
            <span className="text-[10px] font-mono uppercase bg-warning-subtle text-warning px-1.5 py-0.5 rounded-sm">test</span>
          )}
          {plan.private && (
            <span className="text-[10px] font-mono uppercase bg-bg-tertiary text-text-tertiary px-1.5 py-0.5 rounded-sm">private</span>
          )}
        </div>
        <p className="text-text-secondary text-sm mt-0.5">
          {provider?.name || `${plan.provAddress.slice(0, 14)}...${plan.provAddress.slice(-6)}`}
        </p>
        {provider?.description && (
          <p className="text-text-tertiary text-xs mt-1">{provider.description}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-bg-tertiary border border-border rounded-md px-4 py-3">
          <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Data</div>
          <div className="text-accent text-lg font-semibold mt-0.5">{formatBytes(plan.bytes)}</div>
          {perGb !== null && (
            <div className="text-text-tertiary text-xs">{formatPerGb(perGb)} P2P per GB</div>
          )}
        </div>
        <div className="bg-bg-tertiary border border-border rounded-md px-4 py-3">
          <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Validity</div>
          <div className="text-text-primary text-lg font-semibold mt-0.5">{formatDuration(plan.durationSeconds)}</div>
        </div>
        <div className="bg-bg-tertiary border border-border rounded-md px-4 py-3 col-span-2">
          <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Price</div>
          {price.amount ? (
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-accent text-lg font-semibold">{price.amount} {price.denomLabel}</span>
              {usd && <span className="text-text-tertiary text-xs">about {usd}</span>}
            </div>
          ) : (
            <div className="text-text-secondary text-sm mt-0.5">No price listed</div>
          )}
          {price.udvpn === null && price.amount && (
            <div className="text-warning text-xs mt-1">
              Priced in {price.denomLabel}. This app cannot estimate that in USD or check your balance for it.
            </div>
          )}
        </div>
      </div>

      <div className="text-sm">
        <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide mb-1.5">Nodes</div>
        {nodeSummary === null ? (
          <div className="flex items-center gap-2 text-text-tertiary">
            <Spinner /> Checking the plan's nodes...
          </div>
        ) : nodesFailed ? (
          <p className="text-text-secondary">Could not read the plan's node list right now.</p>
        ) : nodeSummary.total === 0 ? (
          <p className="text-warning">No nodes are linked to this plan right now. Subscribing would buy data with nowhere to use it.</p>
        ) : (
          <div className="space-y-1">
            <p className="text-text-primary">
              {nodeSummary.total} node{nodeSummary.total === 1 ? '' : 's'} linked
              {nodeSummary.healthy > 0 && `, ${nodeSummary.healthy} healthy right now`}
            </p>
            {nodeSummary.protocols.length > 0 && (
              <div className="flex gap-1.5">
                {nodeSummary.protocols.map((t) => (
                  <span key={t} className={`text-xs ${protocolMeta(t).color}`}>{protocolMeta(t).short}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <button
        onClick={() => setShowConnect(true)}
        disabled={tunnelUp || plan.status !== 1 || (nodeSummary !== null && !nodesFailed && nodeSummary.total === 0)}
        title={tunnelUp ? 'Disconnect first to start a new session' : undefined}
        className="btn btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {activeSubscriptionId ? 'Connect (already subscribed)' : 'Subscribe and connect'}
      </button>
      {plan.status !== 1 && (
        <p className="text-warning text-xs text-center">This plan is not active on chain, so it cannot be bought.</p>
      )}

      {showConnect && (
        <PlanConnectModal
          plan={plan}
          subscriptionId={activeSubscriptionId ?? undefined}
          onClose={() => setShowConnect(false)}
        />
      )}
    </div>
  )
}
