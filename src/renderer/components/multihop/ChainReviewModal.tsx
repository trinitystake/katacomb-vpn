import { useEffect, useState, type ReactNode } from 'react'
import type { SentNode, TunnelProtocol, WalletEntry } from '../../types'
import { useBalance } from '../../hooks/useBalance'
import { useConnection } from '../../hooks/useConnection'
import { useChainDraft } from '../../contexts/ChainDraftContext'
import { chainDiversityIssues, hasOperatorOverlap } from '../../utils/chain-diversity'
import { udvpnPrice, type BillingType } from '../../utils/chain-node'
import { checkFunds, formatP2p, insufficientFundsMessage } from '../../../shared/funds'
import { SOCKS_DISPLAY_ADDR } from '../../../shared/socks'
import { protocolMeta } from '../../utils/protocols'
import { COUNTRY_CODES } from '../../utils/country-codes'
import ConnectErrorActions from '../ConnectErrorActions'
import InfoTip from '../InfoTip'
import InsufficientFunds from '../InsufficientFunds'
import Spinner from '../Spinner'

interface Props {
  entry: SentNode
  exit: SentNode
  onClose: () => void
}

/**
 * Commit step for a two-hop chain: everything the user is about to pay for, then the
 * two purchases and the bring-up.
 *
 * A modal on purpose, and the exact counterpart of ConnectionModal for a single hop:
 * the choosing happens on a page, the paying happens here. It is also why this is a
 * separate file from the page — the page is mounted for as long as the tab is open,
 * this only exists during a purchase.
 */
export default function ChainReviewModal({ entry, exit, onClose }: Props) {
  const { status } = useConnection()
  const { udvpn, display: balance, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  const { billing, setBilling, amount, setAmount, clear, eligibility } = useChainDraft()

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
  // the summary can say so before the money moves.
  const [dnsResolver, setDnsResolver] = useState<string | null>(null)
  const [dnsBusy, setDnsBusy] = useState(false)

  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [currentDetail, setCurrentDetail] = useState<string | null>(null)
  const [hopMarker, setHopMarker] = useState<HopMarker | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState<{ entrySessionId: string; exitSessionId: string } | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)

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

  const entryPrice = udvpnPrice(entry, billing)
  const exitPrice = udvpnPrice(exit, billing)
  const costUdvpn = (entryPrice ?? 0) * amount + (exitPrice ?? 0) * amount
  const priceMissing = entryPrice === null || exitPrice === null
  const funds = udvpn === null ? null : checkFunds(udvpn, costUdvpn)
  const cantAfford = funds !== null && !funds.ok

  const issues = chainDiversityIssues(entry, exit)
  const operatorOverlap = hasOperatorOverlap(issues)
  const exitGrade = eligibility.results.get(exit.address)
  // Block only on a definite No. "Couldn't ask" (a pre-9.0.0 node, or an
  // unreachable one) stays allowed: it may work, and a failed build refunds both
  // sessions. A definite no is different — it is known before any money moves.
  const exitRefused = exitGrade !== undefined && exitGrade.reachable && !exitGrade.exit

  /**
   * Closing once a session exists spends the draft: those two nodes are now a pair of
   * sessions, and re-offering them on the page would invite a second purchase.
   */
  function handleClose() {
    if (paid) clear()
    onClose()
  }

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
    if (entryPrice === null || exitPrice === null) return
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
    // Spent the instant it becomes a live chain, not when this window is closed. The
    // page behind is visible around this modal, and leaving two nodes sitting in the
    // rail next to a "2/2" badge invites buying the same pair twice. This modal holds
    // its own copy of the pair, so clearing here does not disturb the pane below.
    clear()
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

  const title = tunnelConnected
    ? 'Chain active'
    : connecting
      ? 'Building the chain…'
      : 'Review the chain'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={connecting ? undefined : handleClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-text-primary text-base font-semibold">{title}</h2>
          {!connecting && (
            <button onClick={handleClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
              ×
            </button>
          )}
        </div>

        <div className="px-6 pb-6 space-y-4">
        {!connecting && !error && !tunnelConnected && (
          <div className="space-y-4">
            <div className="space-y-2 text-sm border border-border rounded-md p-3">
              <HopRow label="Entry" hint="Sees your real IP. Never sees where you go." node={entry} price={entryPrice} billing={billing} />
              <div className="text-text-tertiary text-center text-xs">↓ tunnelled inside the entry hop</div>
              <HopRow label="Exit" hint="Sees where you go. Reached only through the entry, setup included." node={exit} price={exitPrice} billing={billing} />
            </div>

            {/* One line per outcome, reasoning behind the "?". The refused variant keeps
                its full first sentence visible: it is the one that blocks the Buy button,
                so the user needs to know what to change without hovering anything. */}
            {exitGrade && (
              <div className={`text-xs flex items-start justify-between gap-2 ${exitRefused ? 'text-danger' : exitGrade.reachable ? 'text-text-tertiary' : 'text-warning'}`}>
                {exitRefused ? (
                  <>
                    <p>
                      Cannot be the exit: serves {exitGrade.transports.join(', ') || 'no usable transport'} and
                      no plain TCP. Still fine as an entry.
                    </p>
                    <InfoTip label="Why this node cannot be the exit">
                      Only plain TCP survives being carried inside the entry hop: grpc and websocket
                      bring their own dialer. Pick another exit.
                    </InfoTip>
                  </>
                ) : exitGrade.reachable ? (
                  <>
                    <p>
                      Exit verified: plain TCP, wrapped in{' '}
                      <span className="text-success">
                        {exitGrade.exitSecurity === 'reality' ? 'Reality' : 'TLS'}
                      </span>.
                    </p>
                    <InfoTip label="What was verified on this exit">
                      This node serves plain TCP, so it can be chained, and the hop will be wrapped in{' '}
                      {exitGrade.exitSecurity === 'reality' ? 'Reality' : "TLS, with the node's certificate pinned"}.
                      {exitGrade.transports.length > 1 && ` It also offers ${exitGrade.transports.filter((t) => t !== 'tcp').join(', ')}, which cannot be chained.`}
                    </InfoTip>
                  </>
                ) : (
                  <>
                    <p>Exit not checked: {exitGrade.error ?? 'the node did not answer'}.</p>
                    <InfoTip label="What happens if this exit cannot be chained">
                      Whether it can be chained is unknown until the handshake. If it can't, both
                      sessions are cancelled and refunded automatically.
                    </InfoTip>
                  </>
                )}
              </div>
            )}

            {issues.length > 0 && (
              <div className={`border p-3 rounded-md space-y-2 ${operatorOverlap ? 'bg-danger-subtle border-danger' : 'bg-warning-subtle border-warning'}`}>
                {/* The observations and the override stay visible: they ARE the decision.
                    Only the "why that matters" sentence moves behind the "?". */}
                <div className="flex items-start justify-between gap-2">
                  <p className={`text-sm font-medium ${operatorOverlap ? 'text-danger' : 'text-warning'}`}>
                    {operatorOverlap ? 'These two hops may belong to one operator' : 'Both hops are in one country'}
                  </p>
                  {operatorOverlap && (
                    <InfoTip label="Why one operator holding both hops matters">
                      One operator holding both hops sees your IP at one end and your destinations at
                      the other, so the chain protects nothing and you pay twice.
                    </InfoTip>
                  )}
                </div>
                <ul className="text-text-secondary text-xs space-y-1 list-disc list-inside">
                  {issues.map((i) => <li key={i.key}>{i.label}</li>)}
                </ul>
                {operatorOverlap && (
                  <label className="flex items-start gap-2 cursor-pointer text-xs text-text-secondary">
                    <input
                      type="checkbox"
                      checked={overrideDiversity}
                      onChange={(e) => setOverrideDiversity(e.target.checked)}
                      className="accent-accent mt-0.5"
                    />
                    <span>These are different operators. Build it anyway.</span>
                  </label>
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
                Ends when either half runs out.
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
              {/* One line per state. The two that must never read as a pass keep their own
                  colour and their own wording: `linked` stays a danger card, and
                  `checked: false` stays amber and says it could not check, never nothing. */}
              {exitWalletId ? (
                walletLink === null ? (
                  <p className="text-text-tertiary text-xs flex items-center gap-1.5">
                    <Spinner className="text-accent" /> Checking whether these accounts are linked…
                  </p>
                ) : walletLink.linked ? (
                  <div className="bg-danger-subtle border border-danger p-3 rounded-md">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-danger text-xs font-medium">
                        These two wallets are already linked on chain, so paying separately buys
                        nothing
                      </p>
                      <InfoTip label="Why a transfer between the wallets undoes this">
                        There is a transfer between this wallet and your active one, and transfers are
                        public. Anyone who sees both hops can follow it back and join them. To get the
                        benefit, the exit wallet needs funds that never touched the other account.
                      </InfoTip>
                    </div>
                  </div>
                ) : walletLink.checked ? (
                  <p className="text-text-tertiary text-xs flex items-start justify-between gap-2">
                    <span className="text-success">No direct transfer between these accounts.</span>
                    <InfoTip label="What this check does and does not cover">
                      Neither node can pair them by following coins from one to the other. Only that
                      one hop is checked: if both wallets were funded from the same third account, an
                      exchange withdrawal for instance, that account still joins them.
                    </InfoTip>
                  </p>
                ) : (
                  <p className="text-warning text-xs flex items-start justify-between gap-2">
                    <span>Couldn't check whether these accounts are linked.</span>
                    <InfoTip label="Why the link check could not run">
                      The RPC did not answer, or keeps no transaction index. If you funded this wallet
                      from the other one, that transfer is public and the hops are still joined.
                    </InfoTip>
                  </p>
                )
              ) : wallets.filter((w) => w.address !== activeAddress).length === 0 ? (
                <p className="text-text-tertiary text-xs flex items-start justify-between gap-2">
                  <span>Both hops paid from this wallet, so either node can find the other.</span>
                  <InfoTip label="How to pay the hops from separate wallets">
                    A session's account is public on chain, so either node can look your address up
                    and find the other hop. Import a second wallet, funded from somewhere other than
                    this one, to close that.
                  </InfoTip>
                </p>
              ) : (
                <p className="text-warning text-xs flex items-start justify-between gap-2">
                  <span>Both hops on one account: either node can find the other.</span>
                  <InfoTip label="Why one account links the two hops">
                    Either node can read your address off its own session and find the other hop with
                    a public query. Pick a second wallet to prevent that.
                  </InfoTip>
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
              <p className="text-text-tertiary text-xs flex items-start justify-between gap-2">
                <span>
                  {mode === 'tunnel'
                    ? 'Routes your whole device through the chain. Needs admin rights.'
                    : `SOCKS5 on ${SOCKS_DISPLAY_ADDR}. Only apps you point at it use the chain, and there is no kill switch.`}
                </span>
                {mode === 'proxy' && (
                  <InfoTip label="More about local proxy mode">
                    No admin password is needed, because nothing about your routing changes.
                    Everything you do not point at the proxy leaves your device as normal.
                  </InfoTip>
                )}
              </p>
            </div>

            {/* The honest part. Every claim here is measured or verified on chain —
                see the multihop threat model. Do not soften it into "anonymity".

                Five paragraphs became five rows because ~250 words of undifferentiated
                grey right before two deposits is text nobody reads. Each row keeps its
                paragraph VERBATIM behind the "?", and the glyph carries the same
                success/warning/danger grading each paragraph used to open with — this is
                a demotion, not a cut. Anything measured (the 20x) stays visible, because
                a number is what the decision turns on. */}
            <div className="border border-border rounded-md p-3 space-y-2 text-xs">
              <p className="text-text-primary font-medium">Before you pay</p>
              <ThreatRow tone="success" text="No one node sees both ends" label="How the two hops split what they can see">
                The entry sees your IP but not your destinations; the exit sees your destinations,
                and your traffic reaches it only through the entry. Neither alone watches both ends
                of your browsing.
              </ThreatRow>
              <ThreatRow tone="success" text="The exit is set up through the entry" label="How the exit is provisioned">
                Buying a session means asking a node for its keys, and for the exit that request is
                carried by the entry hop, so the exit sees the entry's address and never yours. One
                thing it does not cover: while you were choosing, this app asked candidate nodes what
                they support, directly. That question carries no wallet and no session, but it did
                come from you.
              </ThreatRow>
              <ThreatRow tone="warning" text="Each hop vouches for its own keys" label="What the node keys are checked against">
                Nodes use self-signed certificates and there is nothing on chain to check them
                against, so whoever can intercept the setup request can answer it. That is the same
                trust every single-hop connection here relies on, and worth knowing when the observer
                you are avoiding is the network you are on.
              </ThreatRow>
              <ThreatRow tone="danger" text="This is not anonymity" label="What a chain still does not hide">
                {exitWalletId
                  ? 'Two operators working together can still match the traffic itself, since the same bytes cross both hops at the same moments. Paying each hop from a different account stops them pairing you on chain; it does not stop them comparing notes.'
                  : "Both sessions are paid from this one wallet, and a session's account is public on chain, so either node can look up the other and pair them. Two operators working together can also match the traffic itself, since the same bytes cross both hops."}
              </ThreatRow>
              <ThreatRow tone="warning" text="Two deposits, and about 20x slower" label="What a chain costs">
                Two sessions, two deposits, and each is billed separately. The latency figure is
                measured on a live chain, not estimated.
              </ThreatRow>
              {/* The chain cannot close this one by itself. With the resolver on System
                  Default and the kill switch off, DNS goes to the LAN resolver, which is
                  a more specific route than tun2socks' /1 halves, so it never enters the
                  tunnel: the ISP reads every domain while the user is paying twice to
                  hide exactly that. Full tunnel only, since proxy mode routes nothing. */}
              {mode === 'tunnel' && dnsResolver === 'system' && (
                <div className="border border-warning bg-warning-subtle rounded-md p-2.5 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-warning">Your DNS would still go to your own network.</p>
                    <InfoTip label="Why DNS escapes the chain">
                      DNS is set to System Default, which is usually your router. That lookup is not
                      routed through the chain, so your provider still sees every domain you visit
                      even though your traffic does not go near them.
                    </InfoTip>
                  </div>
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
                <span>I understand what a chain does and does not hide.</span>
              </label>
            </div>

            {/* Says why the button below is dead. The banner on the page behind this one
                carries the Disconnect, so there is no second one here. */}
            {alreadyConnected && (
              <p className="text-warning text-xs">
                A tunnel is already up. Disconnect it first, on the tab behind this window.
              </p>
            )}

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

        {connecting && (
          <div className="space-y-4">
            {/* The same summary the review showed, so the build happens "in place"
                rather than in what reads as a new, emptier window. */}
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
              Leave this open. If anything fails after a session is paid for, it is cancelled
              automatically.
            </p>
          </div>
        )}

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
              // the review: the Buy button there is live, and pressing it buys a SECOND
              // pair while the first is still open and still charged. Close instead, and
              // leave the chain where the user can see and end it.
              onStartOver={paid
                ? handleClose
                : () => { setError(null); setCurrentStep(null) }}
            />
          </div>
        )}

        {tunnelConnected && paid && (
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
                SOCKS5 at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only apps
                pointed at it go through the chain.
              </p>
            )}
            <button onClick={handleClose} className="btn btn-primary w-full">Done</button>
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

/**
 * One line of the "Before you pay" card: a graded glyph, a short claim, and the full
 * paragraph behind a "?".
 *
 * The tone is the same success/warning/danger grading the paragraphs used to carry as a
 * coloured opening phrase, so nothing about the honesty of the block changes — only how
 * much of it is on screen at rest.
 */
function ThreatRow({ tone, text, label, children }: {
  tone: 'success' | 'warning' | 'danger'
  text: string
  label: string
  children: ReactNode
}) {
  const glyph = tone === 'success' ? '✓' : tone === 'warning' ? '!' : '✕'
  const color = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-danger'
  return (
    <div className="flex items-start gap-2">
      <span className={`${color} w-3 shrink-0 text-center leading-5`}>{glyph}</span>
      <span className="text-text-secondary flex-1 leading-5">{text}</span>
      {/* Optically centred against the 20px line rather than top-aligned to it. */}
      <span className="mt-[3px]">
        <InfoTip label={label}>{children}</InfoTip>
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
