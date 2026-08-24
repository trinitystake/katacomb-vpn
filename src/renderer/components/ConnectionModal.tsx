import { useState, useEffect } from 'react'
import type { SentNode, NodeProbeResult, PlanInfo, PlanAllocation, TunnelProtocol } from '../types'
import ConnectErrorActions from './ConnectErrorActions'
import ProgressSteps from './ProgressSteps'
import Spinner from './Spinner'
import { useNavigation } from '../contexts/NavigationContext'
import { useConnection } from '../hooks/useConnection'
import { v2rayConnectionBadge, isCleartextConnection } from '../utils/v2ray-connection'
import { protocolMeta, isProtocolSupported } from '../utils/protocols'
import { nodeStatusMeta, isNodeConnectable } from '../utils/node-status'
import { useBalance } from '../hooks/useBalance'
import { checkFunds, formatP2p, insufficientFundsMessage } from '../../shared/funds'
import InsufficientFunds from './InsufficientFunds'
import { SOCKS_DISPLAY_ADDR } from '../../shared/socks'

interface Props {
  node: SentNode
  onClose: () => void
}

function getUdvpnPrice(prices: { denom: string; value: string }[]): { raw: string; display: string } | null {
  const p = prices.find((x) => x.denom === 'udvpn')
  if (!p) return null
  return { raw: p.value, display: formatP2p(parseInt(p.value, 10)) }
}

export default function ConnectionModal({ node, onClose }: Props) {
  const nodeStatus = nodeStatusMeta(node)
  const connectable = isNodeConnectable(node)
  // The node list's health flag is third-party and can be hours stale, so an
  // active-but-unhealthy node may be tried on explicit acknowledgement — a failed
  // handshake is refunded (establishSessionOrRefund), so it costs a wait, not funds.
  // An INACTIVE node is not overridable: the chain itself rejects those sessions.
  const canOverrideHealth = nodeStatus.state === 'unhealthy'
  const [healthAcknowledged, setHealthAcknowledged] = useState(false)
  const { goToPlansForNode } = useNavigation()
  // Live connection status — when the tunnel is already up to THIS node we show a
  // "Connected" panel + Disconnect instead of the subscribe form (which would create
  // a redundant second session). `reconnecting` counts so we don't flash the form
  // during a same-node reconnect blip.
  const { status, disconnect: disconnectVpn } = useConnection()
  const onThisNode =
    status.nodeAddress === node.address &&
    (status.state === 'connected' || status.state === 'reconnecting')
  // Plans compatible with THIS node. null = still loading.
  const [compatiblePlans, setCompatiblePlans] = useState<PlanInfo[] | null>(null)
  // User's existing plan allocations (subscriptions). Used to detect reuse vs. fresh subscribe.
  const [allocations, setAllocations] = useState<PlanAllocation[]>([])
  const [subType, setSubType] = useState<'gigabytes' | 'hours'>('gigabytes')
  const [amount, setAmount] = useState(1)
  const { udvpn, display: balance, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Protocol of the session we already paid for. Kept so a failed bring-up can be
  // retried against that session instead of buying a second one.
  const [paidProtocol, setPaidProtocol] = useState<TunnelProtocol | null>(null)
  // Full tunnel vs. local SOCKS proxy. Only the child-proxy protocols expose a
  // local listener, so the choice is hidden (and forced to 'tunnel') otherwise.
  const [mode, setMode] = useState<'tunnel' | 'proxy'>('tunnel')
  const [vpnWarning, setVpnWarning] = useState<{ type: string; name: string; iface?: string }[] | null>(null)
  const [probeResult, setProbeResult] = useState<NodeProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // v2ray(2)/xray(4)/hysteria2(6) run a local SOCKS5 listener, so they can be used
  // as a plain proxy. WireGuard/AmneziaWG are the routing change — no proxy mode.
  const proxyCapable = node.type === 2 || node.type === 4 || node.type === 6

  const gbPrice = getUdvpnPrice(node.gigabytePrices)
  const hrPrice = getUdvpnPrice(node.hourlyPrices)
  const selectedPrice = subType === 'gigabytes' ? gbPrice : hrPrice
  const costUdvpn = selectedPrice ? parseInt(selectedPrice.raw, 10) * amount : 0
  const totalCost = selectedPrice ? formatP2p(costUdvpn) : '—'

  useEffect(() => {
    let cancelled = false
    window.api
      .planListForNode(node.address)
      .then((plans) => {
        if (!cancelled) setCompatiblePlans(plans)
      })
      .catch(() => {
        if (!cancelled) setCompatiblePlans([])
      })
    return () => {
      cancelled = true
    }
  }, [node.address])

  useEffect(() => {
    let cancelled = false
    window.api
      .planAllocations()
      .then((allocs) => {
        if (!cancelled) setAllocations(allocs)
      })
      .catch(() => {
        if (!cancelled) setAllocations([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Active allocation whose plan covers this node. When present we silently
  // reuse it instead of charging the user per-GB or creating a new subscription.
  const matchingAllocation = (() => {
    if (!compatiblePlans || compatiblePlans.length === 0) return null
    const compatibleIds = new Set(compatiblePlans.map((p) => p.id))
    return allocations.find((a) => a.status === 1 && compatibleIds.has(a.planId)) ?? null
  })()

  // Reusing an allocation buys nothing on-chain — only gas is due. null while the
  // balance is unknown: never block the pay button on a balance we couldn't read.
  const funds = udvpn === null ? null : checkFunds(udvpn, matchingAllocation ? 0 : costUdvpn)
  const cantAfford = funds !== null && !funds.ok

  useEffect(() => {
    const unsub = window.api.onConnectionProgress((step, _detail) => {
      setCurrentStep(step)
    })
    return unsub
  }, [])

  // Auto-probe latency as soon as the modal opens — saves the user a click and
  // surfaces reachability inline with the rest of the node details.
  useEffect(() => {
    let cancelled = false
    setProbing(true)
    setProbeResult(null)
    window.api
      .nodeTestProbe({ nodeAddress: node.address, remoteUrl: node.api })
      .then((result) => {
        if (!cancelled) setProbeResult(result)
      })
      .catch(() => {
        if (!cancelled) {
          setProbeResult({
            nodeAddress: node.address,
            timestamp: Date.now(),
            reachable: false,
            latencyMs: null,
            error: 'Probe failed',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setProbing(false)
      })
    return () => {
      cancelled = true
    }
  }, [node.address, node.api])

  /**
   * The tunnel bring-up step on its own. Main keeps the paid session's config
   * (activeWg/activeV2ray/…) until disconnect, so calling this after a failed
   * bring-up reuses that session — no second subscribe tx, no second payment.
   */
  async function connectTunnelOnly(protocol: TunnelProtocol, dnsFallback = false) {
    setCurrentStep('5/5')
    await window.api.connectionConnect({
      protocol,
      ...(proxyCapable && mode === 'proxy' ? { mode: 'proxy' as const } : {}),
      ...(dnsFallback ? { dnsFallback: true } : {}),
    })
    setTunnelConnected(true)
  }

  /** Error-state retry when the payment succeeded but the tunnel didn't come up. */
  async function handleRetryTunnel(dnsFallback = false) {
    if (!paidProtocol) return
    setConnecting(true)
    setError(null)
    try {
      await connectTunnelOnly(paidProtocol, dnsFallback)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  /** Drop the paid-session context and go back to the subscribe form. */
  function resetToSubscribe() {
    setError(null)
    setCurrentStep(null)
    setSessionId(null)
    setPaidProtocol(null)
  }

  async function handleSubscribe() {
    if (!matchingAllocation && !selectedPrice) return

    if (!vpnWarning) {
      try {
        const otherVpns = await window.api.connectionCheckVpn()
        if (otherVpns.length > 0) {
          setVpnWarning(otherVpns)
          return
        }
      } catch { /* proceed if check fails */ }
    }
    setVpnWarning(null)

    setConnecting(true)
    setError(null)
    setCurrentStep('1/5')

    try {
      let protocol: string

      if (matchingAllocation) {
        // Reuse existing on-chain subscription — single MsgStartSession in
        // sentinel.subscription.v3, no new subscription is created.
        const res = await window.api.planStartSessionFromSub({
          subscriptionId: matchingAllocation.subscriptionId,
          planId: matchingAllocation.planId,
          nodeAddress: node.address,
          nodeMoniker: node.moniker,
          nodeCountry: node.country,
          nodeType: node.type,
          apiField: node.api,
        })
        setSessionId(res.sessionId)
        protocol = res.protocol
      } else if (selectedPrice) {
        const res = await window.api.connectionSubscribe({
          nodeAddress: node.address,
          nodeMoniker: node.moniker,
          nodeCountry: node.country,
          nodeType: node.type,
          apiField: node.api,
          type: subType,
          amount,
          denom: 'udvpn',
          quoteValue: selectedPrice.raw,
        })
        setSessionId(res.sessionId)
        protocol = res.protocol
      } else {
        throw new Error('No valid subscription selected')
      }

      const tunnelProtocol = protocol as TunnelProtocol
      setPaidProtocol(tunnelProtocol)
      await connectTunnelOnly(tunnelProtocol)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  function handleSeePlansForNode() {
    goToPlansForNode(node.address)
    onClose()
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

  const title = onThisNode
    ? 'Connected to this node'
    : tunnelConnected
      ? 'VPN Active'
      : connecting
        ? 'Connecting...'
        : 'Connect to Node'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={connecting ? undefined : onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-text-primary text-base font-semibold">
              {title}
            </h2>
            {/* Names this as one half of a pair, in the same sentence shape the
                Multi-hop tab uses for the other half, so the two define each other
                rather than reading as unrelated features. */}
            <p className="text-text-tertiary text-xs mt-0.5">
              Single hop: your device → this node → the internet.
            </p>
          </div>
          {!connecting && (
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary text-lg transition-colors"
            >
              ×
            </button>
          )}
        </div>

        {/* Node details */}
        <div className="space-y-2 text-sm border-b border-border pb-4">
          <div className="flex justify-between">
            <span className="text-text-secondary">Moniker</span>
            <span className="text-text-primary">{node.moniker}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary shrink-0">Address</span>
            {/* Full address, not truncated: it is the node's on-chain identity and the
                only way to tell two nodes of the same operator apart. */}
            <span className="text-text-primary font-mono text-xs break-all text-right select-text">{node.address}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary shrink-0">Endpoint</span>
            {/* host:port the node advertises. Usually already an IPv4 literal; when it
                is a hostname the tunnel pins it to an IP at connect time. */}
            <span className="text-text-primary font-mono text-xs break-all text-right select-text">{node.api}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Location</span>
            <span className="text-text-primary">
              {node.country}{node.city ? `, ${node.city}` : ''}
              {node.asn ? <span className="text-text-tertiary font-mono text-xs ml-2">AS{node.asn}</span> : null}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Type</span>
            <span className={protocolMeta(node.type).color}>
              {protocolMeta(node.type).label}
            </span>
          </div>
          {node.type === 2 && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Connection</span>
              {node.connection ? (
                <span className={`font-mono text-xs ${isCleartextConnection(node.connection) ? 'text-danger' : 'text-text-primary'}`}>
                  {node.connection.proxy} / {node.connection.transport} / {node.connection.security}
                  {' '}({v2rayConnectionBadge(node.connection)})
                </span>
              ) : (
                <span className="text-text-tertiary">unknown (advertised at connect time)</span>
              )}
            </div>
          )}
          {node.type === 2 && isCleartextConnection(node.connection) && (
            <div className="text-danger text-xs">
              Unencrypted at the proxy layer: VLess without TLS.
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-text-secondary">Status</span>
            <span className="flex items-center gap-2">
              <span className={`status-dot ${nodeStatus.dotClass}`} />
              <span className={nodeStatus.textClass}>{nodeStatus.label}</span>
            </span>
          </div>
          {nodeStatus.state !== 'active' && (
            <div className="text-text-tertiary text-xs">
              {nodeStatus.detail}
              {nodeStatus.state === 'unhealthy' && (
                <> Reported by the node list, not measured here. The latency below is this
                client's own probe of the node's API port, so a node can answer that and still
                fail to build a tunnel.</>
              )}
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-text-secondary">Latency</span>
            {probing ? (
              <span className="flex items-center gap-2 text-text-tertiary">
                <Spinner className="text-accent" /> Measuring…
              </span>
            ) : probeResult ? (
              <span className={`font-mono ${probeResult.reachable ? 'text-success' : 'text-danger'}`}>
                {probeResult.reachable
                  ? `${probeResult.latencyMs}ms, reachable`
                  : `Unreachable${probeResult.error ? `: ${probeResult.error}` : ''}`}
              </span>
            ) : (
              <span className="text-text-tertiary">—</span>
            )}
          </div>
        </div>

        {/* VPN conflict warning */}
        {vpnWarning && !connecting && (
          <div className="space-y-3">
            <div className="bg-warning-subtle border border-warning p-3 rounded-md">
              <p className="text-warning text-sm font-medium mb-2">
                Another VPN is active
              </p>
              <ul className="text-text-secondary text-sm space-y-1">
                {vpnWarning.map((v, i) => (
                  <li key={i}>
                    {v.name}{v.iface ? ` (${v.iface})` : ''}
                    {v.type === 'wireguard' && (
                      <span className="text-danger ml-2">(will be disconnected)</span>
                    )}
                    {v.type !== 'wireguard' && (
                      <span className="text-warning ml-2">(may cause routing conflicts)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleSubscribe()}
                disabled={cantAfford}
                className="btn btn-primary flex-1 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Continue Anyway
              </button>
              <button
                onClick={() => setVpnWarning(null)}
                className="btn btn-secondary flex-1"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Already connected to this node — show status + Disconnect instead of the
            subscribe form (subscribing again would create a redundant session). */}
        {onThisNode && !connecting && !tunnelConnected && (
          <div className="space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">Session ID</span>
                <span className="text-success font-mono">{status.sessionId ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Protocol</span>
                <span className="text-text-primary">{protocolMeta(node.type).label}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="status-dot status-dot-active" />
              <span className="text-success font-medium">VPN tunnel active</span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="btn btn-danger flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
              <button
                onClick={onClose}
                disabled={disconnecting}
                className="btn btn-secondary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Subscription form */}
        {!onThisNode && !tunnelConnected && !connecting && !error && !vpnWarning && (
          <>
            {matchingAllocation ? (
              <div className="bg-success/10 border border-success/40 rounded-md px-4 py-3 text-sm space-y-1">
                <div className="text-success font-medium">
                  Connecting via plan #{matchingAllocation.planId} · no new charge
                </div>
                <div className="text-text-secondary text-xs">
                  Reusing your existing allocation <span className="font-mono text-text-primary">#{matchingAllocation.subscriptionId}</span>.
                  Bytes will be deducted from this plan.
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-4">
                  {(['gigabytes', 'hours'] as const).map((t) => (
                    <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="subType"
                        checked={subType === t}
                        onChange={() => setSubType(t)}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className={subType === t ? 'text-text-primary' : 'text-text-secondary'}>
                        Pay by {t === 'gigabytes' ? 'Gigabytes' : 'Hours'}
                      </span>
                    </label>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={amount}
                    onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value) || 1))}
                    className="bg-bg-tertiary border border-border text-text-primary text-sm font-mono px-3 py-1.5 w-20 rounded-sm focus:outline-none focus:border-border-focus"
                  />
                  <span className="text-text-secondary text-sm">
                    {subType === 'gigabytes' ? 'GB' : 'hours'}
                  </span>
                  <span className="text-text-secondary text-sm font-mono">
                    × {selectedPrice?.display || '—'} P2P
                  </span>
                  <span className="text-text-secondary text-sm">=</span>
                  <span className="text-accent text-sm font-mono font-semibold">
                    {totalCost} P2P
                  </span>
                </div>

                {balance !== null && (
                  <div className="text-sm text-text-secondary">
                    Wallet balance: <span className="text-success font-mono">{balance} P2P</span>
                  </div>
                )}
              </div>
            )}

            {cantAfford && (
              <InsufficientFunds
                message={insufficientFundsMessage(funds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}

            {proxyCapable && (
              <div className="space-y-1.5">
                <div className="text-xs text-text-secondary">Connection mode</div>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="connect-mode"
                      checked={mode === 'tunnel'}
                      onChange={() => setMode('tunnel')}
                      className="accent-accent"
                    />
                    <span className="text-text-primary">Full tunnel</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="connect-mode"
                      checked={mode === 'proxy'}
                      onChange={() => setMode('proxy')}
                      className="accent-accent"
                    />
                    <span className="text-text-primary">Local proxy</span>
                  </label>
                </div>
                <p className="text-text-tertiary text-xs">
                  {mode === 'tunnel'
                    ? 'Routes your whole device through the node (needs admin rights).'
                    : `Runs a SOCKS5 proxy on ${SOCKS_DISPLAY_ADDR}. No admin password, but only apps you point at it are tunneled. No kill switch.`}
                </p>
              </div>
            )}

            {/* Gate above the action it unlocks. */}
            {isProtocolSupported(node.type) && !connectable && canOverrideHealth && (
              <div className="bg-warning-subtle border border-warning p-3 rounded-md space-y-2">
                <p className="text-warning text-xs">
                  This node last failed the network health check, so connecting is disabled by
                  default. That check runs elsewhere and can be hours out of date. The node may
                  well be working.
                </p>
                <label className="flex items-start gap-2 cursor-pointer text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={healthAcknowledged}
                    onChange={(e) => setHealthAcknowledged(e.target.checked)}
                    className="accent-accent mt-0.5"
                  />
                  <span>
                    Try it anyway. If the handshake fails, the session is cancelled and refunded
                    automatically.
                  </span>
                </label>
              </div>
            )}

            <button
              onClick={handleSubscribe}
              disabled={
                !(connectable || (canOverrideHealth && healthAcknowledged)) ||
                !isProtocolSupported(node.type) ||
                (!matchingAllocation && !selectedPrice) ||
                cantAfford
              }
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {matchingAllocation ? 'Connect via Plan' : 'Subscribe & Connect'}
            </button>

            {!isProtocolSupported(node.type) && (
              <div className="text-xs text-warning text-center pt-1">
                {protocolMeta(node.type).label} isn't supported by this client yet. This node is shown for filtering only.
              </div>
            )}

            {isProtocolSupported(node.type) && !connectable && !canOverrideHealth && (
              <div className="text-xs text-warning text-center pt-1">
                Connecting is disabled because this node is not active on-chain.
              </div>
            )}

            {!matchingAllocation && compatiblePlans && compatiblePlans.length > 0 && (
              <div className="text-xs text-text-tertiary text-center pt-1">
                This node is part of {compatiblePlans.length} plan{compatiblePlans.length === 1 ? '' : 's'} ·{' '}
                <button
                  type="button"
                  onClick={handleSeePlansForNode}
                  className="text-accent hover:underline"
                >
                  See Plans tab
                </button>
              </div>
            )}
          </>
        )}

        {/* Progress steps */}
        {connecting && (
          <ProgressSteps currentStep={currentStep} error={error} />
        )}

        {/* Error with retry */}
        {error && !connecting && (
          <ConnectErrorActions
            error={error}
            paidSessionId={paidProtocol ? sessionId : null}
            onRetryTunnel={() => handleRetryTunnel()}
            onStartOver={resetToSubscribe}
            onRetryWithoutDns={paidProtocol ? () => handleRetryTunnel(true) : undefined}
          />
        )}

        {/* Connected state */}
        {tunnelConnected && sessionId && (
          <div className="space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">Session ID</span>
                <span className="text-success font-mono">{sessionId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Protocol</span>
                <span className="text-text-primary">{protocolMeta(node.type).label}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="status-dot status-dot-active" />
              <span className="text-success font-medium">
                {proxyCapable && mode === 'proxy' ? 'Local proxy active' : 'VPN tunnel active'}
              </span>
            </div>

            {proxyCapable && mode === 'proxy' ? (
              <p className="text-text-tertiary text-sm">
                SOCKS5 proxy at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only apps
                configured to use it are tunneled. The rest of your traffic still goes out directly.
              </p>
            ) : node.type === 1 ? (
              <p className="text-text-tertiary text-sm">
                WireGuard interface is up. Your traffic is now routed through this node.
              </p>
            ) : null}

            <button onClick={onClose} className="btn btn-primary w-full">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
