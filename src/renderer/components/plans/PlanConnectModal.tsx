import { useEffect, useMemo, useState } from 'react'
import type { PlanInfo, SentNode, SmartConnectResult } from '../../types'
import { useConnectFlow } from '../../hooks/useConnectFlow'
import { useConnection } from '../../hooks/useConnection'
import { useNodesContext } from '../../contexts/NodesContext'
import { usePlansContext } from '../../contexts/PlansContext'
import { useBalance } from '../../hooks/useBalance'
import { checkFunds, insufficientFundsMessage } from '../../../shared/funds'
import { planPriceDisplay, formatBytes, formatDuration } from '../../utils/format'
import { protocolMeta, isProtocolSupported, isProxyCapable } from '../../utils/protocols'
import { nodeStatusMeta, isNodeConnectable } from '../../utils/node-status'
import { SOCKS_DISPLAY_ADDR } from '../../../shared/socks'
import ConnectErrorActions from '../ConnectErrorActions'
import InsufficientFunds from '../InsufficientFunds'
import CountryFlag from '../CountryFlag'
import Spinner from '../Spinner'

interface Props {
  plan: PlanInfo
  /** Present = start a session on this existing subscription (gas only). */
  subscriptionId?: string
  /** Open with the manual node picker already expanded. */
  startManual?: boolean
  onClose: () => void
}

/**
 * The RenewalPricePolicy values the UI offers. 0 is the hub's own "never
 * renew"; 7 renews at any price and is the chain default.
 */
const RENEWAL_OPTIONS = [
  { value: 7, label: 'Renew automatically' },
  { value: 0, label: 'Never renew' },
]

/**
 * Progress for a smart connect: the plan:* markers main emits, in order, plus
 * the shared tunnel step. The manual path reuses the same renderer with its
 * two honest stages (no invented "broadcasting subscription tx" on a reuse).
 */
function stagesFor(kind: 'smart-fresh' | 'smart-reuse' | 'manual-fresh' | 'manual-reuse'): { id: string; label: string }[] {
  switch (kind) {
    case 'smart-fresh':
      return [
        { id: 'plan:rank', label: 'Finding the best node' },
        { id: 'plan:buy', label: 'Buying the plan' },
        { id: 'plan:handshake', label: 'Handshaking with the node' },
        { id: '5/5', label: 'Establishing tunnel' },
      ]
    case 'smart-reuse':
      return [
        { id: 'plan:rank', label: 'Finding the best node' },
        { id: 'plan:session', label: 'Starting a session on your subscription' },
        { id: 'plan:handshake', label: 'Handshaking with the node' },
        { id: '5/5', label: 'Establishing tunnel' },
      ]
    case 'manual-fresh':
      return [
        { id: '1/5', label: 'Buying the plan and starting a session' },
        { id: '5/5', label: 'Establishing tunnel' },
      ]
    case 'manual-reuse':
      return [
        { id: '1/5', label: 'Starting a session on your subscription' },
        { id: '5/5', label: 'Establishing tunnel' },
      ]
  }
}

function ProgressList({ stages, currentStep, stepDetail, error }: {
  stages: { id: string; label: string }[]
  currentStep: string | null
  stepDetail: string | null
  error: string | null
}) {
  // The smart flow can revisit plan:session/plan:handshake across ladder
  // attempts; the highest stage reached keeps the list monotonic.
  const rawIndex = stages.findIndex((s) => s.id === currentStep)
  // '1/5' arrives before any plan:* marker on the smart path: treat it as stage 0.
  const currentIndex = rawIndex === -1 ? 0 : rawIndex
  return (
    <div className="space-y-2.5">
      {stages.map((stage, i) => {
        let state: 'pending' | 'active' | 'done' | 'error' = 'pending'
        if (error && i === currentIndex) state = 'error'
        else if (i < currentIndex) state = 'done'
        else if (i === currentIndex) state = 'active'
        return (
          <div key={stage.id} className="text-sm">
            <div className="flex items-center gap-3">
              <span
                className={`status-dot ${
                  state === 'done' ? 'status-dot-active' :
                  state === 'active' ? 'status-dot-pending' :
                  state === 'error' ? 'bg-danger' :
                  'bg-border'
                }`}
              />
              <span
                className={
                  state === 'done' ? 'text-success' :
                  state === 'active' ? 'text-warning' :
                  state === 'error' ? 'text-danger' :
                  'text-text-tertiary'
                }
              >
                {stage.label}
              </span>
            </div>
            {state === 'active' && stepDetail && (
              <div className="text-text-tertiary text-xs pl-5 mt-0.5">{stepDetail}</div>
            )}
          </div>
        )
      })}
      {error && <p className="text-danger text-sm mt-2 pl-5">{error}</p>}
    </div>
  )
}

/**
 * ONE connect modal for both plan flows: fresh subscribe (plan price) and
 * session-on-existing-subscription (gas only). Smart connect is the primary
 * path; "Choose node instead" expands the manual picker. Carries the four
 * safety features the old plan modals lacked: the other-VPN pre-check, the
 * already-connected guard, the unhealthy-node acknowledgement, and local
 * proxy mode.
 */
export default function PlanConnectModal({ plan, subscriptionId, startManual = false, onClose }: Props) {
  const isReuse = subscriptionId !== undefined
  const { status } = useConnection()
  const tunnelUp = status.state === 'connected' || status.state === 'reconnecting'
  const { allNodes } = useNodesContext()
  const { refreshOverview } = usePlansContext()
  const { udvpn, display: balance, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  const {
    connecting, currentStep, stepDetail, error, tunnelConnected, sessionId, paidProtocol, disconnecting,
    start, retryTunnel, disconnect: disconnectFlow, reset,
  } = useConnectFlow()

  const [manual, setManual] = useState(startManual)
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null)
  const [healthAcknowledged, setHealthAcknowledged] = useState(false)
  const [renewalPolicy, setRenewalPolicy] = useState(7)
  const [proxyMode, setProxyMode] = useState(false)
  const [vpnWarning, setVpnWarning] = useState<{ type: string; name: string; iface?: string }[] | null>(null)
  // The plan's linked node addresses, for the manual picker. null = loading.
  const [planNodeAddrs, setPlanNodeAddrs] = useState<string[] | null>(null)
  const [smartResult, setSmartResult] = useState<SmartConnectResult | null>(null)
  // Which flow the current attempt runs, for honest progress labels.
  const [kind, setKind] = useState<'smart-fresh' | 'smart-reuse' | 'manual-fresh' | 'manual-reuse'>(
    isReuse ? 'smart-reuse' : 'smart-fresh',
  )

  const price = planPriceDisplay(plan.prices)
  // The fresh subscribe charges the plan price; only udvpn is known here. A
  // reuse costs gas only. null while the balance is unreadable: never block
  // the pay button on a balance we couldn't read.
  const costUdvpn = isReuse ? 0 : (price.udvpn ?? 0)
  const funds = udvpn === null ? null : checkFunds(udvpn, costUdvpn)
  const cantAfford = funds !== null && !funds.ok
  const denom = plan.prices.find((p) => p.denom === 'udvpn')?.denom ?? plan.prices[0]?.denom ?? 'udvpn'

  // Manual picker data: the plan's nodes joined against the node directory.
  useEffect(() => {
    if (!manual || planNodeAddrs !== null) return
    let cancelled = false
    window.api.planNodes(plan.id)
      .then((addrs) => { if (!cancelled) setPlanNodeAddrs(addrs) })
      .catch(() => { if (!cancelled) setPlanNodeAddrs([]) })
    return () => { cancelled = true }
  }, [manual, planNodeAddrs, plan.id])

  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])
  const manualRows = useMemo(() => {
    if (planNodeAddrs === null) return null
    const rows = planNodeAddrs.map((addr) => ({ addr, node: nodeIndex.get(addr) ?? null }))
    // Directory-known, healthy rows first; unknown addresses stay visible but unclickable.
    rows.sort((a, b) => {
      const rank = (r: { node: SentNode | null }) =>
        r.node === null ? 2 : isNodeConnectable(r.node) ? 0 : 1
      return rank(a) - rank(b) || a.addr.localeCompare(b.addr)
    })
    return rows
  }, [planNodeAddrs, nodeIndex])
  const selectedNode = selectedAddr ? nodeIndex.get(selectedAddr) ?? null : null

  function handleProxyModeChange(checked: boolean) {
    setProxyMode(checked)
    // Ticking the box makes a selected non-proxy node ineligible: clear it so
    // the greyed-out row and the connect button agree.
    if (checked && selectedNode && !isProxyCapable(selectedNode.type)) setSelectedAddr(null)
  }

  async function checkOtherVpns(): Promise<boolean> {
    if (vpnWarning) {
      // Second press = Continue anyway.
      setVpnWarning(null)
      return true
    }
    try {
      const others = await window.api.connectionCheckVpn()
      if (others.length > 0) {
        setVpnWarning(others)
        return false
      }
    } catch { /* proceed if the check fails */ }
    return true
  }

  async function handleSmartConnect() {
    if (!(await checkOtherVpns())) return
    setKind(isReuse ? 'smart-reuse' : 'smart-fresh')
    setSmartResult(null)
    await start(async () => {
      const res = await window.api.planSmartConnect({
        planId: plan.id,
        ...(isReuse ? { subscriptionId } : { denom, renewalPolicy }),
        ...(proxyMode ? { requireProxyCapable: true } : {}),
      })
      setSmartResult(res)
      void refreshOverview()
      return res
    }, { mode: proxyMode ? 'proxy' : 'tunnel' })
  }

  async function handleManualConnect() {
    if (!selectedNode) return
    if (!(await checkOtherVpns())) return
    setKind(isReuse ? 'manual-reuse' : 'manual-fresh')
    setSmartResult(null)
    const node = selectedNode
    // The picker refuses non-proxy nodes while the box is ticked, so proxyMode
    // alone decides the mode (it used to be silently ignored for such nodes).
    await start(async () => {
      const params = {
        nodeAddress: node.address,
        nodeMoniker: node.moniker,
        nodeCountry: node.country,
        nodeType: node.type,
        apiField: node.api,
      }
      const res = isReuse
        ? await window.api.planStartSessionFromSub({ subscriptionId, planId: plan.id, ...params })
        : await window.api.planSubscribe({ planId: plan.id, denom, renewalPolicy, ...params })
      void refreshOverview()
      return res
    }, { mode: proxyMode ? 'proxy' : 'tunnel' })
  }

  async function handleDisconnect() {
    if (await disconnectFlow()) onClose()
  }

  const connectedNodeLabel = smartResult
    ? `${smartResult.node.moniker} (${smartResult.node.country})`
    : selectedNode
      ? `${selectedNode.moniker} (${selectedNode.country})`
      : null

  const title = tunnelConnected
    ? 'Connected'
    : connecting
      ? 'Connecting...'
      : isReuse
        ? `Connect via plan #${plan.id}`
        : `Subscribe to plan #${plan.id}`

  const showForm = !connecting && !error && !tunnelConnected && !vpnWarning

  // One toggle rendered in both branches, just above the action button: an
  // advanced option that should not push the primary flow down the modal.
  const proxyToggle = (
    <label
      className="flex items-start gap-2 cursor-pointer text-sm"
      title={`Runs a SOCKS5 proxy on ${SOCKS_DISPLAY_ADDR} instead of routing the whole device. Only apps configured to use the proxy are tunneled, and the kill switch is not available. Only nodes running v2ray, xray or hysteria2 qualify.`}
    >
      <input
        type="checkbox"
        checked={proxyMode}
        onChange={(e) => handleProxyModeChange(e.target.checked)}
        className="accent-accent mt-0.5"
      />
      <span>
        <span className="text-text-secondary">Local proxy mode</span>
        <span className="block text-xs text-text-tertiary">
          SOCKS5 proxy at {SOCKS_DISPLAY_ADDR}, no kill switch
        </span>
      </span>
    </label>
  )

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={connecting ? undefined : onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-text-primary text-base font-semibold">{title}</h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              {formatBytes(plan.bytes)} for {formatDuration(plan.durationSeconds)}
              {isReuse
                ? ', already paid. Starting a session costs gas only.'
                : price.amount
                  ? `, ${price.amount} ${price.denomLabel}.`
                  : '.'}
            </p>
          </div>
          {!connecting && (
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
              ×
            </button>
          )}
        </div>

        {/* A tunnel is already up: a new session would fight it for the routing. */}
        {tunnelUp && !tunnelConnected && (
          <div className="bg-warning-subtle border border-warning p-3 rounded-md text-sm text-warning">
            You are connected{status.nodeMoniker ? ` to ${status.nodeMoniker}` : ''}. Disconnect first to start a new session.
          </div>
        )}

        {/* Other-VPN warning, same shape as the Nodes tab. */}
        {vpnWarning && !connecting && (
          <div className="space-y-3">
            <div className="bg-warning-subtle border border-warning p-3 rounded-md">
              <p className="text-warning text-sm font-medium mb-2">Another VPN is active</p>
              <ul className="text-text-secondary text-sm space-y-1">
                {vpnWarning.map((v, i) => (
                  <li key={i}>
                    {v.name}{v.iface ? ` (${v.iface})` : ''}
                    {v.type === 'wireguard'
                      ? <span className="text-danger ml-2">(will be disconnected)</span>
                      : <span className="text-warning ml-2">(may cause routing conflicts)</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => (manual ? handleManualConnect() : handleSmartConnect())}
                disabled={cantAfford}
                className="btn btn-primary flex-1 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Continue anyway
              </button>
              <button onClick={() => setVpnWarning(null)} className="btn btn-secondary flex-1">
                Cancel
              </button>
            </div>
          </div>
        )}

        {showForm && !tunnelUp && (
          <>
            {!isReuse && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">Renewal</span>
                <select
                  value={renewalPolicy}
                  onChange={(e) => setRenewalPolicy(parseInt(e.target.value, 10))}
                  className="bg-bg-tertiary border border-border text-text-primary text-sm px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus"
                >
                  {RENEWAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}

            {!isReuse && balance !== null && (
              <div className="text-sm text-text-secondary">
                Wallet balance: <span className="text-success font-mono">{balance} P2P</span>
              </div>
            )}

            {!isReuse && price.udvpn === null && price.amount && (
              <div className="text-xs text-warning">
                This plan is priced in {price.denomLabel}, which this app cannot check your
                balance for. The chain will reject the purchase if the wallet cannot pay.
              </div>
            )}

            {cantAfford && (
              <InsufficientFunds
                message={insufficientFundsMessage(funds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}

            {!manual ? (
              <div className="space-y-3">
                <p className="text-text-tertiary text-xs">
                  Smart connect checks the plan's nodes and picks the fastest healthy one. If the
                  first choice fails, the next is tried without paying the plan price again.
                </p>
                {proxyToggle}
                <button
                  onClick={handleSmartConnect}
                  disabled={cantAfford}
                  className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {isReuse ? 'Connect' : 'Subscribe and connect'}
                </button>
                <button
                  type="button"
                  onClick={() => setManual(true)}
                  className="text-accent text-xs hover:underline block mx-auto"
                >
                  Choose the node myself instead
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary text-sm">Pick a node in this plan</span>
                  <button
                    type="button"
                    onClick={() => setManual(false)}
                    className="text-accent text-xs hover:underline"
                  >
                    Back to smart connect
                  </button>
                </div>
                {manualRows === null ? (
                  <div className="flex items-center gap-2 text-text-tertiary text-sm">
                    <Spinner /> Loading the plan's nodes...
                  </div>
                ) : manualRows.length === 0 ? (
                  <p className="text-text-secondary text-sm">
                    No nodes are linked to this plan right now.
                  </p>
                ) : (
                  <div className="max-h-56 overflow-y-auto border border-border rounded-md divide-y divide-border">
                    {manualRows.map(({ addr, node }) => {
                      const meta = node ? nodeStatusMeta(node) : null
                      const proxyBlocked = proxyMode && node !== null && !isProxyCapable(node.type)
                      const clickable = node !== null &&
                        isProtocolSupported(node.type) &&
                        !proxyBlocked &&
                        (isNodeConnectable(node) || (meta?.state === 'unhealthy' && healthAcknowledged))
                      return (
                        <button
                          key={addr}
                          type="button"
                          disabled={!clickable}
                          title={proxyBlocked ? 'Not available in local proxy mode, needs v2ray, xray or hysteria2' : undefined}
                          onClick={() => setSelectedAddr(addr)}
                          className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                            selectedAddr === addr ? 'bg-accent/10' : 'hover:bg-bg-tertiary'
                          } ${clickable ? '' : 'opacity-40 cursor-not-allowed'}`}
                        >
                          {node && <CountryFlag country={node.country} />}
                          <span className="text-text-primary flex-1 truncate">
                            {node ? node.moniker : `${addr.slice(0, 16)}...`}
                          </span>
                          {node && (
                            <span className={`text-xs ${protocolMeta(node.type).color}`}>
                              {protocolMeta(node.type).short}
                            </span>
                          )}
                          {meta && <span className={`status-dot ${meta.dotClass}`} title={meta.label} />}
                        </button>
                      )
                    })}
                  </div>
                )}
                {manualRows !== null && manualRows.some((r) => r.node && nodeStatusMeta(r.node).state === 'unhealthy') && (
                  <label className="flex items-start gap-2 cursor-pointer text-xs text-text-secondary">
                    <input
                      type="checkbox"
                      checked={healthAcknowledged}
                      onChange={(e) => setHealthAcknowledged(e.target.checked)}
                      className="accent-accent mt-0.5"
                    />
                    <span>
                      Allow nodes that last failed the network health check. That check can be
                      hours out of date; a failed handshake is cancelled and refunded automatically.
                    </span>
                  </label>
                )}
                {proxyToggle}
                <button
                  onClick={handleManualConnect}
                  disabled={!selectedNode || cantAfford}
                  className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {isReuse ? 'Connect to this node' : 'Subscribe and connect to this node'}
                </button>
              </div>
            )}
          </>
        )}

        {connecting && (
          <ProgressList stages={stagesFor(kind)} currentStep={currentStep} stepDetail={stepDetail} error={error} />
        )}

        {error && !connecting && (
          <ConnectErrorActions
            error={error}
            paidSessionId={paidProtocol ? sessionId : null}
            onRetryTunnel={() => retryTunnel()}
            onStartOver={reset}
            onRetryWithoutDns={paidProtocol ? () => retryTunnel(true) : undefined}
          />
        )}

        {tunnelConnected && sessionId && (
          <div className="space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">Session ID</span>
                <span className="text-success font-mono">{sessionId}</span>
              </div>
              {connectedNodeLabel && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">Node</span>
                  <span className="text-text-primary">{connectedNodeLabel}</span>
                </div>
              )}
              {smartResult && smartResult.attempts.length > 0 && (
                <div className="text-text-tertiary text-xs">
                  Skipped {smartResult.attempts.length} node{smartResult.attempts.length === 1 ? '' : 's'}:{' '}
                  {smartResult.attempts.map((a) => a.moniker).join(', ')}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="status-dot status-dot-active" />
              <span className="text-success font-medium">
                {proxyMode ? 'Local proxy active' : 'VPN tunnel active'}
              </span>
            </div>
            {proxyMode && (
              <p className="text-text-tertiary text-sm">
                SOCKS5 proxy at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only
                apps configured to use it are tunneled.
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="btn btn-danger flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {disconnecting ? 'Disconnecting...' : 'Disconnect'}
              </button>
              <button onClick={onClose} className="btn btn-primary flex-1">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
