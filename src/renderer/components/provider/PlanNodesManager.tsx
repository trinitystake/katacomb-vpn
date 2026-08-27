import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNodesContext } from '../../contexts/NodesContext'
import type { LeaseSummary, MyPlan, ProviderEconomics, SentNode, TokenPrice } from '../../types'
import { displayConnectError } from '../../utils/connect-errors'
import { protocolMeta } from '../../utils/protocols'
import CountryFlag from '../CountryFlag'
import { useConfirm } from '../ConfirmModal'
import Spinner from '../Spinner'
import { formatUdvpn, formatUdvpnAmount, formatUsd } from '../../utils/provider-format'
import { RENEWAL_POLICY_OPTIONS, renewalPolicyLabel } from '../../../shared/renewal-policy'
import LeaseManageModal from './LeaseManageModal'

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
export default function PlanNodesManager({ plan, leases, price, economics, providerActive, readOnly, onChanged }: {
  plan: MyPlan
  leases: LeaseSummary[]
  price: TokenPrice | null
  economics: ProviderEconomics | null
  /** The chain refuses MsgStartLease under an inactive provider, so the picker is gated on it. */
  providerActive: boolean
  /** Cached data, chain unreachable: every mutation is disabled. */
  readOnly: boolean
  /** Resolves once the chain has been re-read, so a caller can hold its busy state until then. */
  onChanged: () => Promise<void>
}) {
  const { allNodes, loading: nodesLoading, error: nodesError } = useNodesContext()
  const [linked, setLinked] = useState<string[] | null>(null)
  // A failed read is NOT an empty list: rendering it as "No nodes yet" states
  // something about the plan that nobody verified. The consumer-side pane
  // (PlanDetailPane) draws the same line.
  const [linkedUnknown, setLinkedUnknown] = useState(false)
  const [managingLease, setManagingLease] = useState<LeaseSummary | null>(null)
  const [busyAddress, setBusyAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [leasingNode, setLeasingNode] = useState<SentNode | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])

  const loadLinked = useCallback(async () => {
    setLinked(null)
    setLinkedUnknown(false)
    try {
      const addrs = await window.api.planNodes(plan.id)
      if (addrs === null) {
        // main could not know (cache miss while the chain is unreachable).
        setLinked([])
        setLinkedUnknown(true)
      } else {
        setLinked(addrs)
      }
    } catch {
      setLinked([])
      setLinkedUnknown(true)
    }
  }, [plan.id])

  // Not `useEffect(loadLinked, ...)`: an async callback returns a Promise, and an
  // effect may only return a cleanup function.
  useEffect(() => { void loadLinked() }, [loadLinked])

  const linkedSet = useMemo(() => new Set(linked ?? []), [linked])
  const leasedNotLinked = leases.filter((l) => !linkedSet.has(l.nodeAddress))

  // Resolves once BOTH re-reads have landed, so an action's busy state can span
  // the transaction and the refresh instead of ending between them.
  const refreshAll = useCallback(async () => {
    await Promise.all([loadLinked(), onChanged()])
  }, [loadLinked, onChanged])

  const run = useCallback(async (address: string, action: () => Promise<void>) => {
    setBusyAddress(address)
    setError(null)
    try {
      await action()
      await refreshAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyAddress(null)
    }
  }, [refreshAll])

  async function handleUnlink(address: string) {
    if (!(await requestConfirm({
      title: `Unlink this node from plan #${plan.id}?`,
      body: ['Subscribers stop being served by it. Your lease is unaffected. This is an on-chain transaction.'],
      confirmLabel: 'Unlink',
      danger: true,
    }))) return
    await run(address, () => window.api.providerPlanUnlink(plan.id, address))
  }

  async function handleLink(address: string) {
    if (!(await requestConfirm({
      title: `Link this node to plan #${plan.id}?`,
      body: [
        'Subscribers to the plan can connect through it. You already hold the lease, so this costs the network fee only.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'Link',
    }))) return
    await run(address, () => window.api.providerPlanLink(plan.id, address))
  }

  const leaseByNode = useMemo(() => new Map(leases.map((l) => [l.nodeAddress, l])), [leases])

  const leasedAddresses = useMemo(() => new Set(leases.map((l) => l.nodeAddress)), [leases])
  const pickerDisabled = !providerActive || readOnly

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-5 py-2.5 border-b border-border shrink-0">
        <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          Nodes serving plan #{plan.id}
        </span>
      </div>

      {error && (
        <div className="mx-5 mt-3 bg-danger-subtle border border-danger rounded-md px-3 py-2">
          <p className="text-danger text-xs">{displayConnectError(error)}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-5">
        <Section title={linkedUnknown ? 'Linked' : `Linked (${linkedSet.size})`}>
          {linked === null && (
            <span className="text-text-tertiary text-xs flex items-center gap-2"><Spinner /> Loading…</span>
          )}
          {linkedUnknown && (
            <span className="flex items-center gap-2">
              <p className="text-warning text-xs">Could not read the plan&apos;s node list right now.</p>
              {!readOnly && (
                <button type="button" onClick={() => void loadLinked()} className="text-warning text-[11px] hover:underline">
                  Retry
                </button>
              )}
            </span>
          )}
          {linked !== null && !linkedUnknown && linkedSet.size === 0 && (
            <p className="text-text-tertiary text-xs">
              No nodes yet. Add one below. Subscribers to this plan have nothing to connect to until you do.
            </p>
          )}
          {[...linkedSet].map((address) => {
            const lease = leaseByNode.get(address)
            return (
              <NodeRow
                key={address}
                address={address}
                node={nodeIndex.get(address)}
                busy={busyAddress === address}
                disabled={readOnly}
                note={lease ? leaseNote(lease) : undefined}
                action={{ label: 'Unlink', busyLabel: 'Unlinking…', kind: 'danger', onClick: () => handleUnlink(address) }}
                secondaryAction={lease ? { label: 'Lease', onClick: () => setManagingLease(lease) } : undefined}
              />
            )
          })}
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
                disabled={readOnly}
                note={leaseNote(lease)}
                action={{ label: 'Link', busyLabel: 'Linking…', kind: 'primary', onClick: () => handleLink(lease.nodeAddress) }}
                secondaryAction={{ label: 'Lease', onClick: () => setManagingLease(lease) }}
              />
            ))}
          </Section>
        )}

        <Section title="Add a node">
          <NodePicker
            nodes={allNodes}
            nodesLoading={nodesLoading}
            nodesError={nodesError}
            excluded={leasedAddresses}
            price={price}
            disabled={pickerDisabled}
            disabledReason={
              readOnly
                ? 'The chain is not reachable while the VPN is connected'
                : !providerActive
                  ? 'Activate your provider first'
                  : undefined
            }
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
            // The modal is gone, so there is no busy state left to hold: dropping
            // the promise here is deliberate, unlike the in-place buttons.
            void refreshAll()
          }}
        />
      )}
      {managingLease && (
        <LeaseManageModal
          lease={managingLease}
          node={nodeIndex.get(managingLease.nodeAddress)}
          onClose={() => setManagingLease(null)}
          onDone={() => {
            setManagingLease(null)
            void refreshAll()
          }}
        />
      )}
      {confirmDialog}
    </div>
  )
}

/** One line of lease facts, including the renewal policy the row never used to show. */
function leaseNote(lease: LeaseSummary): string {
  return `lease #${lease.id} · ${lease.hours}/${lease.maxHours}h used · ${formatUdvpn(lease.hourlyPrice)}/h · ${renewalPolicyLabel(lease.renewalPricePolicy).toLowerCase()}`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-text-secondary text-xs font-medium uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  )
}

function NodeRow({ address, node, busy, disabled, note, action, secondaryAction }: {
  address: string
  node: SentNode | undefined
  busy: boolean
  /** Read-only mode: the buttons render but refuse. */
  disabled?: boolean
  note?: string
  /** `busyLabel` is spelled out rather than derived: "End lease" + "ing" is not a word. */
  action: { label: string; busyLabel: string; kind: 'primary' | 'danger'; onClick: () => void }
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
          disabled={busy || disabled}
          className="btn btn-secondary text-xs py-1 px-2.5 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {secondaryAction.label}
        </button>
      )}
      <button
        type="button"
        onClick={action.onClick}
        disabled={busy || disabled}
        className={`btn text-xs py-1 px-2.5 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 min-w-[104px] ${
          action.kind === 'danger' ? 'btn-danger' : 'btn-primary'
        }`}
      >
        {busy && <Spinner size="sm" />}
        {busy ? action.busyLabel : action.label}
      </button>
    </div>
  )
}

const PICKER_LIMIT = 25

/** Only nodes that publish an hourly price can be leased, so the rest are never offered. */
function NodePicker({ nodes, nodesLoading, nodesError, excluded, price, disabled, disabledReason, onPick }: {
  nodes: SentNode[]
  nodesLoading: boolean
  nodesError: string | null
  excluded: Set<string>
  price: TokenPrice | null
  disabled?: boolean
  disabledReason?: string
  onPick: (node: SentNode) => void
}) {
  const [search, setSearch] = useState('')

  const { matches, matchTotal } = useMemo(() => {
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
    return {
      matches: [...filtered].sort((a, b) => hourlyOf(a) - hourlyOf(b)).slice(0, PICKER_LIMIT),
      matchTotal: filtered.length,
    }
  }, [nodes, excluded, search])

  return (
    <div className="space-y-1.5">
      {disabledReason && <p className="text-warning text-xs">{disabledReason}</p>}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search nodes by name, country, city or address…"
        className="w-full bg-bg-tertiary border border-border text-text-primary text-xs px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
      />
      {/* The node list has its own lifecycle: an empty result while it is still
          loading (or failed to load) says nothing about leasable nodes. */}
      {matches.length === 0 && nodesLoading && (
        <span className="text-text-tertiary text-xs flex items-center gap-2"><Spinner /> Loading the node list…</span>
      )}
      {matches.length === 0 && !nodesLoading && nodesError && nodes.length === 0 && (
        <p className="text-warning text-xs">The node list could not be loaded, so there is nothing to pick from yet.</p>
      )}
      {matches.length === 0 && !nodesLoading && !(nodesError && nodes.length === 0) && (
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
              disabled={disabled}
              title={disabledReason}
              className="btn btn-primary text-xs py-1 px-2.5 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Lease &amp; link
            </button>
          </div>
        )
      })}
      {matchTotal > PICKER_LIMIT && (
        <p className="text-text-tertiary text-[11px]">
          Showing the {PICKER_LIMIT} cheapest of {matchTotal.toLocaleString('en-US')} matches. Search to narrow the list.
        </p>
      )}
    </div>
  )
}

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
  const { requestConfirm, confirmDialog } = useConfirm()
  // The default length is clamped into the chain's own bounds once the first
  // quote reports them, but never over anything the user has typed.
  const hoursTouched = useRef(false)

  const hourCount = Number(hours)
  const hoursValid = Number.isInteger(hourCount) && hourCount > 0

  useEffect(() => {
    if (!hoursValid) return
    let cancelled = false
    setQuoteError(null)
    window.api
      .leaseQuote(node.address, hourCount)
      .then((q) => {
        if (cancelled) return
        setQuote(q)
        if (!hoursTouched.current) {
          const clamped = Math.min(Math.max(hourCount, q.minHours), q.maxHours)
          if (clamped !== hourCount) setHours(String(clamped))
        }
      })
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
    if (!(await requestConfirm({
      title: `Lease ${node.moniker || node.address} for ${hourCount} hours?`,
      body: [
        `Cost: ${formatUdvpn(quote.totalUdvpn)}, held on chain and paid to the node operator hourly. ` +
        `Ending the lease early refunds the unused hours.`,
        `Two on-chain transactions: the lease, then the link to plan #${planId}.`,
      ],
      confirmLabel: 'Lease and link',
    }))) return

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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={busy ? undefined : onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-6 space-y-4 rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-text-primary text-base font-semibold">Lease &amp; link</h3>
            <p className="text-text-secondary text-xs mt-1">{node.moniker || node.address}</p>
          </div>
          {!busy && (
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
              ×
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-text-tertiary text-[10px] uppercase tracking-wide">Hours</span>
            <input
              type="text"
              inputMode="numeric"
              value={hours}
              disabled={busy}
              onChange={(e) => {
                hoursTouched.current = true
                setHours(e.target.value)
              }}
              className="mt-0.5 w-full bg-bg-tertiary border border-border text-text-primary text-xs px-2 py-1.5 rounded-sm focus:outline-none focus:border-border-focus disabled:opacity-40"
            />
          </label>
          <label className="block">
            <span className="text-text-tertiary text-[10px] uppercase tracking-wide">Renewal</span>
            <select
              value={policy}
              disabled={busy}
              onChange={(e) => setPolicy(parseInt(e.target.value, 10))}
              className="mt-0.5 w-full bg-bg-tertiary border border-border text-text-primary text-xs px-2 py-1.5 rounded-sm focus:outline-none focus:border-border-focus disabled:opacity-40"
            >
              {RENEWAL_POLICY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="text-text-tertiary text-[10px] block mt-0.5">
              {RENEWAL_POLICY_OPTIONS.find((o) => o.value === policy)?.hint}
            </span>
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
              <dd className="text-text-tertiary">{quote.minHours} to {quote.maxHours} hours</dd>
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

        {quoteError && (
          <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
            <p className="text-danger text-xs">{displayConnectError(quoteError)}</p>
          </div>
        )}
        {!withinBounds && quote && (
          <p className="text-warning text-xs">Length must be between {quote.minHours} and {quote.maxHours} hours.</p>
        )}
        {error && (
          <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
            <p className="text-danger text-xs">{displayConnectError(error)}</p>
          </div>
        )}
        {busy && (
          <p className="text-text-secondary text-xs flex items-center gap-2">
            <Spinner />
            {step === 'leasing' ? 'Buying the lease…' : 'Linking the node to the plan…'}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn btn-secondary text-xs py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || !quote || !withinBounds}
            className="btn btn-primary text-xs py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? '…' : quote ? `Lease for ${formatUdvpn(quote.totalUdvpn)}` : 'Pricing…'}
          </button>
        </div>
        {confirmDialog}
      </div>
    </div>
  )
}
