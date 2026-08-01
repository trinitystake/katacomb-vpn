import { useCallback, useEffect, useState } from 'react'
import type { ProviderState } from '../../hooks/useProvider'
import { useProviderEconomics, type ProviderEconomicsState } from '../../hooks/useProviderEconomics'
import { useConnection } from '../../hooks/useConnection'
import { useRpcHealth } from '../../hooks/useRpcHealth'
import { isChainUnreachable } from '../../../shared/rpc-health'
import { displayConnectError } from '../../utils/connect-errors'
import type { ProviderDetailsInput } from '../../types'
import ChainUnreachable from '../ChainUnreachable'
import Spinner from '../Spinner'
import ProviderPlans from './ProviderPlans'

/** sentinel.types.v1.Status */
export const STATUS_ACTIVE = 1

export function formatUdvpn(udvpn: string | number): string {
  const n = typeof udvpn === 'number' ? udvpn : Number(udvpn)
  if (!isFinite(n)) return '—'
  if (n === 0) return 'free'
  return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} P2P`
}

/**
 * formatUdvpn for balances rather than prices.
 *
 * The "free" that formatUdvpn returns for zero is right for a plan price and wrong
 * for an amount: "Revenue: free" and "burn: free → 360 P2P" both read as nonsense.
 */
export function formatUdvpnAmount(udvpn: string | number): string {
  const n = typeof udvpn === 'number' ? udvpn : Number(udvpn)
  if (!isFinite(n)) return '—'
  return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} P2P`
}

/**
 * The dollar value of a udvpn amount, for display only — every figure that ends
 * up in a transaction stays in udvpn, priced from chain data. Sub-cent amounts
 * keep two significant digits instead of rounding to $0.00.
 */
export function formatUsd(udvpn: string | number, usdPerP2p: number): string {
  const p2p = (typeof udvpn === 'number' ? udvpn : Number(udvpn)) / 1e6
  if (!isFinite(p2p)) return ''
  const usd = p2p * usdPerP2p
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toPrecision(2)}`
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * The Provider tab.
 *
 * Renders whatever the chain currently says, and offers the single next action —
 * there is no local wizard state. The flows are multi-transaction (register →
 * activate, create → activate, lease → link) and each step is its own tx, so a
 * failure part-way through just leaves a row showing the step that still needs
 * doing rather than a stuck or orphaned state.
 */
export default function ProviderConsole({ provider, plans, leases, loading, error, refresh }: ProviderState) {
  const { status: connStatus } = useConnection()
  const { state: rpcState } = useRpcHealth()
  const tunnelUp = connStatus.state === 'connected' || connStatus.state === 'reconnecting'

  const economics = useProviderEconomics(provider?.registered ? provider.address : null, !tunnelUp)
  const { refresh: refreshEconomics } = economics
  // Leasing, ending a lease and selling a subscription all move these figures
  // without changing the provider record, so every action re-reads both.
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshEconomics()])
  }, [refresh, refreshEconomics])

  if (tunnelUp) {
    return (
      <Centered>
        <p className="text-text-secondary text-sm">
          Provider actions read and write the blockchain, which isn&apos;t reachable through your own tunnel.
        </p>
        <p className="text-text-tertiary text-xs mt-2">Disconnect the VPN to manage your provider.</p>
      </Centered>
    )
  }

  if (loading && !provider) {
    return (
      <Centered>
        <span className="text-text-secondary text-sm flex items-center gap-2">
          <Spinner />
          Reading your provider from the chain…
        </span>
      </Centered>
    )
  }

  if (!provider) {
    return (
      <Centered>
        {isChainUnreachable(rpcState)
          ? <ChainUnreachable what="your provider" />
          : <p className="text-danger text-sm">{displayConnectError(error ?? 'Could not read your provider')}</p>}
      </Centered>
    )
  }

  if (!provider.registered) {
    return <ProviderOnboarding address={provider.address} onRegistered={refresh} />
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ProviderHeader provider={provider} onChanged={refreshAll} />
      <EconomicsStrip state={economics} />
      <ProviderPlans
        plans={plans}
        leases={leases}
        providerActive={provider.status === STATUS_ACTIVE}
        economics={economics.economics}
        onChanged={refreshAll}
      />
    </div>
  )
}

/**
 * The money strip: what the leased nodes cost to keep, and what the plans have
 * brought in.
 *
 * There is deliberately no profit line. The chain deletes a lease once it ends, so
 * lifetime spend can't be reconstructed — subtracting the costs we *can* still see
 * from complete revenue would report a business as healthier than it is. Burn and
 * revenue are shown side by side and the break-even line on the plan form does the
 * comparison that is actually sound.
 */
function EconomicsStrip({ state }: { state: ProviderEconomicsState }) {
  const { economics, loading, unavailable } = state

  if (loading && !economics) {
    return (
      <StripShell>
        <span className="text-text-tertiary text-xs flex items-center gap-2">
          <Spinner /> Reading your economics…
        </span>
      </StripShell>
    )
  }

  if (unavailable || !economics) {
    return (
      <StripShell>
        <span className="text-text-tertiary text-xs">
          Economics unavailable — the chain couldn&apos;t be read just now.
        </span>
      </StripShell>
    )
  }

  const idle = economics.activeLeases === 0
  return (
    <StripShell>
      <div className="flex items-start gap-8 flex-wrap">
        <Stat
          label="Burn"
          value={idle ? 'None' : `${formatUdvpnAmount(economics.burnDailyUdvpn)} / day`}
          note={idle ? 'no nodes leased yet' : `${economics.activeLeases} lease${economics.activeLeases === 1 ? '' : 's'} running`}
        />
        <Stat
          label="Committed"
          value={idle ? 'None' : formatUdvpnAmount(economics.committedUdvpn)}
          note={idle ? 'nothing escrowed yet' : 'refunded if you end the leases'}
        />
        <Stat
          label="Revenue"
          value={economics.estimatedRevenueUdvpn === '0' ? 'None' : `≈ ${formatUdvpnAmount(economics.estimatedRevenueUdvpn)}`}
          note={`${economics.subscriptions} sold · estimate, net of the chain's cut`}
          title={
            'Subscriptions sold, times the plan price, less the share the hub keeps. ' +
            'A floor: renewals may charge again without creating a new subscription.'
          }
        />
      </div>
      <p className="text-text-tertiary text-[11px] mt-2">
        You pay nodes <span className="text-text-secondary">by the hour</span> whether or not anyone connects,
        but sell plans <span className="text-text-secondary">by the gigabyte</span>. Extra subscribers on nodes
        you already lease cost you nothing more — until those nodes run out of bandwidth.
      </p>
    </StripShell>
  )
}

function StripShell({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-3 border-b border-border bg-bg-secondary shrink-0">{children}</div>
}

function Stat({ label, value, note, title }: {
  label: string
  value: string
  note: string
  title?: string
}) {
  return (
    <div title={title}>
      <div className="text-text-tertiary text-[10px] uppercase tracking-wide">{label}</div>
      <div className="text-text-primary text-sm mt-0.5">{value}</div>
      <div className="text-text-tertiary text-[11px]">{note}</div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center px-8">
      <div className="max-w-md text-center">{children}</div>
    </div>
  )
}

const EMPTY_DETAILS: ProviderDetailsInput = { name: '', identity: '', website: '', description: '' }

/**
 * Pre-registration screen. Shows the deposit read live from the chain's own
 * params — it is a governance value (0 udvpn today), and unlike a node session
 * deposit it is sent to the community pool, so it is spent for good.
 */
function ProviderOnboarding({ address, onRegistered }: { address: string; onRegistered: () => void }) {
  const [details, setDetails] = useState<ProviderDetailsInput>(EMPTY_DETAILS)
  const [deposit, setDeposit] = useState<{ denom: string; amount: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.providerDeposit().then(setDeposit).catch(() => setDeposit(null))
  }, [])

  const depositLabel = deposit ? formatUdvpn(deposit.amount) : '…'

  async function handleRegister() {
    if (!details.name.trim()) {
      setError('Give your provider a name — it is what subscribers see next to your plans.')
      return
    }
    if (!confirm(
      `Register "${details.name.trim()}" as a provider?\n\n` +
      `Deposit: ${depositLabel} (plus network fee).\n` +
      `The deposit goes to the community pool and is NOT refundable.\n\n` +
      `This is an on-chain transaction.`
    )) return

    setBusy(true)
    setError(null)
    try {
      await window.api.providerRegister({ ...details, name: details.name.trim() })
      onRegistered()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <h2 className="text-text-primary text-lg font-semibold">Become a provider</h2>
          <p className="text-text-secondary text-sm mt-2">
            A provider publishes subscription plans on the Sentinel chain. Subscribers pay you for a plan;
            you cover them with bandwidth by leasing nodes and linking those nodes to the plan.
          </p>
        </div>

        <dl className="border border-border bg-bg-secondary rounded-md divide-y divide-border text-sm">
          <Row label="Your provider address">
            <span className="font-mono text-xs text-accent break-all">{address}</span>
          </Row>
          <Row label="Registration deposit">
            <span className="text-text-primary">{depositLabel}</span>
          </Row>
        </dl>

        <p className="text-text-tertiary text-xs">
          The provider address is your wallet address in provider form — the same key signs for both.
          The deposit is set by chain governance and is paid into the community pool, so it cannot be
          reclaimed by deactivating later.
        </p>

        <div className="space-y-3">
          <Field label="Name" value={details.name} placeholder="Shown next to your plans"
            onChange={(v) => setDetails({ ...details, name: v })} />
          <Field label="Website" value={details.website} placeholder="https://…"
            onChange={(v) => setDetails({ ...details, website: v })} />
          <Field label="Identity" value={details.identity} placeholder="Keybase identity (optional)"
            onChange={(v) => setDetails({ ...details, identity: v })} />
          <Field label="Description" value={details.description} placeholder="Optional"
            onChange={(v) => setDetails({ ...details, description: v })} />
        </div>

        {error && <p className="text-danger text-sm">{displayConnectError(error)}</p>}

        <button type="button" onClick={handleRegister} disabled={busy} className="btn btn-primary w-full disabled:opacity-40">
          {busy ? 'Registering…' : `Register provider (${depositLabel})`}
        </button>

        <p className="text-text-tertiary text-xs">
          You will be inactive right after registering — a second transaction activates you. Plans can only
          go live while the provider is active.
        </p>
      </div>
    </div>
  )
}

/** Registered-provider header: identity, status, and the activate/deactivate action. */
function ProviderHeader({ provider, onChanged }: { provider: { address: string; name: string; website: string; status: number }; onChanged: () => void }) {
  const active = provider.status === STATUS_ACTIVE
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setStatus = useCallback(async (next: boolean) => {
    if (!confirm(
      next
        ? 'Activate this provider?\n\nYour active plans become visible to subscribers. This is an on-chain transaction.'
        : 'Deactivate this provider?\n\nYour plans stop being offered. This is an on-chain transaction.'
    )) return
    setBusy(true)
    setError(null)
    try {
      await window.api.providerSetStatus(next)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status change failed')
    } finally {
      setBusy(false)
    }
  }, [onChanged])

  return (
    <div className="border-b border-border bg-bg-secondary px-5 py-3 shrink-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="text-text-primary text-sm font-medium truncate">{provider.name || 'Unnamed provider'}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none ${
              active ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
            }`}>
              {active ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div className="text-text-tertiary font-mono text-[11px] mt-0.5 truncate">{provider.address}</div>
        </div>
        <button
          type="button"
          onClick={() => setStatus(!active)}
          disabled={busy}
          className={`btn text-xs py-1.5 px-3 shrink-0 disabled:opacity-40 ${active ? 'btn-secondary' : 'btn-primary'}`}
          title={active ? 'Stop offering your plans' : 'Required before any plan can go live'}
        >
          {busy ? '…' : active ? 'Deactivate' : 'Activate'}
        </button>
      </div>
      {!active && (
        <p className="text-warning text-xs mt-2">
          Your provider is inactive — plans cannot be activated until you activate it.
        </p>
      )}
      {error && <p className="text-danger text-xs mt-2">{displayConnectError(error)}</p>}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="text-text-secondary shrink-0">{label}</dt>
      <dd className="text-right min-w-0">{children}</dd>
    </div>
  )
}

function Field({ label, value, placeholder, onChange }: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block">
      <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-bg-tertiary border border-border text-text-primary text-sm px-3 py-2 rounded-sm focus:outline-none focus:border-border-focus"
      />
    </label>
  )
}
