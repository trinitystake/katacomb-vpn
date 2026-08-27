import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LeaseSummary, MyPlan, PlanStats, ProviderEconomics, TokenPrice } from '../../types'
import { computeBreakEven, netOfStakingShare, parseDecShare } from '../../../shared/provider-economics'
import { isTestPlan } from '../../../shared/test-plan'
import { displayConnectError } from '../../utils/connect-errors'
import { useConfirm, type ConfirmOptions } from '../ConfirmModal'
import Spinner from '../Spinner'
import PlanNodesManager from './PlanNodesManager'
import { STATUS_ACTIVE, formatUdvpnAmount, formatUsd } from '../../utils/provider-format'

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

// formatUdvpnAmount, not formatUdvpn: on the provider's own row a zero price must
// read "0 P2P". "free" is the consumer catalog's word, and it sat oddly next to
// figures the provider chose.
function planPrice(plan: MyPlan): string {
  const udvpn = plan.prices.find((p) => p.denom === 'udvpn')
  return udvpn ? formatUdvpnAmount(udvpn.quoteValue) : '—'
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
function p2pToUdvpn(input: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim())
  if (!match) return null
  const frac = (match[2] ?? '').padEnd(6, '0')
  return Number(match[1]) * 1_000_000 + Number(frac)
}

interface Props {
  plans: MyPlan[]
  leases: LeaseSummary[]
  providerActive: boolean
  /** Cached data, chain unreachable: every mutation is disabled. */
  readOnly: boolean
  /** The provider's own name. Feeds the test-plan heuristic, which reads the NAME, not the plan. */
  providerName: string
  /** Null while unread — the pricing hints simply don't render rather than guess. */
  economics: ProviderEconomics | null
  /** Resolves once the chain has been re-read, so a caller can hold its busy state until then. */
  onChanged: () => Promise<void>
  /**
   * Total nodes CONFIRMED linked across all plans, for the setup path. null when
   * the counters could not be read for every plan — never a guessed zero.
   */
  onLinkedNodesCounted: (count: number | null) => void
}

export default function ProviderPlans({
  plans,
  leases,
  providerActive,
  readOnly,
  providerName,
  economics,
  onChanged,
  onLinkedNodesCounted,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const selected = plans.find((p) => p.id === selectedId) ?? null
  // ONE confirm dialog for the whole pane, threaded to the rows — each row used
  // to mount its own inside the clickable row div, one overlay per plan.
  const { requestConfirm, confirmDialog } = useConfirm()

  // Counters and the USD rate are extra chain/network reads, so they load after
  // the plans themselves and each row shows what it has. Keyed by the plan ids
  // as a string — the plans array is rebuilt on every refresh, its ids are not.
  // null until the first answer arrives; a per-plan null in the answer is a plan
  // the chain wouldn't answer for. statsFailed marks the whole batch failing.
  const [stats, setStats] = useState<Record<string, PlanStats | null> | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  const [price, setPrice] = useState<TokenPrice | null>(null)
  const planIds = plans.map((p) => p.id).join(',')

  const loadStats = useCallback(async () => {
    if (readOnly) {
      // The counters need the chain, which the tunnel blocks. Leaving them
      // unknown is honest; the rows say so instead of showing zeros.
      setStats(null)
      setStatsFailed(false)
      return
    }
    if (!planIds) {
      setStats({})
      setStatsFailed(false)
      return
    }
    try {
      setStats(await window.api.providerPlanStats(planIds.split(',')))
      setStatsFailed(false)
    } catch {
      setStatsFailed(true)
    }
  }, [planIds, readOnly])

  // Not `useEffect(loadStats, ...)`: an async callback returns a Promise, and an
  // effect may only return a cleanup function.
  useEffect(() => { void loadStats() }, [loadStats])

  useEffect(() => {
    window.api.priceToken().then(setPrice).catch(() => setPrice(null))
  }, [])

  // The setup path needs the linked total, CONFIRMED: every plan must have
  // answered, or the answer is null and the path shows "could not check".
  useEffect(() => {
    if (plans.length === 0) {
      onLinkedNodesCounted(0)
      return
    }
    if (!stats || statsFailed) {
      onLinkedNodesCounted(null)
      return
    }
    let total = 0
    for (const plan of plans) {
      const s = stats[plan.id]
      if (!s) {
        onLinkedNodesCounted(null)
        return
      }
      total += s.nodes
    }
    onLinkedNodesCounted(total)
  }, [plans, stats, statsFailed, onLinkedNodesCounted])

  // Linking a node or selling a subscription changes the counters without
  // changing the plan list, so every action re-reads both.
  //
  // Awaited, and that is the whole point: a button that clears its busy state
  // when the TX returns renders the pre-tx state for as long as the re-read takes,
  // so "Activate" reappears for a second before flipping to "Deactivate". Callers
  // await this, so the label goes straight from working to settled.
  const handleChanged = useCallback(async () => {
    await Promise.all([onChanged(), loadStats()])
  }, [onChanged, loadStats])

  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-[380px] border-r border-border flex flex-col min-h-0">
        <div className="flex items-center justify-between px-5 py-2.5 border-b border-border shrink-0">
          <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">
            Your plans ({plans.length})
          </span>
          <span className="flex items-center gap-2">
            {statsFailed && (
              <button
                type="button"
                onClick={() => void loadStats()}
                className="text-warning text-[11px] hover:underline"
                title="The per-plan counters could not be read. Click to try again."
              >
                counters unavailable, retry
              </button>
            )}
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              disabled={(!providerActive || readOnly) && !creating}
              className="btn btn-secondary text-xs py-1 px-2.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {creating ? 'Cancel' : 'New plan'}
            </button>
          </span>
        </div>

        {creating && (
          <CreatePlanForm
            price={price}
            economics={economics}
            requestConfirm={requestConfirm}
            onCreated={() => {
              setCreating(false)
              void handleChanged()
            }}
          />
        )}

        <div className="flex-1 overflow-y-auto">
          {plans.length === 0 && !creating && (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="text-text-primary text-sm font-medium">No plans yet</p>
              <p className="text-text-secondary text-xs max-w-[260px]">
                A plan is what subscribers buy: gigabytes over a period, at your price, served by the
                nodes you link to it.
              </p>
              {providerActive && !readOnly && (
                <button type="button" onClick={() => setCreating(true)} className="btn btn-primary text-xs py-1.5 px-4">
                  New plan
                </button>
              )}
            </div>
          )}
          {plans.map((plan) => (
            <PlanRow
              key={plan.id}
              plan={plan}
              stats={stats ? stats[plan.id] : readOnly ? null : undefined}
              statsUnknown={readOnly || statsFailed}
              price={price}
              selected={plan.id === selectedId}
              providerActive={providerActive}
              readOnly={readOnly}
              providerName={providerName}
              requestConfirm={requestConfirm}
              onSelect={() => setSelectedId(plan.id === selectedId ? null : plan.id)}
              onChanged={handleChanged}
            />
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        {selected ? (
          <PlanNodesManager
            plan={selected}
            leases={leases}
            price={price}
            economics={economics}
            providerActive={providerActive}
            readOnly={readOnly}
            onChanged={handleChanged}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-text-primary text-sm font-medium">
              {plans.length === 0 ? 'Nothing to manage yet' : 'Select a plan'}
            </p>
            <p className="text-text-tertiary text-xs max-w-sm">
              {plans.length === 0
                ? 'Once a plan exists, this pane is where you lease nodes and link them to it.'
                : 'Pick a plan on the left to manage the nodes that serve it.'}
            </p>
          </div>
        )}
      </div>
      {confirmDialog}
    </div>
  )
}

function PlanRow({
  plan,
  stats,
  statsUnknown,
  price,
  selected,
  providerActive,
  readOnly,
  providerName,
  requestConfirm,
  onSelect,
  onChanged,
}: {
  plan: MyPlan
  /** undefined while the counters are still being read, null if they couldn't be. */
  stats: PlanStats | null | undefined
  /** True when no counter for this batch is trustworthy (cached data or a failed read). */
  statsUnknown: boolean
  price: TokenPrice | null
  selected: boolean
  providerActive: boolean
  readOnly: boolean
  providerName: string
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  onSelect: () => void
  onChanged: () => Promise<void>
}) {
  const active = plan.status === STATUS_ACTIVE
  // Which action is running AND what it is moving to, not merely that one is.
  //
  // Two reasons it carries both. The row has two buttons, and a shared boolean
  // put the spinner on whichever one you did not click. And `plan` is live chain
  // data that changes UNDER these buttons: `onChanged()` calls setData while it
  // runs and the busy flag only clears a microtask later, so there is a render
  // showing the NEW value with the spinner still going. Reading a label off
  // `plan` there made a freshly activated plan say "Deactivating…" mid-spin.
  // While an action is in flight both buttons describe the ACTION and hold their
  // pre-action appearance, so each settles in one visible step.
  const [busy, setBusy] = useState<{ kind: 'status' | 'private'; target: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const anyBusy = busy !== null
  // Pre-action values are the opposite of what each action is moving to.
  const showActive = busy?.kind === 'status' ? !busy.target : active
  const showPrivate = busy?.kind === 'private' ? !busy.target : plan.private
  // Activating needs an active provider (the chain refuses otherwise);
  // deactivating does not. Both need the chain reachable.
  const statusBlocked = readOnly || anyBusy || (!active && !providerActive)

  /**
   * Flip the plan between public and private.
   *
   * Only possible because provider-msgs registers MsgUpdatePlanDetails itself:
   * the SDK omits it, which made `private` a create-once decision. The chain
   * imposes no status precondition, so this works on a live plan.
   */
  async function togglePrivate() {
    const next = !plan.private
    if (!(await requestConfirm({
      title: next ? `Make plan #${plan.id} private?` : `Make plan #${plan.id} public?`,
      body: [
        next
          ? 'It stays active and existing subscriptions are unaffected, but it drops out of the catalog for anyone who has not chosen to show private plans.'
          : 'It appears in the catalog for every subscriber browsing plans.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: next ? 'Make private' : 'Make public',
    }))) return
    setBusy({ kind: 'private', target: next })
    setError(null)
    try {
      await window.api.providerPlanSetPrivate(plan.id, next)
      // Awaited so the badge stays busy through the re-read and never flashes
      // the old value back on the way to the new one.
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the plan visibility')
    } finally {
      setBusy(null)
    }
  }

  async function toggleStatus() {
    if (!(await requestConfirm(
      active
        ? {
            title: `Deactivate plan #${plan.id}?`,
            body: ['It stops being offered to new subscribers. This is an on-chain transaction.'],
            confirmLabel: 'Deactivate',
            danger: true,
          }
        : {
            title: `Activate plan #${plan.id}?`,
            body: activateBody(plan, stats, providerName),
            confirmLabel: 'Activate',
          },
    ))) return
    setBusy({ kind: 'status', target: !active })
    setError(null)
    try {
      await window.api.providerPlanSetStatus(plan.id, !active)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className={`border-b border-border transition-colors ${selected ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}
    >
      <div className="flex items-stretch">
        {/* The selectable body is a real button, so the row works from the keyboard;
            the action cluster sits beside it rather than nested inside it. */}
        <button type="button" onClick={onSelect} className="flex-1 min-w-0 text-left px-5 py-3 cursor-pointer">
          <div className="flex items-center gap-2.5">
            <span className="text-accent font-mono text-xs">plan #{plan.id}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none ${
              active ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
            }`}>
              {active ? 'Active' : 'Inactive'}
            </span>
            {plan.private && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full leading-none bg-info/15 text-info">
                Private
              </span>
            )}
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
                    ? `At least ${stats.active} are active: this plan has too many subscriptions to count them all`
                    : 'Subscriptions currently active'}
                >
                  {stats.truncated ? `${stats.active}+` : stats.active} active
                </span>
              </>
            ) : (
              <span>
                {stats === null || statsUnknown ? 'counters not readable right now' : 'counting…'}
              </span>
            )}
          </div>
          {error && <p className="text-danger text-xs mt-1.5">{displayConnectError(error)}</p>}
        </button>

        <div className="flex flex-col items-end justify-center gap-1.5 pr-5 py-3 shrink-0">
          {/* min-w holds the busy label's width, so swapping to the gerund doesn't shove the row. */}
          <button
            type="button"
            onClick={toggleStatus}
            disabled={statusBlocked}
            title={
              readOnly
                ? 'The chain is not reachable while the VPN is connected'
                : !active && !providerActive
                  ? 'Activate your provider first'
                  : undefined
            }
            className={`btn text-xs py-1 px-2.5 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 min-w-[128px] ${
              showActive ? 'btn-secondary' : 'btn-primary'
            }`}
          >
            {busy?.kind === 'status' && <Spinner size="sm" />}
            {busy?.kind === 'status'
              ? (busy.target ? 'Activating…' : 'Deactivating…')
              : (active ? 'Deactivate' : 'Activate')}
          </button>
          <button
            type="button"
            onClick={togglePrivate}
            disabled={anyBusy || readOnly}
            className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none shrink-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1 ${
              showPrivate ? 'bg-info/15 text-info hover:bg-info/25' : 'bg-bg-tertiary text-text-tertiary hover:text-text-secondary'
            }`}
            title={
              plan.private
                ? 'Private: hidden from the catalog unless a subscriber opts to show private plans. Click to make it public.'
                : 'Public: listed in the catalog. Click to make it private.'
            }
          >
            {busy?.kind === 'private' && <Spinner size="sm" />}
            {showPrivate ? 'Make public' : 'Make private'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Create a plan. It lands INACTIVE on chain — activation is a separate tx, offered
 * on the row once it appears — so nothing here needs to track a half-created plan.
 */
function CreatePlanForm({ price: tokenPrice, economics, requestConfirm, onCreated }: {
  price: TokenPrice | null
  economics: ProviderEconomics | null
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  onCreated: () => void
}) {
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

  // How many subscribers this price would need to cover the running lease burn.
  // Advisory only — it never gates the button, because pricing below cost to win
  // subscribers is a legitimate strategy, not a mistake to be blocked.
  const breakEven = useMemo(() => {
    if (!economics || priceUdvpn === null || !Number.isInteger(dayCount) || dayCount <= 0) return null
    const net = netOfStakingShare(String(priceUdvpn), parseDecShare(economics.subscriptionStakingShare))
    return {
      net,
      burnDailyUdvpn: economics.burnDailyUdvpn,
      result: computeBreakEven({
        dailyBurnUdvpn: economics.burnDailyUdvpn,
        netPricePerSubUdvpn: net,
        durationDays: dayCount,
      }),
    }
  }, [economics, priceUdvpn, dayCount])

  async function handleCreate() {
    if (!valid || priceUdvpn === null) return
    if (!(await requestConfirm({
      title: `Create a plan for ${gb} GB over ${dayCount} days at ${formatUdvpnAmount(priceUdvpn)}?`,
      body: ['It is created inactive, and you activate it afterwards. This is an on-chain transaction.'],
      confirmLabel: 'Create plan',
    }))) return
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
          ? `${gb} GB for ${dayCount} days · ${formatUdvpnAmount(priceUdvpn)}` +
            (tokenPrice ? ` ≈ ${formatUsd(priceUdvpn, tokenPrice.usd)}` : '')
          : 'Size and days must be whole numbers; price accepts up to 6 decimals.'}
      </p>
      {valid && breakEven && <BreakEvenHint {...breakEven} />}
      {error && <p className="text-danger text-xs">{displayConnectError(error)}</p>}
      <button
        type="button"
        onClick={handleCreate}
        disabled={!valid || busy}
        className="btn btn-primary text-xs py-1.5 w-full disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? 'Creating…' : 'Create plan'}
      </button>
    </div>
  )
}

/**
 * What activating this plan is about to mean, in full.
 *
 * Two separate questions get conflated here, so the copy keeps them apart:
 *
 * 1. What the CHAIN does. MsgUpdatePlanStatus checks ownership and that the
 *    PROVIDER is active, and nothing else, because linking nodes is a separate
 *    message with its own lease precondition. So an empty plan can go live and be
 *    sold with nothing to serve the buyer. Worth saying out loud, not worth
 *    blocking, the same line BreakEvenHint draws.
 * 2. Whether anyone will FIND it. That is the consumer catalog's business, and
 *    three of its filters can hide a freshly activated plan, two of which are
 *    invisible from this tab. `private` is a real chain flag; "Test plans" is this
 *    app's own guess from the PROVIDER NAME (shared/test-plan.ts), which surprises
 *    anyone who called their provider something with "test" in it; and
 *    "Ready to connect" (on by default) drops any plan counted at zero nodes.
 *
 * The zero node count has to be CONFIRMED. `stats` is undefined while the counters
 * load and null when the chain read failed, and neither means "no nodes" — warning
 * on those would put a false accusation in front of the one action the provider
 * came here to take.
 */
function activateBody(plan: MyPlan, stats: PlanStats | null | undefined, providerName: string): string[] {
  // Optional chaining IS the confirmed-zero test: undefined (loading) and null
  // (read failed) both compare false against 0.
  const nodeless = stats?.nodes === 0
  const looksLikeTest = isTestPlan(providerName)
  const hidden = plan.private || looksLikeTest || nodeless

  const body = [
    hidden
      ? 'The chain will let subscribers buy it. Whether they can find it is a separate matter, and right now this app keeps it out of the default catalog view:'
      : 'It appears in the plan catalog and subscribers can buy it.',
  ]

  if (plan.private) {
    body.push(
      'It is private, so only subscribers who tick the "Private" filter will see it. That flag is on chain, so other Sentinel clients should honour it too.',
    )
  }
  if (looksLikeTest) {
    body.push(
      `This app reads your provider name ("${providerName}") as a test account, so it files the plan under "Test plans" and hides it by default. That is a local guess from the name, not anything the chain records.`,
    )
  }
  if (nodeless) {
    body.push(
      'It has no nodes linked, so anyone who does buy it has nothing to connect to, and the default "Ready to connect" filter drops it. You can lease and link nodes afterwards without deactivating.',
    )
  }

  body.push('This is an on-chain transaction.')
  return body
}

/**
 * Translates the plan price into the number of subscribers that would cover the
 * lease burn — the one figure connecting the two halves of the business, since
 * nodes bill by time and plans sell by allocation.
 *
 * Advisory: nothing here disables the Create button. A provider may knowingly price
 * below cost to win subscribers, and the app has no business overruling that.
 */
function BreakEvenHint({ net, burnDailyUdvpn, result }: {
  net: string
  burnDailyUdvpn: string
  result: ReturnType<typeof computeBreakEven>
}) {
  // No leases yet, so there is no burn to break even against. Nothing is wrong and
  // nothing is blocked, so this states the next steps rather than warning: the node
  // picker lives inside the plan's own pane, which does not exist until the plan does.
  if (result.kind === 'no-burn') {
    return (
      <p className="text-text-tertiary text-xs">
        Nothing to break even against yet, because you have no nodes leased. Create this plan first,
        then select it to lease and link a node, and activate it once something can serve it.
      </p>
    )
  }

  if (result.kind === 'never') {
    return (
      <p className="text-warning text-xs">
        At this price you keep nothing per subscription, so this plan can never cover the{' '}
        {formatUdvpnAmount(burnDailyUdvpn)}/day your nodes cost. That is allowed, just make sure it&apos;s deliberate.
      </p>
    )
  }

  return (
    <p className="text-text-tertiary text-xs">
      Your nodes cost <span className="text-text-secondary">{formatUdvpnAmount(burnDailyUdvpn)}/day</span>. You keep{' '}
      <span className="text-text-secondary">{formatUdvpnAmount(net)}</span> per subscription after the chain&apos;s cut,
      so this plan breaks even at{' '}
      <span className="text-text-primary">
        ~{result.count.toLocaleString('en-US')} active subscriber{result.count === 1 ? '' : 's'}
      </span>.
    </p>
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
