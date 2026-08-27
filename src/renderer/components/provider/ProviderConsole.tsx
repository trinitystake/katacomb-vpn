import { useCallback, useEffect, useState } from 'react'
import type { ProviderState } from '../../hooks/useProvider'
import { useConnection } from '../../hooks/useConnection'
import { useRpcHealth } from '../../hooks/useRpcHealth'
import { isChainUnreachable } from '../../../shared/rpc-health'
import { providerDetailsProblem } from '../../../shared/provider-details'
import { displayConnectError } from '../../utils/connect-errors'
import { STATUS_ACTIVE, formatUdvpn, formatUdvpnAmount } from '../../utils/provider-format'
import { providerSetupSteps, setupComplete, type SetupStep } from '../../utils/provider-setup'
import type { ProviderDetailsInput, ProviderEconomics } from '../../types'
import ChainUnreachable from '../ChainUnreachable'
import { useConfirm } from '../ConfirmModal'
import InfoTip from '../InfoTip'
import Spinner from '../Spinner'
import ProviderDetailsFields from './ProviderDetailsFields'
import ProviderIdentityCard from './ProviderIdentityCard'
import ProviderPlans from './ProviderPlans'

/**
 * The Provider tab.
 *
 * Renders whatever the chain currently says, and offers the single next action —
 * there is no local wizard state. The flows are multi-transaction (register →
 * activate, create → activate, lease → link) and each step is its own tx, so a
 * failure part-way through just leaves a row showing the step that still needs
 * doing rather than a stuck or orphaned state. The setup path strip is the same
 * idea made visible: derived from chain state on every render, never stored.
 *
 * While the VPN tunnel is up the tab renders main's cached overview read-only
 * (`stale`), with every mutation disabled — the chain is unreachable through our
 * own tunnel, so writes would only fail late.
 */
export default function ProviderConsole({
  provider,
  plans,
  leases,
  economics,
  stale,
  fetchedAt,
  loading,
  error,
  refresh,
}: ProviderState) {
  const { status: connStatus } = useConnection()
  const { state: rpcState } = useRpcHealth()
  const tunnelUp = connStatus.state === 'connected' || connStatus.state === 'reconnecting'
  // stale marks the DATA; tunnelUp closes the gap before the stale re-read lands.
  const readOnly = stale || tunnelUp

  // Per-plan linked-node counters live in ProviderPlans, but the setup path needs
  // their total, so the confirmed count is lifted here. null = not confirmed.
  const [confirmedLinkedNodes, setConfirmedLinkedNodes] = useState<number | null>(null)

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
    if (tunnelUp) {
      return (
        <Centered>
          <p className="text-text-secondary text-sm">
            The blockchain is not reachable through your own tunnel, and there is no cached copy of
            your provider from this session yet.
          </p>
          <p className="text-text-tertiary text-xs mt-2">Disconnect the VPN to manage your provider.</p>
        </Centered>
      )
    }
    return (
      <Centered>
        {isChainUnreachable(rpcState)
          ? <ChainUnreachable what="your provider" />
          : (
            <div className="space-y-3">
              <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2 text-left">
                <p className="text-danger text-xs">{displayConnectError(error ?? 'Could not read your provider')}</p>
              </div>
              <button type="button" onClick={() => void refresh()} className="btn btn-secondary text-xs py-1.5 px-4">
                Retry
              </button>
            </div>
          )}
      </Centered>
    )
  }

  const active = provider.status === STATUS_ACTIVE
  const steps = providerSetupSteps({
    registered: provider.registered,
    active,
    planCount: plans.length,
    activePlanCount: plans.filter((p) => p.status === STATUS_ACTIVE).length,
    leaseCount: leases.length,
    confirmedLinkedNodes,
  })

  if (!provider.registered) {
    return <ProviderOnboarding address={provider.address} steps={steps} readOnly={readOnly} onRegistered={refresh} />
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ProviderIdentityCard
        provider={provider}
        plans={plans}
        leases={leases}
        stale={readOnly}
        fetchedAt={fetchedAt}
        onRefresh={refresh}
        onChanged={refresh}
      />
      <EconomicsTiles economics={economics} onRetry={refresh} stale={readOnly} />
      {readOnly ? (
        <Banner>
          Showing cached data: the chain is not reachable while the VPN is connected. Reads stay
          available, actions need you to disconnect first.
        </Banner>
      ) : !active ? (
        <Banner>
          Your provider is inactive, so the chain refuses new plans, plan activations and leases.
          Activate to change any of that.
        </Banner>
      ) : null}
      {!readOnly && !setupComplete(steps) && <SetupPath steps={steps} />}
      <ProviderPlans
        plans={plans}
        leases={leases}
        providerActive={active}
        readOnly={readOnly}
        providerName={provider.name}
        economics={economics}
        onChanged={refresh}
        onLinkedNodesCounted={setConfirmedLinkedNodes}
      />
    </div>
  )
}

/**
 * The money band: what the leased nodes cost to keep, and what the plans have
 * brought in.
 *
 * There is deliberately no profit line. The chain deletes a lease once it ends, so
 * lifetime spend can't be reconstructed — subtracting the costs we *can* still see
 * from complete revenue would report a business as healthier than it is. Burn and
 * revenue are shown side by side and the break-even line on the plan form does the
 * comparison that is actually sound.
 */
function EconomicsTiles({ economics, onRetry, stale }: {
  economics: ProviderEconomics | null
  onRetry: () => Promise<void>
  stale: boolean
}) {
  if (!economics) {
    return (
      <div className="px-5 py-3 border-b border-border bg-bg-secondary shrink-0 flex items-center gap-3">
        <div className="bg-warning/10 border border-warning/40 rounded-md px-3 py-1.5">
          <p className="text-warning text-xs">The money figures could not be read from the chain just now.</p>
        </div>
        {!stale && (
          <button type="button" onClick={() => void onRetry()} className="btn btn-secondary text-xs py-1 px-2.5">
            Retry
          </button>
        )}
      </div>
    )
  }

  const idle = economics.activeLeases === 0
  return (
    <div className="px-5 py-3 border-b border-border bg-bg-secondary shrink-0">
      <div className="flex items-start gap-8 flex-wrap">
        <Tile
          label="Burn"
          value={idle ? 'None' : `${formatUdvpnAmount(economics.burnDailyUdvpn)} / day`}
          note={idle ? 'no nodes leased yet' : `${economics.activeLeases} lease${economics.activeLeases === 1 ? '' : 's'} running`}
        />
        <Tile
          label="Committed"
          value={idle ? 'None' : formatUdvpnAmount(economics.committedUdvpn)}
          note={idle ? 'nothing escrowed yet' : 'refunded if you end the leases'}
        />
        <Tile
          label="Revenue"
          value={economics.estimatedRevenueUdvpn === '0' ? 'None' : `≈ ${formatUdvpnAmount(economics.estimatedRevenueUdvpn)}`}
          note={`${economics.subscriptions} subscription${economics.subscriptions === 1 ? '' : 's'} sold`}
        />
        <span className="ml-auto self-start">
          <InfoTip label="how these figures are computed">
            Revenue is subscriptions sold, times the plan price, less the share the chain keeps. It is
            a floor: renewals may charge again without creating a new subscription. You pay nodes by
            the hour whether or not anyone connects, but sell plans by the gigabyte, so extra
            subscribers on nodes you already lease cost you nothing more until the nodes run out of
            bandwidth.
          </InfoTip>
        </span>
      </div>
    </div>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">{label}</div>
      <div className="text-text-primary text-lg leading-snug">{value}</div>
      <div className="text-text-tertiary text-[11px]">{note}</div>
    </div>
  )
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-2 border-b border-border bg-warning/10 shrink-0">
      <p className="text-warning text-xs">{children}</p>
    </div>
  )
}

/**
 * The provider lifecycle as the chain sees it, one glyph per step. Recomputed
 * from chain state on every render and shown only while incomplete — this is the
 * guided flow, without any stored progress to get out of sync.
 */
function SetupPath({ steps }: { steps: SetupStep[] }) {
  const next = steps.find((s) => s.state === 'next')
  return (
    <div className="px-5 py-2 border-b border-border bg-bg-secondary shrink-0">
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <span className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Setup</span>
        {steps.map((step) => (
          <span key={step.key} className="flex items-center gap-1.5 text-xs" title={step.detail}>
            <StepGlyph state={step.state} />
            <span
              className={
                step.state === 'next'
                  ? 'text-text-primary font-medium'
                  : step.state === 'done'
                    ? 'text-text-tertiary'
                    : 'text-text-tertiary/70'
              }
            >
              {step.label}
            </span>
          </span>
        ))}
      </div>
      {next && <p className="text-text-tertiary text-[11px] mt-1">{next.detail}</p>}
    </div>
  )
}

function StepGlyph({ state }: { state: SetupStep['state'] }) {
  if (state === 'done') return <span className="text-success text-[11px] leading-none">✓</span>
  if (state === 'next') return <span className="status-dot status-dot-pending" />
  if (state === 'unknown') return <span className="text-text-tertiary text-[11px] leading-none">?</span>
  return <span className="w-1.5 h-1.5 rounded-full border border-border inline-block" />
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center px-8">
      <div className="max-w-md text-center">{children}</div>
    </div>
  )
}

const EMPTY_DETAILS: ProviderDetailsInput = { name: '', identity: '', website: '', description: '' }

type DepositState = 'loading' | 'failed' | { denom: string; amount: string }

/**
 * Pre-registration screen. Shows the deposit read live from the chain's own
 * params — it is a governance value (0 udvpn today), and unlike a node session
 * deposit it is sent to the community pool, so it is spent for good.
 *
 * Registration is refused until the deposit has actually been read: a money
 * confirmation must never show "Deposit: …" with the figure missing.
 */
function ProviderOnboarding({ address, steps, readOnly, onRegistered }: {
  address: string
  steps: SetupStep[]
  readOnly: boolean
  onRegistered: () => void
}) {
  const [details, setDetails] = useState<ProviderDetailsInput>(EMPTY_DETAILS)
  const [deposit, setDeposit] = useState<DepositState>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  const loadDeposit = useCallback(() => {
    setDeposit('loading')
    // providerDeposit answers null while the VPN is up; both that and a rejection
    // land on 'failed', which blocks the register button rather than pricing the
    // registration as free or as an ellipsis.
    window.api.providerDeposit()
      .then((d) => setDeposit(d ?? 'failed'))
      .catch(() => setDeposit('failed'))
  }, [])

  useEffect(() => {
    loadDeposit()
  }, [loadDeposit])

  const depositKnown = typeof deposit === 'object'
  const depositLabel = depositKnown ? formatUdvpn(deposit.amount) : deposit === 'loading' ? '…' : 'unavailable'
  // Same rule the chain applies, so a name that is 64 characters but 80 bytes
  // fails here instead of after the deposit is spent.
  const problem = providerDetailsProblem(details, { requireName: true })

  async function handleRegister() {
    if (!depositKnown) return
    if (problem) {
      setError(problem)
      return
    }
    if (!(await requestConfirm({
      title: `Register "${details.name.trim()}" as a provider?`,
      body: [
        `Deposit: ${depositLabel} (plus network fee). The deposit goes to the community pool and is NOT refundable.`,
        'You will land inactive: a second transaction activates you, and until then the chain refuses to create plans or start leases.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'Register',
    }))) return

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

        <SetupPath steps={steps} />

        {readOnly && (
          <div className="bg-warning/10 border border-warning/40 rounded-md px-3 py-2">
            <p className="text-warning text-xs">
              Registering needs the chain, which is not reachable while the VPN is connected. Disconnect first.
            </p>
          </div>
        )}

        <dl className="border border-border bg-bg-secondary rounded-md divide-y divide-border text-sm">
          <Row label="Your provider address">
            <span className="font-mono text-xs text-accent break-all">{address}</span>
          </Row>
          <Row label="Registration deposit">
            <span className="text-text-primary">{depositLabel}</span>
          </Row>
        </dl>

        {deposit === 'failed' && (
          <div className="flex items-center gap-3">
            <div className="bg-danger-subtle border border-danger rounded-md px-3 py-1.5 flex-1">
              <p className="text-danger text-xs">
                The registration deposit could not be read from the chain, so registering is disabled.
              </p>
            </div>
            <button type="button" onClick={loadDeposit} className="btn btn-secondary text-xs py-1.5 px-3">
              Retry
            </button>
          </div>
        )}

        <p className="text-text-tertiary text-xs">
          The provider address is your wallet address in provider form, and the same key signs for both.
          The deposit is set by chain governance and is paid into the community pool, so it cannot be
          reclaimed by deactivating later. There is no way to remove a provider from the chain once it
          exists, so registering is a one-way step.
        </p>

        <ProviderDetailsFields details={details} onChange={setDetails} disabled={busy} />

        {error && (
          <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
            <p className="text-danger text-xs">{displayConnectError(error)}</p>
          </div>
        )}

        <button
          type="button"
          onClick={handleRegister}
          disabled={busy || Boolean(problem) || !depositKnown || readOnly}
          className="btn btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
          title={problem ?? undefined}
        >
          {busy ? 'Registering…' : depositKnown ? `Register provider (${depositLabel})` : 'Register provider'}
        </button>

        <p className="text-text-tertiary text-xs">
          You will be inactive right after registering: a second transaction activates you. Plans can only
          go live while the provider is active.
        </p>
      </div>
      {confirmDialog}
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
