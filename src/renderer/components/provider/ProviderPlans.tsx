import { useCallback, useEffect, useState } from 'react'
import type { LeaseSummary, MyPlan, PlanStats, TokenPrice } from '../../types'
import { displayConnectError } from '../../utils/connect-errors'
import PlanNodesManager from './PlanNodesManager'
import { STATUS_ACTIVE, formatUdvpn, formatUsd } from './ProviderConsole'

function formatSize(bytes: string): string {
  const gb = Number(bytes) / 1e9
  if (!isFinite(gb) || gb <= 0) return '—'
  if (gb >= 1000) return `${(gb / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} TB`
  return `${gb.toLocaleString('en-US', { maximumFractionDigits: 2 })} GB`
}

function formatDays(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—'
  const days = seconds / 86400
  return days >= 1 ? `${days.toLocaleString('en-US', { maximumFractionDigits: 1 })}d` : `${Math.round(seconds / 3600)}h`
}

function planPrice(plan: MyPlan): string {
  const udvpn = plan.prices.find((p) => p.denom === 'udvpn')
  return udvpn ? formatUdvpn(udvpn.quoteValue) : '—'
}

function planUsd(plan: MyPlan, price: TokenPrice | null): string | null {
  if (!price) return null
  const udvpn = plan.prices.find((p) => p.denom === 'udvpn')
  return udvpn ? `≈ ${formatUsd(udvpn.quoteValue, price.usd)}` : null
}

/**
 * Exact P2P → udvpn conversion. String-based rather than `value * 1e6` so a price
 * typed as "12.35" can't land on chain as 12349999 through float rounding.
 * Returns null for anything that isn't a plain amount with at most 6 decimals.
 */
export function p2pToUdvpn(input: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim())
  if (!match) return null
  const frac = (match[2] ?? '').padEnd(6, '0')
  return Number(match[1]) * 1_000_000 + Number(frac)
}

interface Props {
  plans: MyPlan[]
  leases: LeaseSummary[]
  providerActive: boolean
  onChanged: () => void
}

export default function ProviderPlans({ plans, leases, providerActive, onChanged }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const selected = plans.find((p) => p.id === selectedId) ?? null

  // Counters and the USD rate are extra chain/network reads, so they load after
  // the plans themselves and each row shows what it has. Keyed by the plan ids
  // as a string — the plans array is rebuilt on every refresh, its ids are not.
  // null until the first answer arrives; a plan missing from it afterwards is one
  // the chain wouldn't answer for, which the row shows as "—" rather than a
  // spinner that never stops.
  const [stats, setStats] = useState<Record<string, PlanStats> | null>(null)
  const [price, setPrice] = useState<TokenPrice | null>(null)
  const planIds = plans.map((p) => p.id).join(',')

  const loadStats = useCallback(() => {
    if (!planIds) {
      setStats({})
      return
    }
    window.api.providerPlanStats(planIds.split(',')).then(setStats).catch(() => setStats({}))
  }, [planIds])

  useEffect(loadStats, [loadStats])

  useEffect(() => {
    window.api.priceToken().then(setPrice).catch(() => setPrice(null))
  }, [])

  // Linking a node or selling a subscription changes the counters without
  // changing the plan list, so every action re-reads both.
  const handleChanged = useCallback(() => {
    onChanged()
    loadStats()
  }, [onChanged, loadStats])

  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-[380px] border-r border-border flex flex-col min-h-0">
        <div className="flex items-center justify-between px-5 py-2.5 border-b border-border shrink-0">
          <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">
            Your plans ({plans.length})
          </span>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="btn btn-secondary text-xs py-1 px-2.5"
          >
            {creating ? 'Cancel' : 'New plan'}
          </button>
        </div>

        {creating && (
          <CreatePlanForm
            price={price}
            onCreated={() => {
              setCreating(false)
              handleChanged()
            }}
          />
        )}

        <div className="flex-1 overflow-y-auto">
          {plans.length === 0 && !creating && (
            <p className="text-text-tertiary text-xs px-5 py-4">
              No plans yet. Create one, then activate it and link leased nodes to it.
            </p>
          )}
          {plans.map((plan) => (
            <PlanRow
              key={plan.id}
              plan={plan}
              stats={stats ? stats[plan.id] ?? null : undefined}
              price={price}
              selected={plan.id === selectedId}
              providerActive={providerActive}
              onSelect={() => setSelectedId(plan.id === selectedId ? null : plan.id)}
              onChanged={handleChanged}
            />
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        {selected ? (
          <PlanNodesManager plan={selected} leases={leases} price={price} onChanged={handleChanged} />
        ) : (
          <div className="h-full flex items-center justify-center px-8">
            <p className="text-text-tertiary text-sm text-center max-w-sm">
              Select a plan to manage the nodes that serve it.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function PlanRow({ plan, stats, price, selected, providerActive, onSelect, onChanged }: {
  plan: MyPlan
  /** undefined while the counters are still being read, null if they couldn't be. */
  stats: PlanStats | null | undefined
  price: TokenPrice | null
  selected: boolean
  providerActive: boolean
  onSelect: () => void
  onChanged: () => void
}) {
  const active = plan.status === STATUS_ACTIVE
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggleStatus(e: React.MouseEvent) {
    e.stopPropagation()
    if (!active && !providerActive) {
      setError('Activate your provider first — the chain rejects an active plan under an inactive provider.')
      return
    }
    if (!confirm(
      active
        ? `Deactivate plan #${plan.id}?\n\nIt stops being offered to new subscribers. This is an on-chain transaction.`
        : `Activate plan #${plan.id}?\n\nIt becomes visible to subscribers. This is an on-chain transaction.`
    )) return
    setBusy(true)
    setError(null)
    try {
      await window.api.providerPlanSetStatus(plan.id, !active)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={onSelect}
      className={`px-5 py-3 border-b border-border cursor-pointer transition-colors ${
        selected ? 'bg-accent-subtle' : 'hover:bg-bg-hover'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-accent font-mono text-xs">plan #{plan.id}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none ${
          active ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
        }`}>
          {active ? 'Active' : 'Inactive'}
        </span>
        {plan.private && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full leading-none bg-info/15 text-info">Private</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={toggleStatus}
          disabled={busy}
          className={`btn text-xs py-1 px-2.5 shrink-0 disabled:opacity-40 ${active ? 'btn-secondary' : 'btn-primary'}`}
        >
          {busy ? '…' : active ? 'Deactivate' : 'Activate'}
        </button>
      </div>
      <div className="text-text-secondary text-xs mt-1.5 flex items-center gap-3">
        <span>{formatSize(plan.bytes)}</span>
        <span>{formatDays(plan.durationSeconds)}</span>
        <span className="text-text-primary">{planPrice(plan)}</span>
        {planUsd(plan, price) && <span className="text-text-tertiary">{planUsd(plan, price)}</span>}
      </div>
      <div className="text-text-tertiary text-[11px] mt-1 flex items-center gap-3">
        {stats ? (
          <>
            <span title="Nodes linked to this plan">
              {stats.nodes} node{stats.nodes === 1 ? '' : 's'}
            </span>
            <span title="Subscriptions ever bought for this plan (one account can hold several)">
              {stats.subscriptions} subscriber{stats.subscriptions === 1 ? '' : 's'}
            </span>
            <span
              className={stats.active > 0 ? 'text-success' : undefined}
              title={stats.truncated
                ? `At least ${stats.active} are active — this plan has too many subscriptions to count them all`
                : 'Subscriptions currently active'}
            >
              {stats.truncated ? `${stats.active}+` : stats.active} active
            </span>
          </>
        ) : (
          <span>{stats === null ? '— nodes · — subscribers' : 'counting…'}</span>
        )}
      </div>
      {error && <p className="text-danger text-xs mt-1.5">{displayConnectError(error)}</p>}
    </div>
  )
}

/**
 * Create a plan. It lands INACTIVE on chain — activation is a separate tx, offered
 * on the row once it appears — so nothing here needs to track a half-created plan.
 */
function CreatePlanForm({ price: tokenPrice, onCreated }: { price: TokenPrice | null; onCreated: () => void }) {
  const [gigabytes, setGigabytes] = useState('100')
  const [days, setDays] = useState('30')
  const [price, setPrice] = useState('10')
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const gb = Number(gigabytes)
  const dayCount = Number(days)
  const priceUdvpn = p2pToUdvpn(price)
  const valid =
    Number.isInteger(gb) && gb > 0 &&
    Number.isInteger(dayCount) && dayCount > 0 &&
    priceUdvpn !== null

  async function handleCreate() {
    if (!valid || priceUdvpn === null) return
    if (!confirm(
      `Create a plan for ${gb} GB over ${dayCount} days at ${formatUdvpn(priceUdvpn)}?\n\n` +
      `It is created inactive — you activate it afterwards. This is an on-chain transaction.`
    )) return
    setBusy(true)
    setError(null)
    try {
      await window.api.providerPlanCreate({ gigabytes: gb, days: dayCount, priceUdvpn, private: isPrivate })
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the plan')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-5 py-3 border-b border-border bg-bg-secondary space-y-2.5 shrink-0">
      <div className="grid grid-cols-3 gap-2">
        <NumField label="Size (GB)" value={gigabytes} onChange={setGigabytes} />
        <NumField label="Days" value={days} onChange={setDays} />
        <NumField label="Price (P2P)" value={price} onChange={setPrice} />
      </div>
      <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        Private (not listed for public discovery)
      </label>
      <p className="text-text-tertiary text-xs">
        {valid && priceUdvpn !== null
          ? `${gb} GB for ${dayCount} days · ${formatUdvpn(priceUdvpn)}` +
            (tokenPrice ? ` ≈ ${formatUsd(priceUdvpn, tokenPrice.usd)}` : '')
          : 'Size and days must be whole numbers; price accepts up to 6 decimals.'}
      </p>
      {error && <p className="text-danger text-xs">{displayConnectError(error)}</p>}
      <button
        type="button"
        onClick={handleCreate}
        disabled={!valid || busy}
        className="btn btn-primary text-xs py-1.5 w-full disabled:opacity-40"
      >
        {busy ? 'Creating…' : 'Create plan'}
      </button>
    </div>
  )
}

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-text-tertiary text-[10px] uppercase tracking-wide">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full bg-bg-tertiary border border-border text-text-primary text-xs px-2 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
      />
    </label>
  )
}
