import { useEffect, useMemo, useState } from 'react'
import type { SentNode, TunnelProtocol, WalletEntry } from '../types'
import { useNodesContext } from '../contexts/NodesContext'
import { useBalance } from '../hooks/useBalance'
import { useConnection } from '../hooks/useConnection'
import { useChainEligibility } from '../hooks/useChainEligibility'
import { chainDiversityIssues, hasOperatorOverlap } from '../utils/chain-diversity'
import { checkFunds, formatP2p, insufficientFundsMessage } from '../../shared/funds'
import { protocolMeta } from '../utils/protocols'
import { COUNTRY_CODES } from '../utils/country-codes'
import ConnectErrorActions from './ConnectErrorActions'
import InsufficientFunds from './InsufficientFunds'
import ProgressSteps from './ProgressSteps'
import Spinner from './Spinner'

interface Props {
  onClose: () => void
}

type Step = 'entry' | 'exit' | 'confirm'
type BillingType = 'gigabytes' | 'hours'

/**
 * Rows rendered before the list asks you to narrow the search. Set above the number
 * of nodes that can actually serve as an exit (138 of 726 healthy V2Ray/XRAY nodes,
 * measured 2026-08-14) so that every verified exit is reachable by scrolling. At 50
 * it was not: the list is sorted cheapest-first within each rank, so a verified exit
 * priced above the 50th row simply did not exist as far as the UI was concerned.
 */
const MAX_ROWS = 300

/**
 * How long the filter must hold still before its nodes are graded. Long enough that
 * typing a city name is one sweep rather than one per letter, short enough that
 * choosing a country feels immediate.
 */
const PROBE_SETTLE_MS = 250

/**
 * Only v9.0.0 nodes publish the inbound listing the chain checks read, so they sort
 * first. Otherwise the list opens on the cheapest nodes, which are the oldest, every
 * row reads "unknown" and the check looks broken.
 *
 * Older nodes stay LISTED but are not selectable (see the row's `refused`): with no
 * listing to check, they cannot be graded before paying, and 485 of the 487 measured
 * report no TLS at all, so picking one is a near-certain double refund rather than a
 * gamble worth offering. Showing them is still worth it, so the list explains itself
 * instead of silently hiding most of the network.
 */
function majorVersion(node: SentNode): number {
  return parseInt((node.version || '').split('.')[0], 10) || 0
}

function udvpnPrice(node: SentNode, type: BillingType): number | null {
  const prices = type === 'gigabytes' ? node.gigabytePrices : node.hourlyPrices
  const p = prices?.find((x) => x.denom === 'udvpn')
  if (!p) return null
  const value = parseInt(p.value, 10)
  return Number.isFinite(value) ? value : null
}

/**
 * Buy and connect a two-hop chain: this host -> entry -> exit -> internet.
 *
 * Deliberately a separate flow rather than a mode of ConnectionModal, which is
 * built around one `node` prop throughout (pricing, plan reuse, the already-on-this-
 * node guard). Chains have none of that: no plans, no allocations, two purchases in
 * one transaction sequence, and an eligibility rule that differs per END.
 */
export default function MultihopModal({ onClose }: Props) {
  const { allNodes } = useNodesContext()
  const { status, disconnect: disconnectVpn } = useConnection()
  const { udvpn, display: balance, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  const eligibility = useChainEligibility()

  const [step, setStep] = useState<Step>('entry')
  const [entry, setEntry] = useState<SentNode | null>(null)
  const [exit, setExit] = useState<SentNode | null>(null)
  const [billing, setBilling] = useState<BillingType>('gigabytes')
  const [amount, setAmount] = useState(1)
  const [mode, setMode] = useState<'tunnel' | 'proxy'>('tunnel')
  const [acknowledged, setAcknowledged] = useState(false)
  const [overrideDiversity, setOverrideDiversity] = useState(false)
  // Which wallet pays for the EXIT hop. '' = the active one, i.e. both hops on one
  // account, which is what every chain did before per-hop wallets existed.
  const [exitWalletId, setExitWalletId] = useState('')
  const [wallets, setWallets] = useState<WalletEntry[]>([])
  const [activeAddress, setActiveAddress] = useState<string | null>(null)
  // Whether the chosen exit wallet is visibly funded from the active one. null =
  // not asked yet or asking.
  const [walletLink, setWalletLink] = useState<{ checked: boolean; linked: boolean } | null>(null)

  // DNS is the one leak a chain cannot close by itself: with the resolver left on
  // System Default and no kill switch, queries go to the LAN resolver, which is more
  // specific than tun2socks' /1 halves and so never enters the tunnel. Read it here so
  // the confirm step can say so before the money moves.
  const [dnsResolver, setDnsResolver] = useState<string | null>(null)
  const [dnsBusy, setDnsBusy] = useState(false)

  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [currentDetail, setCurrentDetail] = useState<string | null>(null)
  const [hopMarker, setHopMarker] = useState<HopMarker | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState<{ entrySessionId: string; exitSessionId: string } | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const alreadyConnected = status.state === 'connected' || status.state === 'reconnecting'
  // Both purchases and handshakes are done once the modal moves to the bring-up.
  const tunnelStarted = currentStep === '5/5'

  useEffect(() => {
    // `hop:<role>:<phase>` are markers, not steps: a chain runs the purchase sequence
    // twice, and without them the shared 1/5..3/5 list replays from the start halfway
    // through and looks like the connect restarted. The PHASE matters as much as the
    // role: the entry is bought AND handshaked before the exit is touched at all, since
    // the exit is reached through it (see MARKER_SEQUENCE).
    const unsub = window.api.onConnectionProgress((step, detail) => {
      if (step.startsWith('hop:')) {
        const marker = parseHopMarker(step)
        if (marker) setHopMarker(marker)
        return
      }
      setCurrentStep(step)
      setCurrentDetail(detail || null)
    })
    return unsub
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.settingsGet()
      .then((s) => { if (!cancelled) setDnsResolver(s.dnsResolver) })
      .catch(() => { /* the warning simply doesn't render */ })
    return () => { cancelled = true }
  }, [])

  // Ask the chain whether the two accounts are already tied together by a transfer.
  // Without this the "funded independently" caveat is a sentence the user skims and
  // then defeats in the obvious way — topping the second wallet up from the first.
  useEffect(() => {
    if (!exitWalletId) { setWalletLink(null); return }
    let cancelled = false
    setWalletLink(null)
    window.api.walletLinkCheck(exitWalletId)
      .then((r) => { if (!cancelled) setWalletLink(r) })
      .catch(() => { if (!cancelled) setWalletLink({ checked: false, linked: false }) })
    return () => { cancelled = true }
  }, [exitWalletId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [list, addr] = await Promise.all([window.api.walletList(), window.api.walletGetAddress()])
        if (cancelled) return
        setWallets(list)
        setActiveAddress(addr)
      } catch {
        if (!cancelled) setWallets([])
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Only v2ray/xray can be chained at all: proxySettings.tag is a v2ray-core
  // feature and no other protocol in this client has an equivalent.
  const chainable = useMemo(
    () => allNodes.filter((n) => (n.type === 2 || n.type === 4) && n.isActive && n.isHealthy),
    [allNodes],
  )

  const entryPrice = entry ? udvpnPrice(entry, billing) : null
  const exitPrice = exit ? udvpnPrice(exit, billing) : null
  const costUdvpn = (entryPrice ?? 0) * amount + (exitPrice ?? 0) * amount
  const priceMissing = (entry !== null && entryPrice === null) || (exit !== null && exitPrice === null)
  const funds = udvpn === null ? null : checkFunds(udvpn, costUdvpn)
  const cantAfford = funds !== null && !funds.ok

  const issues = entry && exit ? chainDiversityIssues(entry, exit) : []
  const operatorOverlap = hasOperatorOverlap(issues)
  const exitGrade = exit ? eligibility.results.get(exit.address) : undefined
  // Block only on a definite No. "Couldn't ask" (a pre-9.0.0 node, or an
  // unreachable one) stays allowed: it may work, and a failed build refunds both
  // sessions. A definite no is different — it is known before any money moves.
  const exitRefused = exitGrade !== undefined && exitGrade.reachable && !exitGrade.exit

  /**
   * Switch the app's resolver to encrypted DNS for this chain (and everything after).
   * Not done silently: it is a global setting, so the user presses the button.
   */
  async function handleUseEncryptedDns() {
    setDnsBusy(true)
    try {
      const updated = await window.api.settingsSet({ dnsResolver: '1.1.1.1' })
      setDnsResolver(updated.dnsResolver)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the DNS setting')
    } finally {
      setDnsBusy(false)
    }
  }

  async function handleBuild() {
    if (!entry || !exit || entryPrice === null || exitPrice === null) return
    setConnecting(true)
    setError(null)
    setCurrentStep('1/5')
    setHopMarker({ hop: 'entry', phase: 'buy' })
    try {
      const result = await window.api.connectionSubscribeChain({
        entry: {
          nodeAddress: entry.address, nodeMoniker: entry.moniker, nodeCountry: entry.country,
          nodeType: entry.type, apiField: entry.api, quoteValue: String(entryPrice),
        },
        exit: {
          nodeAddress: exit.address, nodeMoniker: exit.moniker, nodeCountry: exit.country,
          nodeType: exit.type, apiField: exit.api, quoteValue: String(exitPrice),
        },
        type: billing,
        amount,
        denom: 'udvpn',
        ...(exitWalletId ? { exitWalletId } : {}),
      })
      setPaid({ entrySessionId: result.sessionId, exitSessionId: result.exitSessionId })
      await connectTunnelOnly(result.protocol as TunnelProtocol)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build the chain')
    } finally {
      setConnecting(false)
    }
  }

  /** The bring-up alone. Both sessions stay paid, so this never re-buys. */
  async function connectTunnelOnly(protocol: TunnelProtocol) {
    setCurrentStep('5/5')
    await window.api.connectionConnect({
      protocol,
      ...(mode === 'proxy' ? { mode: 'proxy' as const } : {}),
    })
    setTunnelConnected(true)
  }

  async function handleRetryTunnel() {
    if (!paid) return
    setConnecting(true)
    setError(null)
    try {
      await connectTunnelOnly('xray')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await disconnectVpn()
    } finally {
      setDisconnecting(false)
      onClose()
    }
  }

  const title = tunnelConnected
    ? 'Chain active'
    : connecting
      ? 'Building the chain…'
      : step === 'entry'
        ? 'Pick the entry node'
        : step === 'exit'
          ? 'Pick the exit node'
          : 'Confirm the chain'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={connecting ? undefined : onClose}>
      {/* Fixed size, not content-sized. The three steps differ enormously in height
          (a 50-row list vs. a short summary), so a shrink-to-fit box resized under
          the cursor on every step change and moved the buttons around. Header and
          rail stay put; only the body scrolls. */}
      <div
        className="bg-bg-secondary border border-border w-full max-w-2xl h-[640px] max-h-[88vh] mx-4 flex flex-col rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 shrink-0">
          <div>
            <h2 className="text-text-primary text-base font-semibold">{title}</h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              Two hops: your device → entry → exit → the internet.
            </p>
          </div>
          {!connecting && (
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
              ×
            </button>
          )}
        </div>

        {/* Step rail, also the way back to an earlier choice. Stays on screen while
            the chain is being built — losing it there made the modal look like a
            different window that had forgotten the two nodes just picked. Every
            button is disabled mid-build, since going back would strand a purchase. */}
        {!tunnelConnected && !error && (
          <div className="flex items-center gap-2 text-xs px-6 pb-4 shrink-0">
            {(['entry', 'exit', 'confirm'] as const).map((s, i) => {
              const reachable = s === 'entry' || (s === 'exit' && entry) || (s === 'confirm' && entry && exit)
              const node = s === 'entry' ? entry : s === 'exit' ? exit : null
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!reachable || connecting}
                  onClick={() => setStep(s)}
                  className={`flex-1 px-2 py-1.5 border rounded-sm text-left transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                    step === s ? 'border-accent text-accent' : 'border-border text-text-secondary hover:border-border-focus'
                  }`}
                >
                  <span className="font-mono mr-1.5">{i + 1}</span>
                  {s === 'entry' ? 'Entry' : s === 'exit' ? 'Exit' : 'Confirm'}
                  {node && <span className="block truncate text-text-tertiary">{node.moniker || node.country}</span>}
                </button>
              )
            })}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 space-y-4">
        {alreadyConnected && !connecting && !tunnelConnected && (
          <div className="bg-warning-subtle border border-warning p-3 rounded-md space-y-2">
            <p className="text-warning text-sm">A tunnel is already up.</p>
            <p className="text-text-secondary text-xs">
              Building a chain replaces it. Disconnect first. The current session stays paid and
              can be reconnected from the Sessions tab.
            </p>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="btn btn-danger text-xs px-3 py-1 disabled:opacity-50"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        )}

        {!connecting && !error && !tunnelConnected && (step === 'entry' || step === 'exit') && (
          <NodePicker
            role={step}
            nodes={chainable}
            exclude={step === 'exit' ? entry : null}
            billing={billing}
            onBillingChange={setBilling}
            eligibility={eligibility}
            selected={step === 'entry' ? entry : exit}
            onSelect={(node) => {
              if (step === 'entry') {
                setEntry(node)
                setStep('exit')
              } else {
                setExit(node)
                setOverrideDiversity(false)
                setStep('confirm')
              }
            }}
          />
        )}

        {!connecting && !error && !tunnelConnected && step === 'confirm' && entry && exit && (
          <div className="space-y-4">
            <div className="space-y-2 text-sm border border-border rounded-md p-3">
              <HopRow label="Entry" hint="Sees your real IP. Never sees where you go." node={entry} price={entryPrice} billing={billing} />
              <div className="text-text-tertiary text-center text-xs">↓ tunnelled inside the entry hop</div>
              <HopRow label="Exit" hint="Sees where you go. Reached only through the entry, setup included." node={exit} price={exitPrice} billing={billing} />
            </div>

            {exitGrade && (
              <div className={`text-xs ${exitRefused ? 'text-danger' : exitGrade.reachable ? 'text-text-tertiary' : 'text-warning'}`}>
                {exitRefused ? (
                  <>
                    This node serves {exitGrade.transports.join(', ') || 'no usable transport'} and no plain TCP,
                    so it cannot be the exit. Only TCP survives being carried inside the entry hop.
                    Pick another exit; this node is still fine as an entry.
                  </>
                ) : exitGrade.reachable ? (
                  <>
                    Exit checked: this node serves plain TCP, so it can be chained, and the hop will
                    be wrapped in{' '}
                    <span className="text-success">
                      {exitGrade.exitSecurity === 'reality' ? 'Reality' : 'TLS, with the node\'s certificate pinned'}
                    </span>.
                    {exitGrade.transports.length > 1 && ` It also offers ${exitGrade.transports.filter((t) => t !== 'tcp').join(', ')}, which cannot be chained.`}
                  </>
                ) : (
                  <>
                    Exit not checked: {exitGrade.error ?? 'the node did not answer'}. Whether it can be chained
                    is unknown until the handshake. If it can't, both sessions are cancelled and refunded
                    automatically.
                  </>
                )}
              </div>
            )}

            {issues.length > 0 && (
              <div className={`border p-3 rounded-md space-y-2 ${operatorOverlap ? 'bg-danger-subtle border-danger' : 'bg-warning-subtle border-warning'}`}>
                <p className={`text-sm font-medium ${operatorOverlap ? 'text-danger' : 'text-warning'}`}>
                  {operatorOverlap ? 'These two hops may belong to one operator' : 'Both hops are in one country'}
                </p>
                <ul className="text-text-secondary text-xs space-y-1 list-disc list-inside">
                  {issues.map((i) => <li key={i.key}>{i.label}</li>)}
                </ul>
                {operatorOverlap && (
                  <>
                    <p className="text-text-tertiary text-xs">
                      One operator holding both hops sees your IP at one end and your destinations at the
                      other, so the chain protects nothing and you pay twice.
                    </p>
                    <label className="flex items-start gap-2 cursor-pointer text-xs text-text-secondary">
                      <input
                        type="checkbox"
                        checked={overrideDiversity}
                        onChange={(e) => setOverrideDiversity(e.target.checked)}
                        className="accent-accent mt-0.5"
                      />
                      <span>These are different operators. Build it anyway.</span>
                    </label>
                  </>
                )}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex gap-4">
                {(['gigabytes', 'hours'] as const).map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="chainBilling"
                      checked={billing === t}
                      onChange={() => setBilling(t)}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className={billing === t ? 'text-text-primary' : 'text-text-secondary'}>
                      Pay by {t === 'gigabytes' ? 'Gigabytes' : 'Hours'}
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={amount}
                  onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value) || 1))}
                  className="bg-bg-tertiary border border-border text-text-primary text-sm font-mono px-3 py-1.5 w-20 rounded-sm focus:outline-none focus:border-border-focus"
                />
                <span className="text-text-secondary text-sm">{billing === 'gigabytes' ? 'GB' : 'hours'}</span>
                <span className="text-text-secondary text-sm">on each hop =</span>
                <span className="text-accent text-sm font-mono font-semibold">{formatP2p(costUdvpn)} P2P</span>
              </div>
              {/* Both hops carry the same bytes and the same wall-clock, so the chain
                  lasts as long as its SHORTER half — buying different amounts per hop
                  would just strand the difference. One amount, applied to both. */}
              <p className="text-text-tertiary text-xs">
                Bought on both hops. The chain ends when either half runs out.
              </p>
              {balance !== null && (
                <div className="text-sm text-text-secondary">
                  Wallet balance: <span className="text-success font-mono">{balance} P2P</span>
                </div>
              )}
            </div>

            {priceMissing && (
              <p className="text-warning text-xs">
                One of these nodes doesn't quote a price in P2P for {billing === 'gigabytes' ? 'data' : 'time'}.
                Switch the billing type, or pick a different node.
              </p>
            )}

            {cantAfford && (
              <InsufficientFunds
                message={insufficientFundsMessage(funds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}

            {/* Per-hop wallets. Paying both hops from one account is what lets either
                node read its session's `accAddress`, run the public
                SessionsForAccount query and find the other half of the chain — so
                this is the control that closes the one break the text below
                otherwise has to warn about. Deliberately a picker over wallets the
                user already has: creating and funding one here would move coins
                between the two accounts, which is itself a public link and would put
                the pairing straight back. */}
            <div className="space-y-1.5">
              <div className="text-xs text-text-secondary">Exit hop paid by</div>
              <select
                value={exitWalletId}
                onChange={(e) => setExitWalletId(e.target.value)}
                className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus w-full"
              >
                <option value="">This wallet (both hops on one account)</option>
                {wallets.filter((w) => w.address !== activeAddress).map((w) => (
                  <option key={w.id} value={w.id}>{w.name} · {w.address.slice(0, 12)}…{w.address.slice(-6)}</option>
                ))}
              </select>
              {exitWalletId ? (
                walletLink === null ? (
                  <p className="text-text-tertiary text-xs flex items-center gap-1.5">
                    <Spinner className="text-accent" /> Checking whether these two accounts are already
                    linked on chain…
                  </p>
                ) : walletLink.linked ? (
                  <div className="bg-danger-subtle border border-danger p-3 rounded-md space-y-1">
                    <p className="text-danger text-xs font-medium">
                      These two wallets are already linked on chain
                    </p>
                    <p className="text-text-secondary text-xs">
                      There is a transfer between this wallet and your active one, and transfers are
                      public. Anyone who sees both hops can follow it back and join them, so paying
                      the hops separately buys you nothing here. To get the benefit, the exit wallet
                      needs funds that never touched the other account.
                    </p>
                  </div>
                ) : walletLink.checked ? (
                  <p className="text-text-tertiary text-xs">
                    <span className="text-success">No direct transfer between these two accounts</span>, so
                    neither node can pair them by following coins from one to the other. Only that one hop
                    is checked: if both wallets were funded from the same third account, an exchange
                    withdrawal for instance, that account still joins them.
                  </p>
                ) : (
                  <p className="text-warning text-xs">
                    Couldn't check whether these two accounts are linked (the RPC did not answer, or
                    keeps no transaction index). If you funded this wallet from the other one, that
                    transfer is public and the hops are still joined.
                  </p>
                )
              ) : wallets.filter((w) => w.address !== activeAddress).length === 0 ? (
                <p className="text-text-tertiary text-xs">
                  You have one wallet, so both hops are paid from it and either node can find the
                  other by looking up your account on chain. Import a second wallet, funded from
                  somewhere other than this one, to close that.
                </p>
              ) : (
                <p className="text-warning text-xs">
                  Both hops paid from one account: either node can read your address off its own
                  session and find the other hop with a public query. Pick a second wallet to
                  prevent that.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-xs text-text-secondary">Connection mode</div>
              <div className="flex gap-4 text-sm">
                {(['tunnel', 'proxy'] as const).map((m) => (
                  <label key={m} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="chain-mode"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                      className="accent-accent"
                    />
                    <span className="text-text-primary">{m === 'tunnel' ? 'Full tunnel' : 'Local proxy'}</span>
                  </label>
                ))}
              </div>
              <p className="text-text-tertiary text-xs">
                {mode === 'tunnel'
                  ? 'Routes your whole device through the chain (needs admin rights).'
                  : 'Runs a SOCKS5 proxy on 127.0.0.1:1080. No admin password, but only apps you point at it use the chain, and there is no kill switch.'}
              </p>
            </div>

            {/* The honest part. Every claim here is measured or verified on chain —
                see the multihop threat model. Do not soften it into "anonymity". */}
            <div className="border border-border rounded-md p-3 space-y-2 text-xs">
              <p className="text-text-primary font-medium">Before you pay, what this does and doesn't do</p>
              <p className="text-text-secondary">
                <span className="text-success">Protects against one dishonest node.</span> The entry sees your
                IP but not your destinations; the exit sees your destinations, and your traffic reaches it
                only through the entry. Neither alone watches both ends of your browsing.
              </p>
              <p className="text-text-secondary">
                <span className="text-success">The exit is set up through the entry.</span> Buying a session
                means asking a node for its keys, and for the exit that request is carried by the entry hop,
                so the exit sees the entry's address and never yours. One thing it does not cover: while you
                were choosing, this app asked candidate nodes what they support, directly. That question
                carries no wallet and no session, but it did come from you.
              </p>
              <p className="text-text-secondary">
                <span className="text-warning">Each hop authenticates itself with keys it sends you.</span>{' '}
                Nodes use self-signed certificates and there is nothing on chain to check them against, so
                whoever can intercept the setup request can answer it. That is the same trust every
                single-hop connection here relies on, and worth knowing when the observer you are avoiding
                is the network you are on.
              </p>
              <p className="text-text-secondary">
                <span className="text-danger">Does not make you anonymous.</span>{' '}
                {exitWalletId
                  ? 'Two operators working together can still match the traffic itself, since the same bytes cross both hops at the same moments. Paying each hop from a different account stops them pairing you on chain; it does not stop them comparing notes.'
                  : "Both sessions are paid from this one wallet, and a session's account is public on chain, so either node can look up the other and pair them. Two operators working together can also match the traffic itself, since the same bytes cross both hops."}
              </p>
              <p className="text-text-secondary">
                <span className="text-warning">Costs twice, and it is slow.</span> Two sessions, two deposits.
                Measured on a live chain: roughly 20× the latency of a single hop.
              </p>
              {/* The chain cannot close this one by itself. With the resolver on System
                  Default and the kill switch off, DNS goes to the LAN resolver, which is
                  a more specific route than tun2socks' /1 halves, so it never enters the
                  tunnel: the ISP reads every domain while the user is paying twice to
                  hide exactly that. Full tunnel only, since proxy mode routes nothing. */}
              {mode === 'tunnel' && dnsResolver === 'system' && (
                <div className="border border-warning bg-warning-subtle rounded-md p-2.5 space-y-1.5">
                  <p className="text-warning">Your DNS would still go to your own network.</p>
                  <p className="text-text-secondary">
                    DNS is set to System Default, which is usually your router. That lookup is not
                    routed through the chain, so your provider still sees every domain you visit even
                    though your traffic does not go near them.
                  </p>
                  <button
                    type="button"
                    onClick={handleUseEncryptedDns}
                    disabled={dnsBusy}
                    className="btn btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
                  >
                    {dnsBusy ? 'Applying…' : 'Use encrypted DNS (1.1.1.1)'}
                  </button>
                </div>
              )}
              <label className="flex items-start gap-2 cursor-pointer text-text-secondary pt-1">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="accent-accent mt-0.5"
                />
                <span>I've read this.</span>
              </label>
            </div>

            <button
              onClick={handleBuild}
              disabled={
                !acknowledged || cantAfford || priceMissing || exitRefused || alreadyConnected ||
                (operatorOverlap && !overrideDiversity)
              }
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Buy both hops &amp; connect · {formatP2p(costUdvpn)} P2P
            </button>
          </div>
        )}

        {connecting && entry && exit && (
          <div className="space-y-4">
            {/* The same summary the confirm step showed, so the build happens "in
                place" rather than in what reads as a new, emptier window. */}
            <div className="space-y-2 text-sm border border-border rounded-md p-3 opacity-70">
              <HopRow label="Entry" hint="Sees your real IP. Never sees where you go." node={entry} price={entryPrice} billing={billing} />
              <div className="text-text-tertiary text-center text-xs">↓ tunnelled inside the entry hop</div>
              <HopRow label="Exit" hint="Sees where you go. Reached only through the entry, setup included." node={exit} price={exitPrice} billing={billing} />
            </div>
            {/* Two hops, tracked separately. The generic 5-step list is wrong here: a
                chain repeats steps 1-3 for the second purchase, so it counts up,
                jumps back and counts up again with nothing saying why. */}
            <div className="space-y-2">
              <HopProgress
                label="Entry"
                node={entry}
                stage={hopStage('entry', hopMarker, tunnelStarted)}
                detail={hopMarker?.hop === 'entry' && !tunnelStarted ? currentDetail : null}
              />
              <HopProgress
                label="Exit"
                node={exit}
                stage={hopStage('exit', hopMarker, tunnelStarted)}
                detail={hopMarker?.hop === 'exit' && !tunnelStarted ? currentDetail : null}
              />
              <div className="flex items-start gap-3 text-sm">
                <span className={`status-dot mt-1.5 ${tunnelStarted ? 'status-dot-pending' : ''}`} />
                <span className="min-w-0">
                  <span className={tunnelStarted ? 'text-text-primary' : 'text-text-tertiary'}>
                    Establishing the chained tunnel
                  </span>
                  {tunnelStarted && currentDetail && (
                    <span className="block text-text-tertiary text-xs">{currentDetail}</span>
                  )}
                </span>
              </div>
            </div>
            <p className="text-text-tertiary text-xs">
              Buying both hops takes two transactions. Leave this open: if anything fails after a
              session is paid for, it is cancelled automatically.
            </p>
          </div>
        )}
        {connecting && !(entry && exit) && <ProgressSteps currentStep={currentStep} error={error} />}

        {error && !connecting && (
          <div className="space-y-3">
            {/* Both hops are paid for and neither is named in the shared error pane,
                which only carries one session id. Without this the two deposits are
                invisible at exactly the moment the user is deciding what to do next. */}
            {paid && (
              <div className="border border-border rounded-md p-3 text-xs space-y-1">
                <p className="text-text-primary">Both hops are bought and still open.</p>
                <p className="text-text-secondary">
                  Entry <span className="font-mono">#{paid.entrySessionId}</span>, exit{' '}
                  <span className="font-mono">#{paid.exitSessionId}</span>. Retrying the connection
                  does not charge you again. If you give up, end them from the Sessions tab, where
                  they appear as one chain.
                </p>
              </div>
            )}
            <ConnectErrorActions
              error={error}
              paidSessionId={paid ? paid.entrySessionId : null}
              onRetryTunnel={handleRetryTunnel}
              // With two sessions already paid for, "start over" must NOT lead back to
              // the confirm step: the Buy button there is live, and pressing it buys a
              // SECOND pair while the first is still open and still charged. Close
              // instead, and leave the chain where the user can see and end it.
              onStartOver={paid
                ? onClose
                : () => { setError(null); setCurrentStep(null); setStep('confirm') }}
            />
          </div>
        )}

        {tunnelConnected && paid && entry && exit && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="status-dot status-dot-active" />
              <span className="text-success font-medium">
                {mode === 'proxy' ? 'Chained proxy active' : 'Chained tunnel active'}
              </span>
            </div>
            <div className="space-y-2 text-sm border border-border rounded-md p-3">
              <div className="flex justify-between">
                <span className="text-text-secondary">Entry · #{paid.entrySessionId}</span>
                <span className="text-text-primary">{entry.moniker} · {entry.country}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Exit · #{paid.exitSessionId}</span>
                <span className="text-text-primary">{exit.moniker} · {exit.country}</span>
              </div>
            </div>
            <p className="text-text-tertiary text-xs">
              Sites will see {exit.country}. Both sessions appear in the Sessions tab and are billed
              separately. Ending either one ends the chain.
            </p>
            {mode === 'proxy' && (
              <p className="text-text-tertiary text-xs">
                SOCKS5 at <span className="font-mono text-text-secondary">127.0.0.1:1080</span>. Only apps
                pointed at it go through the chain.
              </p>
            )}
            <button onClick={onClose} className="btn btn-primary w-full">Done</button>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

type HopPhase = 'buy' | 'provision' | 'handshake'
type HopMarker = { hop: 'entry' | 'exit'; phase: HopPhase }

/** `hop:entry:buy` and friends. Anything else is ignored rather than guessed at. */
function parseHopMarker(step: string): HopMarker | null {
  const [, hop, phase] = step.split(':')
  if (
    (hop === 'entry' || hop === 'exit') &&
    (phase === 'buy' || phase === 'provision' || phase === 'handshake')
  ) {
    return { hop, phase }
  }
  return null
}

/**
 * The order main announces these in. The whole entry is finished before the exit is
 * touched, because the exit is reached THROUGH the entry: it is bought and handshaked
 * over a proxy that the entry hop is already carrying.
 */
const MARKER_SEQUENCE: HopMarker[] = [
  { hop: 'entry', phase: 'buy' },
  { hop: 'entry', phase: 'handshake' },
  { hop: 'exit', phase: 'provision' },
  { hop: 'exit', phase: 'buy' },
  { hop: 'exit', phase: 'handshake' },
]

type HopStage = 'pending' | 'buying' | 'routing' | 'handshaking' | 'done'

/**
 * Where a hop sits, given the marker main last sent. Scored off the position in
 * MARKER_SEQUENCE rather than off the role alone, which is what keeps each hop's own
 * stage moving in one direction only: an earlier version read the role and made both
 * hops jump backwards halfway through the build.
 */
function hopStage(role: 'entry' | 'exit', marker: HopMarker | null, tunnelStarted: boolean): HopStage {
  if (tunnelStarted) return 'done'
  const at = marker === null
    ? -1
    : MARKER_SEQUENCE.findIndex((s) => s.hop === marker.hop && s.phase === marker.phase)
  if (at < 0) return 'pending'
  const stages: Record<'entry' | 'exit', HopStage[]> = {
    entry: ['buying', 'handshaking', 'done', 'done', 'done'],
    exit: ['pending', 'pending', 'routing', 'buying', 'handshaking'],
  }
  return stages[role][at]
}

const HOP_STAGE_LABEL: Record<HopStage, string | null> = {
  pending: null,
  buying: 'Buying the session on chain.',
  // The step this whole flow exists for, so it says what it is buying the user.
  routing: 'Connecting through the entry, so this node never sees your address.',
  handshaking: 'Handshaking with the node.',
  done: 'Bought and handshaked.',
}

function HopProgress({ label, node, stage, detail }: {
  label: string
  node: SentNode | null
  stage: HopStage
  detail: string | null
}) {
  const busy = stage === 'buying' || stage === 'handshaking'
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className={`status-dot mt-1.5 ${
        stage === 'done' ? 'status-dot-active' : stage === 'pending' ? '' : 'status-dot-pending'
      }`} />
      <span className="min-w-0">
        <span className={stage === 'pending' ? 'text-text-tertiary' : 'text-text-primary'}>
          {label} hop{node ? ` · ${node.moniker || node.country}` : ''}
        </span>
        {busy && detail && <span className="block text-text-tertiary text-xs">{detail}</span>}
        {HOP_STAGE_LABEL[stage] && (
          <span className="block text-text-tertiary text-xs">{HOP_STAGE_LABEL[stage]}</span>
        )}
      </span>
    </div>
  )
}

function HopRow({ label, hint, node, price, billing }: {
  label: string
  hint: string
  node: SentNode
  price: number | null
  billing: BillingType
}) {
  const code = COUNTRY_CODES[node.country] || ''
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary text-xs uppercase tracking-wide">{label}</span>
          {code && <span className={`fi fi-${code}`} style={{ fontSize: '12px', lineHeight: 1 }} />}
          <span className="text-text-primary truncate">{node.moniker || '—'}</span>
          <span className={`text-xs ${protocolMeta(node.type).color}`}>{protocolMeta(node.type).short}</span>
        </div>
        <div className="text-text-tertiary text-xs">
          {node.country}{node.city ? `, ${node.city}` : ''}
          {node.asn ? <span className="font-mono ml-2">AS{node.asn}</span> : null}
          <span className="font-mono ml-2">{node.api}</span>
        </div>
        <div className="text-text-tertiary text-xs">{hint}</div>
      </div>
      <span className="text-text-secondary font-mono text-xs shrink-0">
        {price === null ? '—' : `${formatP2p(price)}/${billing === 'gigabytes' ? 'GB' : 'hr'}`}
      </span>
    </div>
  )
}

function NodePicker({ role, nodes, exclude, billing, onBillingChange, eligibility, selected, onSelect }: {
  role: 'entry' | 'exit'
  nodes: SentNode[]
  exclude: SentNode | null
  billing: BillingType
  onBillingChange: (t: BillingType) => void
  eligibility: ReturnType<typeof useChainEligibility>
  selected: SentNode | null
  onSelect: (node: SentNode) => void
}) {
  const [search, setSearch] = useState('')
  const [country, setCountry] = useState('')
  const [verifiedOnly, setVerifiedOnly] = useState(false)

  const countries = useMemo(
    () => [...new Set(nodes.map((n) => n.country).filter(Boolean))].sort(),
    [nodes],
  )

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    return nodes
      .filter((n) => n.address !== exclude?.address)
      .filter((n) => (country ? n.country === country : true))
      .filter((n) => !q || n.moniker.toLowerCase().includes(q) || n.country.toLowerCase().includes(q) || n.city.toLowerCase().includes(q))
      .filter((n) => {
        if (!verifiedOnly) return true
        const grade = eligibility.results.get(n.address)
        return grade?.reachable === true && (role === 'exit' ? grade.exit : grade.entry)
      })
      // Confirmed exits first, then the rest cheapest-first. Sorting by price alone
      // buried the usable ones: only MAX_ROWS render, so a verified exit priced above
      // that many cheaper nodes was unreachable no matter how far you scrolled.
      .sort((a, b) => {
        const rank = (n: SentNode) => {
          const grade = eligibility.results.get(n.address)
          if (grade?.reachable === true && (role === 'exit' ? grade.exit : grade.entry)) return 0
          if (majorVersion(n) >= 9) return 1  // checkable, and either pending or refused
          return 2                            // too old to check at all
        }
        const byRank = rank(a) - rank(b)
        if (byRank !== 0) return byRank
        return (udvpnPrice(a, billing) ?? Infinity) - (udvpnPrice(b, billing) ?? Infinity)
      })
  }, [nodes, exclude, country, search, verifiedOnly, eligibility.results, billing, role])

  const visible = matches.slice(0, MAX_ROWS)

  // Grade every CHECKABLE candidate, not just the rows on screen. Two reasons, both
  // found the hard way:
  //   - only MAX_ROWS render, so grading just those made everything past the last row
  //     permanently ungraded, and the sort above could never lift a verified exit
  //     into view.
  //   - "Verified exits only" filters on the grades, so with only the visible rows
  //     graded it silently hid every verified exit outside them.
  // Pre-9.0.0 nodes are skipped entirely rather than probed and reported unknown:
  // they publish no inbound list, so the request can only fail. That is most of the
  // network (487 of 726 healthy V2Ray/XRAY nodes), so skipping them is also what
  // keeps this affordable.
  //
  // VISIBLE ROWS FIRST, though. probe() walks its argument in order, so putting the
  // rendered rows at the front settles the part of the list the user is looking at in
  // the first chunk or two, instead of after every node in the country they didn't
  // pick. It also means an early close probes far fewer nodes: each probe is an HTTPS
  // request from the user's own address, so a picker opened and abandoned should not
  // announce itself to a couple of hundred operators.
  const { probe } = eligibility
  const checkable = useMemo(() => {
    const onScreen = new Set(visible.map((n) => n.address))
    return [
      ...visible.filter((n) => majorVersion(n) >= 9),
      ...matches.filter((n) => majorVersion(n) >= 9 && !onScreen.has(n.address)),
    ]
    // `visible` is derived from `matches`, so one dependency covers both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches])
  // Sorted, because grades arriving change the list ORDER and an order-sensitive
  // key would retrigger this effect on every one of them.
  const visibleKey = checkable.map((n) => n.address).sort().join(',')
  // Settle before probing. The search box filters on every keystroke, and each new set
  // abandons the sweep in flight and starts one for the new one — so typing "toronto"
  // unthrottled would fire a chunk of 30 requests per letter. probe's identity is
  // stable (it reads results from a ref), so this timer is only reset by a real change
  // of role or filter, never by a chunk landing.
  useEffect(() => {
    if (checkable.length === 0) return
    // The key tells probe() whether this is the set it is already working or a new one
    // to switch to. Role is in it because the two ends are graded against different rules.
    const timer = setTimeout(() => { void probe(checkable, `${role}:${visibleKey}`) }, PROBE_SETTLE_MS)
    return () => clearTimeout(timer)
    // visibleKey stands in for `visible`, which is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, visibleKey, probe])

  return (
    // h-full + a flex-1 list, so the rows fill whatever the fixed-height modal
    // leaves rather than stopping short of it.
    <div className="space-y-3 h-full flex flex-col">
      <p className="text-text-secondary text-xs shrink-0">
        {role === 'entry' ? (
          <>
            The entry node is the one your device dials directly, so it sees your real IP and nothing
            about where you go. It is also the hop your own network and ISP can see, which is why it
            has to be wrapped.
          </>
        ) : (
          <>
            The exit node is reached through the entry, both for your traffic and for the request
            that sets it up, so your packets never arrive at it directly and sites see its location
            instead of yours. It must also serve plain TCP, because grpc and websocket bring their
            own dialer and break when chained.
          </>
        )}
      </p>
      {/* The enforced rule is "not cleartext", which is narrower than "TLS only":
          VMess carries its own AEAD cipher, so VMess without TLS is accepted while
          VLess without TLS is refused. Every exit-capable node measured on
          2026-08-14 (138 of them) served TLS or Reality, but that is a fact about
          today's network and not something to promise, so the badge reports each
          node's actual security instead. */}
      <p className="text-text-tertiary text-xs shrink-0">
        Both hops of a chain must be wrapped in <span className="text-success">TLS</span> or{' '}
        <span className="text-success">Reality</span>, which is stricter than an ordinary connection.
        A VMess hop without TLS is still encrypted, but it is recognisable as a proxy to anyone
        watching the wire, and that is the thing a chain is bought to avoid. Nodes older than 9.0.0
        publish nothing to check against that rule, so they are listed for context but cannot be
        picked.
      </p>

      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search moniker, country, city…"
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus flex-1 min-w-[180px]"
        />
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
        >
          <option value="">All countries</option>
          {countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={billing}
          onChange={(e) => onBillingChange(e.target.value as BillingType)}
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
        >
          <option value="gigabytes">P2P / GB</option>
          <option value="hours">P2P / hour</option>
        </select>
        {role === 'exit' && (
          <label className="flex items-center gap-1.5 text-sm text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Verified exits only
          </label>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-text-tertiary shrink-0">
        <span>
          Showing {visible.length} of {matches.length}
          {matches.length > MAX_ROWS ? ', narrow the search to see more' : ''}
        </span>
        {eligibility.progress && (
          <span className="flex items-center gap-1.5 text-text-secondary">
            <Spinner className="text-accent" />
            Checking nodes {eligibility.progress.done}/{eligibility.progress.total}
          </span>
        )}
      </div>

      <div className="border border-border rounded-md divide-y divide-border flex-1 min-h-0 overflow-y-auto">
        {visible.map((node) => {
          const grade = eligibility.results.get(node.address)
          const ok = role === 'exit' ? grade?.exit : grade?.entry
          const security = role === 'exit' ? grade?.exitSecurity : grade?.entrySecurity
          // Selectable only on POSITIVE evidence. Under the chain's TLS rule an
          // unverifiable node is not a maybe, it is a near-certain refund: a node
          // that publishes no listing is pre-9.0.0, and 485 of 487 of those report
          // no TLS. Leaving them clickable cost a real pair of sessions, and the
          // refund of that pair then failed. Ungraded rows stay VISIBLE, so the list
          // still explains itself rather than silently hiding most of the network.
          const checking = majorVersion(node) >= 9 && grade === undefined
          const refused = !checking && ok !== true
          const price = udvpnPrice(node, billing)
          const code = COUNTRY_CODES[node.country] || ''
          return (
            <button
              key={node.address}
              type="button"
              onClick={() => onSelect(node)}
              disabled={refused}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                selected?.address === node.address ? 'bg-success-subtle' : 'hover:bg-bg-hover'
              }`}
            >
              {code && <span className={`fi fi-${code} shrink-0`} style={{ fontSize: '12px', lineHeight: 1 }} />}
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-text-primary truncate">{node.moniker || node.address}</span>
                <span className="block text-xs text-text-tertiary truncate">
                  {node.country}{node.city ? `, ${node.city}` : ''}
                  {node.asn ? ` · AS${node.asn}` : ''}
                </span>
              </span>
              {(
                <span className="shrink-0 text-xs">
                  {majorVersion(node) < 9 ? (
                    // Never probed (see `checkable`), so say what is actually known:
                    // its version. "unknown" made a knowable fact look like a failure.
                    <span
                      className="text-text-tertiary"
                      title={`This node runs ${node.version || 'a pre-9.0.0 version'}, which does not publish its inbound list, so it cannot be checked before you pay. Almost none of them offer TLS, so this will very likely be refused at the handshake and refunded.`}
                    >
                      v{node.version || '8.x'}
                    </span>
                  ) : grade === undefined ? (
                    <span className="text-text-tertiary">checking…</span>
                  ) : !grade.reachable ? (
                    <span className="text-warning" title={grade.error ?? 'No inbound listing'}>unknown</span>
                  ) : ok ? (
                    <span
                      className="text-success"
                      title={`Serves ${grade.transports.join(', ')}. This hop would be wrapped in ${security === 'reality' ? 'Reality' : 'TLS'}.`}
                    >
                      {role === 'exit' ? 'TCP + ' : ''}{security === 'reality' ? 'Reality' : 'TLS'}
                    </span>
                  ) : (
                    <span
                      className="text-danger"
                      title={role === 'exit'
                        ? `Serves ${grade.transports.join(', ') || 'nothing usable'}. A chain exit needs a plain-TCP inbound wrapped in TLS or Reality.`
                        : `Serves ${grade.transports.join(', ') || 'nothing usable'}, but none of it is wrapped in TLS or Reality. Still fine for an ordinary single-hop connection.`}
                    >
                      {role === 'exit' ? 'no TLS/TCP' : 'no TLS'}
                    </span>
                  )}
                </span>
              )}
              <span className={`shrink-0 text-xs ${protocolMeta(node.type).color}`}>{protocolMeta(node.type).short}</span>
              <span className="shrink-0 text-xs font-mono text-text-secondary w-[70px] text-right">
                {price === null ? '—' : formatP2p(price)}
              </span>
            </button>
          )
        })}
        {visible.length === 0 && (
          <div className="px-3 py-6 text-center text-text-secondary text-sm">
            No nodes match. Try clearing the filters.
          </div>
        )}
      </div>
    </div>
  )
}
