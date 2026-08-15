import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNodesContext } from '../../contexts/NodesContext'
import type { LeaseSummary, MyPlan, ProviderEconomics, SentNode, TokenPrice } from '../../types'
import { displayConnectError } from '../../utils/connect-errors'
import { protocolMeta } from '../../utils/protocols'
import CountryFlag from '../CountryFlag'
import Spinner from '../Spinner'
import { formatUdvpn, formatUdvpnAmount, formatUsd } from './ProviderConsole'

/**
 * Nodes serving one plan.
 *
 * Attaching a node is two on-chain steps, not one: the hub's HandleMsgLinkNode
 * rejects unless an active LEASE already exists between this provider and the
 * node, so we buy the lease first and link second. Both are shown as one action,
 * but because they are separate transactions the middle state is real — a node
 * that is leased but not linked gets its own group with a Link button, which is
 * also what the user comes back to if the app is closed between the two.
 */
export default function PlanNodesManager({ plan, leases, price, economics, onChanged }: {
  plan: MyPlan
  leases: LeaseSummary[]
  price: TokenPrice | null
  economics: ProviderEconomics | null
  onChanged: () => void
}) {
  const { allNodes } = useNodesContext()
  const [linked, setLinked] = useState<string[] | null>(null)
  const [busyAddress, setBusyAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [leasingNode, setLeasingNode] = useState<SentNode | null>(null)

  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])

  const loadLinked = useCallback(() => {
    setLinked(null)
    window.api
      .planNodes(plan.id)
      .then(setLinked)
      .catch(() => setLinked([]))
  }, [plan.id])

  useEffect(loadLinked, [loadLinked])

  const linkedSet = useMemo(() => new Set(linked ?? []), [linked])
  const leasedNotLinked = leases.filter((l) => !linkedSet.has(l.nodeAddress))

  const refreshAll = useCallback(() => {
    loadLinked()
    onChanged()
  }, [loadLinked, onChanged])

  const run = useCallback(async (address: string, action: () => Promise<void>) => {
    setBusyAddress(address)
    setError(null)
    try {
      await action()
      refreshAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyAddress(null)
    }
  }, [refreshAll])

  async function handleUnlink(address: string) {
    if (!confirm(`Unlink this node from plan #${plan.id}?\n\nSubscribers stop being served by it. Your lease is unaffected. This is an on-chain transaction.`)) return
    await run(address, () => window.api.providerPlanUnlink(plan.id, address))
  }

  async function handleLink(address: string) {
    await run(address, () => window.api.providerPlanLink(plan.id, address))
  }

  async function handleEndLease(lease: LeaseSummary) {
    if (!confirm(
      `End lease #${lease.id}?\n\nThe unused hours are refunded and the node is unlinked from your plans. ` +
      `This is an on-chain transaction.`
    )) return
    await run(lease.nodeAddress, () => window.api.leaseEnd(lease.id))
  }

  const leasedAddresses = useMemo(() => new Set(leases.map((l) => l.nodeAddress)), [leases])

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-5 py-2.5 border-b border-border shrink-0">
        <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          Nodes serving plan #{plan.id}
        </span>
      </div>

      {error && <p className="text-danger text-xs px-5 pt-3">{displayConnectError(error)}</p>}

      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-5">
        <Section title={`Linked (${linkedSet.size})`}>
          {linked === null && (
            <span className="text-text-tertiary text-xs flex items-center gap-2"><Spinner /> Loading…</span>
          )}
          {linked !== null && linkedSet.size === 0 && (
            <p className="text-text-tertiary text-xs">
              No nodes yet. Add one below. Subscribers to this plan have nothing to connect to until you do.
            </p>
          )}
          {[...linkedSet].map((address) => (
            <NodeRow
              key={address}
              address={address}
              node={nodeIndex.get(address)}
              busy={busyAddress === address}
              action={{ label: 'Unlink', kind: 'danger', onClick: () => handleUnlink(address) }}
            />
          ))}
        </Section>

        {leasedNotLinked.length > 0 && (
          <Section title={`Leased, not linked (${leasedNotLinked.length})`}>
            <p className="text-text-tertiary text-xs">
              You already pay for these nodes. Link one to put it behind this plan.
            </p>
            {leasedNotLinked.map((lease) => (
              <NodeRow
                key={lease.id}
                address={lease.nodeAddress}
                node={nodeIndex.get(lease.nodeAddress)}
                busy={busyAddress === lease.nodeAddress}
                note={`lease #${lease.id} · ${lease.hours}/${lease.maxHours}h used · ${formatUdvpn(lease.hourlyPrice)}/h`}
                action={{ label: 'Link', kind: 'primary', onClick: () => handleLink(lease.nodeAddress) }}
                secondaryAction={{ label: 'End lease', onClick: () => handleEndLease(lease) }}
              />
            ))}
          </Section>
        )}

        <Section title="Add a node">
          <NodePicker
            nodes={allNodes}
            excluded={leasedAddresses}
            price={price}
            onPick={setLeasingNode}
          />
        </Section>
      </div>

      {leasingNode && (
        <LeaseModal
          node={leasingNode}
          planId={plan.id}
          price={price}
          economics={economics}
          onClose={() => setLeasingNode(null)}
          onDone={() => {
            setLeasingNode(null)
            refreshAll()
          }}
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-text-secondary text-xs font-medium uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  )
}

function NodeRow({ address, node, busy, note, action, secondaryAction }: {
  address: string
  node: SentNode | undefined
  busy: boolean
  note?: string
  action: { label: string; kind: 'primary' | 'danger'; onClick: () => void }
  secondaryAction?: { label: string; onClick: () => void }
}) {
  return (
    <div className="border border-border bg-bg-tertiary rounded-md px-3 py-2 text-xs flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {node && <CountryFlag country={node.country} />}
          <span className="text-text-primary truncate">{node?.moniker || 'Unknown node'}</span>
          {node && (
            <span className="text-text-tertiary shrink-0">
              {node.country}{node.city ? ` · ${node.city}` : ''} · {protocolMeta(node.type).label}
            </span>
          )}
        </div>
        <div className="text-text-tertiary font-mono text-[10px] mt-0.5 truncate">{address}</div>
        {note && <div className="text-text-tertiary text-[10px] mt-0.5">{note}</div>}
      </div>
      {secondaryAction && (
        <button
          type="button"
          onClick={secondaryAction.onClick}
          disabled={busy}
          className="btn btn-secondary text-xs py-1 px-2.5 shrink-0 disabled:opacity-40"
        >
          {secondaryAction.label}
        </button>
      )}
      <button
        type="button"
        onClick={action.onClick}
        disabled={busy}
        className={`btn text-xs py-1 px-2.5 shrink-0 disabled:opacity-40 ${
          action.kind === 'danger' ? 'btn-danger' : 'btn-primary'
        }`}
      >
        {busy ? '…' : action.label}
      </button>
    </div>
  )
}

const PICKER_LIMIT = 25

/** Only nodes that publish an hourly price can be leased, so the rest are never offered. */
function NodePicker({ nodes, excluded, price, onPick }: {
  nodes: SentNode[]
  excluded: Set<string>
  price: TokenPrice | null
  onPick: (node: SentNode) => void
}) {
  const [search, setSearch] = useState('')

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    const leasable = nodes.filter(
      (n) => !excluded.has(n.address) && n.isActive && n.hourlyPrices.some((p) => p.denom === 'udvpn'),
    )
    const filtered = q
      ? leasable.filter(
          (n) =>
            n.moniker.toLowerCase().includes(q) ||
            n.country.toLowerCase().includes(q) ||
            n.city.toLowerCase().includes(q) ||
            n.address.toLowerCase().includes(q),
        )
      : leasable
    const hourlyOf = (n: SentNode) => Number(n.hourlyPrices.find((p) => p.denom === 'udvpn')?.value ?? Infinity)
    return [...filtered].sort((a, b) => hourlyOf(a) - hourlyOf(b)).slice(0, PICKER_LIMIT)
  }, [nodes, excluded, search])

  return (
    <div className="space-y-1.5">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search nodes by name, country, city or address…"
        className="w-full bg-bg-tertiary border border-border text-text-primary text-xs px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
      />
      {matches.length === 0 && (
        <p className="text-text-tertiary text-xs">
          No leasable nodes match. A node must be active and publish an hourly price in P2P.
        </p>
      )}
      {matches.map((node) => {
        const hourly = node.hourlyPrices.find((p) => p.denom === 'udvpn')?.value ?? '0'
        return (
          <div
            key={node.address}
            className="border border-border bg-bg-tertiary rounded-md px-3 py-2 text-xs flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <CountryFlag country={node.country} />
                <span className="text-text-primary truncate">{node.moniker || 'Unnamed'}</span>
                <span className="text-text-tertiary shrink-0">
                  {node.country || 'Unknown'}{node.city ? ` · ${node.city}` : ''} · {protocolMeta(node.type).label}
                </span>
              </div>
              <div className="text-text-tertiary text-[10px] mt-0.5">
                {formatUdvpn(hourly)} per hour
                {price && ` ≈ ${formatUsd(hourly, price.usd)}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onPick(node)}
              className="btn btn-primary text-xs py-1 px-2.5 shrink-0"
            >
              Lease &amp; link
            </button>
          </div>
        )
      })}
    </div>
  )
}

const RENEWAL_OPTIONS = [
  { value: 7, label: 'Renew automatically' },
  { value: 2, label: 'Renew if price ≤ current' },
  { value: 0, label: "Don't renew" },
]

/**
 * Buy the lease, then link. Both are priced and confirmed here because the lease
 * is the only step that moves funds — `leaseQuote` computes the total in the main
 * process from the node's own on-chain hourly price, never from anything typed here.
 */
function LeaseModal({ node, planId, price, economics, onClose, onDone }: {
  node: SentNode
  planId: string
  price: TokenPrice | null
  economics: ProviderEconomics | null
  onClose: () => void
  onDone: () => void
}) {
  const [hours, setHours] = useState('24')
  const [policy, setPolicy] = useState(7)
  const [quote, setQuote] = useState<{ totalUdvpn: string; hourlyPrice: string; minHours: number; maxHours: number } | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'idle' | 'leasing' | 'linking'>('idle')

  const hourCount = Number(hours)
  const hoursValid = Number.isInteger(hourCount) && hourCount > 0

  useEffect(() => {
    if (!hoursValid) return
    let cancelled = false
    setQuoteError(null)
    window.api
      .leaseQuote(node.address, hourCount)
      .then((q) => { if (!cancelled) setQuote(q) })
      .catch((e: unknown) => {
        if (!cancelled) setQuoteError(e instanceof Error ? e.message : 'Could not price this lease')
      })
    return () => { cancelled = true }
  }, [node.address, hourCount, hoursValid])

  const withinBounds = quote ? hourCount >= quote.minHours && hourCount <= quote.maxHours : hoursValid

  // LegacyDec is 10^18-scaled, so /1e16 turns the raw share straight into a percent.
  const poolPercent =
    economics?.leaseStakingShare && /^\d+$/.test(economics.leaseStakingShare)
      ? Math.round(Number(economics.leaseStakingShare) / 1e16)
      : null

  // What this lease does to the running cost. The total above is a one-off outlay;
  // this is the rate it commits to, which is the figure the plan price has to cover.
  const nextDailyBurn = useMemo(() => {
    if (!quote || !economics) return null
    if (!/^\d+$/.test(quote.hourlyPrice) || !/^\d+$/.test(economics.burnDailyUdvpn)) return null
    return (BigInt(economics.burnDailyUdvpn) + BigInt(quote.hourlyPrice) * 24n).toString()
  }, [quote, economics])

  async function handleConfirm() {
    if (!quote || !withinBounds) return
    if (!confirm(
      `Lease ${node.moniker || node.address} for ${hourCount} hours?\n\n` +
      `Cost: ${formatUdvpn(quote.totalUdvpn)}, held on chain and paid to the node operator hourly. ` +
      `Ending the lease early refunds the unused hours.\n\n` +
      `Two on-chain transactions: the lease, then the link to plan #${planId}.`
    )) return

    setBusy(true)
    setError(null)
    try {
      setStep('leasing')
      await window.api.leaseStart({ nodeAddress: node.address, hours: hourCount, renewalPolicy: policy })
      // Link immediately — but as its own tx. If it fails, the lease still stands
      // and the node shows up under "Leased, not linked" with a Link button.
      setStep('linking')
      await window.api.providerPlanLink(planId, node.address)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
      setStep('idle')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6" onClick={onClose}>
      <div
        className="bg-bg-secondary border border-border rounded-lg w-full max-w-md p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-text-primary text-sm font-semibold">Lease &amp; link</h3>
          <p className="text-text-secondary text-xs mt-1">{node.moniker || node.address}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-text-tertiary text-[10px] uppercase tracking-wide">Hours</span>
            <input
              type="text"
              inputMode="numeric"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="mt-0.5 w-full bg-bg-tertiary border border-border text-text-primary text-xs px-2 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
            />
          </label>
          <label className="block">
            <span className="text-text-tertiary text-[10px] uppercase tracking-wide">Renewal</span>
            <select
              value={policy}
              onChange={(e) => setPolicy(parseInt(e.target.value, 10))}
              className="mt-0.5 w-full bg-bg-tertiary border border-border text-text-primary text-xs px-2 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
            >
              {RENEWAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>

        {quote && (
          <dl className="border border-border bg-bg-tertiary rounded-md text-xs divide-y divide-border">
            <div className="flex justify-between px-3 py-2">
              <dt className="text-text-secondary">Hourly price</dt>
              <dd className="text-text-primary">{formatUdvpn(quote.hourlyPrice)}</dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-text-secondary">Total for {hourCount}h</dt>
              <dd className="text-text-primary font-medium">
                {formatUdvpn(quote.totalUdvpn)}
                {price && <span className="text-text-tertiary font-normal"> ≈ {formatUsd(quote.totalUdvpn, price.usd)}</span>}
              </dd>
            </div>
            {nextDailyBurn && economics && (
              <div className="flex justify-between px-3 py-2">
                <dt className="text-text-secondary">Daily burn after this</dt>
                <dd className="text-text-primary">
                  <span className="text-text-tertiary">{formatUdvpnAmount(economics.burnDailyUdvpn)}</span>
                  {' → '}
                  {formatUdvpnAmount(nextDailyBurn)}
                </dd>
              </div>
            )}
            <div className="flex justify-between px-3 py-2">
              <dt className="text-text-secondary">Allowed length</dt>
              <dd className="text-text-tertiary">{quote.minHours}–{quote.maxHours} hours</dd>
            </div>
          </dl>
        )}

        <p className="text-text-tertiary text-xs">
          A lease is how you pay a node operator to carry your plan&apos;s traffic. The chain refuses to link
          a node to a plan without one. You are billed every hour whether or not anyone connects, so this is
          a running cost your plan price has to cover. Unused hours are refunded if you end it early.
          {poolPercent !== null && (
            <> Of each hourly payment the chain sends {poolPercent}% to the community pool and the rest to
            the node operator, and you pay the full rate either way.</>
          )}
        </p>

        {quoteError && <p className="text-danger text-xs">{displayConnectError(quoteError)}</p>}
        {!withinBounds && quote && (
          <p className="text-warning text-xs">Length must be between {quote.minHours} and {quote.maxHours} hours.</p>
        )}
        {error && <p className="text-danger text-xs">{displayConnectError(error)}</p>}
        {busy && (
          <p className="text-text-secondary text-xs flex items-center gap-2">
            <Spinner />
            {step === 'leasing' ? 'Buying the lease…' : 'Linking the node to the plan…'}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary text-xs py-2 flex-1 disabled:opacity-40">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || !quote || !withinBounds}
            className="btn btn-primary text-xs py-2 flex-1 disabled:opacity-40"
          >
            {busy ? '…' : quote ? `Lease for ${formatUdvpn(quote.totalUdvpn)}` : 'Pricing…'}
          </button>
        </div>
      </div>
    </div>
  )
}
