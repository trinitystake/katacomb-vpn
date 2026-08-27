import { useEffect, useState } from 'react'
import type { LeaseQuote, LeaseSummary, SentNode } from '../../types'
import { RENEWAL_POLICY_OPTIONS, renewalPolicyLabel, renewalPolicyRefusal } from '../../../shared/renewal-policy'
import { displayConnectError } from '../../utils/connect-errors'
import { formatUdvpn, formatUdvpnAmount } from '../../utils/provider-format'
import { useConfirm } from '../ConfirmModal'
import Spinner from '../Spinner'

/**
 * Everything that can be done to a lease after it is bought.
 *
 * All three actions live in one place because they are the same decision seen
 * from different angles: keep paying for this node automatically, pay for a fixed
 * stretch more, or stop. Splitting them across the row would also have hidden the
 * one fact that decides which is available, namely whether the renewal policy
 * still lets the chain renew at the node's current price.
 */
export default function LeaseManageModal({ lease, node, onClose, onDone }: {
  lease: LeaseSummary
  node: SentNode | undefined
  onClose: () => void
  onDone: () => void
}) {
  const [quote, setQuote] = useState<LeaseQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [policy, setPolicy] = useState(lease.renewalPricePolicy)
  const [hours, setHours] = useState(String(lease.maxHours || 720))
  const [busy, setBusy] = useState<'policy' | 'renew' | 'end' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  // One quote for the node's CURRENT hourly price: it is both what an extension
  // would cost and what the renewal policy is compared against.
  useEffect(() => {
    let cancelled = false
    window.api.leaseQuote(lease.nodeAddress, 1)
      .then((q) => { if (!cancelled) setQuote(q) })
      .catch((e: unknown) => {
        if (!cancelled) setQuoteError(e instanceof Error ? e.message : 'Could not price this node')
      })
    return () => { cancelled = true }
  }, [lease.nodeAddress])

  const hourCount = Number(hours)
  const validHours =
    Number.isInteger(hourCount) &&
    hourCount >= (quote?.minHours ?? 1) &&
    hourCount <= (quote?.maxHours ?? 720)
  const extendTotal = quote && validHours ? String(BigInt(quote.hourlyPrice) * BigInt(hourCount)) : null

  // The chain applies this to a hand-sent MsgRenewLease exactly as it does to the
  // automatic one, so an Extend button that ignored it would just buy a rejection.
  const refusal = quote ? renewalPolicyRefusal(lease.renewalPricePolicy, quote.hourlyPrice, lease.hourlyPrice) : null

  async function act(kind: 'policy' | 'renew' | 'end', run: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    try {
      await run()
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  async function handlePolicy() {
    if (!(await requestConfirm({
      title: `Change the renewal policy on lease #${lease.id}?`,
      body: [
        `From "${renewalPolicyLabel(lease.renewalPricePolicy)}" to "${renewalPolicyLabel(policy)}".`,
        'This is an on-chain transaction, and costs the network fee only.',
      ],
      confirmLabel: 'Change policy',
    }))) return
    await act('policy', () => window.api.leaseUpdatePolicy(lease.id, policy))
  }

  async function handleRenew() {
    if (!(await requestConfirm({
      title: `Extend lease #${lease.id} to ${hourCount} hours?`,
      body: [
        `Cost: ${extendTotal ? formatUdvpnAmount(extendTotal) : 'unknown'} escrowed now.`,
        'The chain does not add to the hours you have left: it refunds what is unspent and charges for the whole new term, starting from zero.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'Extend lease',
    }))) return
    await act('renew', () => window.api.leaseRenew(lease.id, hourCount))
  }

  async function handleEnd() {
    if (!(await requestConfirm({
      title: `End lease #${lease.id}?`,
      body: [
        'The unspent escrow is refunded.',
        'The chain also unlinks this node from every plan you had linked it to, so those plans stop being served by it.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'End lease',
      danger: true,
    }))) return
    await act('end', () => window.api.leaseEnd(lease.id))
  }

  const anyBusy = busy !== null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={anyBusy ? undefined : onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-6 space-y-4 rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-text-primary text-base font-semibold">Lease #{lease.id}</h2>
          {!anyBusy && (
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
              ×
            </button>
          )}
        </div>

        <div className="space-y-1.5 text-sm">
          <Line label="Node" value={node?.moniker || lease.nodeAddress} />
          <Line label="Hours used" value={`${lease.hours} of ${lease.maxHours}`} />
          <Line label="Bought at" value={`${formatUdvpn(lease.hourlyPrice)}/h`} />
          <Line
            label="Node charges now"
            value={quote ? `${formatUdvpn(quote.hourlyPrice)}/h` : quoteError ? 'unavailable' : '…'}
          />
          <Line label="Renewal" value={renewalPolicyLabel(lease.renewalPricePolicy)} />
        </div>

        {refusal && (
          <div className="bg-warning/10 border border-warning/40 rounded-sm px-3 py-2">
            <p className="text-warning text-xs">{refusal}</p>
          </div>
        )}

        <div className="border-t border-border pt-4 space-y-2">
          <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">Renewal policy</span>
          <select
            value={policy}
            disabled={anyBusy}
            onChange={(e) => setPolicy(Number(e.target.value))}
            className="w-full bg-bg-tertiary border border-border text-text-primary text-sm px-3 py-2 rounded-sm focus:outline-none focus:border-border-focus disabled:opacity-40"
          >
            {RENEWAL_POLICY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="text-text-tertiary text-[11px]">
            {RENEWAL_POLICY_OPTIONS.find((o) => o.value === policy)?.hint}
          </p>
          <button
            type="button"
            onClick={handlePolicy}
            disabled={anyBusy || policy === lease.renewalPricePolicy}
            className="btn btn-secondary text-xs py-1.5 px-3 disabled:opacity-40"
          >
            {busy === 'policy' ? 'Saving…' : 'Change policy'}
          </button>
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">Extend now</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={hours}
              disabled={anyBusy || Boolean(refusal)}
              onChange={(e) => setHours(e.target.value)}
              className="w-24 bg-bg-tertiary border border-border text-text-primary text-sm px-3 py-2 rounded-sm focus:outline-none focus:border-border-focus disabled:opacity-40"
            />
            <span className="text-text-secondary text-xs">hours</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={handleRenew}
              disabled={anyBusy || Boolean(refusal) || !validHours || !quote}
              className="btn btn-primary text-xs py-1.5 px-3 disabled:opacity-40"
              title={refusal ?? undefined}
            >
              {busy === 'renew'
                ? 'Extending…'
                : extendTotal
                  ? `Extend for ${formatUdvpnAmount(extendTotal)}`
                  : quote ? 'Extend' : 'Pricing…'}
            </button>
          </div>
          <p className="text-text-tertiary text-[11px]">
            This replaces the term rather than adding to it: the chain refunds the unspent escrow and
            charges for the full new stretch. The field starts at the length you originally bought.
          </p>
        </div>

        {(error || quoteError) && (
          <div className="bg-danger-subtle border border-danger rounded-sm px-3 py-2">
            <p className="text-danger text-xs">{displayConnectError(error ?? quoteError ?? '')}</p>
          </div>
        )}

        <div className="border-t border-border pt-4">
          <button
            type="button"
            onClick={handleEnd}
            disabled={anyBusy}
            className="btn btn-danger text-xs py-1.5 px-3 disabled:opacity-40 flex items-center gap-2"
          >
            {busy === 'end' && <Spinner size="sm" />}
            {busy === 'end' ? 'Ending…' : 'End lease'}
          </button>
          <p className="text-text-tertiary text-[11px] mt-1.5">
            Refunds the unspent escrow, and unlinks this node from every plan it serves.
          </p>
        </div>
      </div>
      {confirmDialog}
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-text-secondary shrink-0">{label}</span>
      <span className="text-text-primary truncate">{value}</span>
    </div>
  )
}
