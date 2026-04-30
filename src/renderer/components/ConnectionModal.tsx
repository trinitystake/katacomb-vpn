import { useState, useEffect } from 'react'
import type { SentNode, NodeProbeResult, PlanInfo, PlanAllocation } from '../types'
import ProgressSteps from './ProgressSteps'
import Spinner from './Spinner'
import { useSettings } from '../contexts/SettingsContext'
import { useNavigation } from '../contexts/NavigationContext'

interface Props {
  node: SentNode
  onClose: () => void
}

function getUdvpnPrice(prices: { denom: string; value: string }[]): { raw: string; display: string } | null {
  const p = prices.find((x) => x.denom === 'udvpn')
  if (!p) return null
  const display = (parseInt(p.value, 10) / 1e6).toFixed(2)
  return { raw: p.value, display }
}

function hourlyIsCheaper(
  gbPrice: { raw: string } | null,
  hrPrice: { raw: string } | null
): boolean {
  if (!gbPrice || !hrPrice) return false
  // Compare cost of 1 hour vs cost of ~1 GB.
  // A reasonable usage baseline: if 1 hour of VPN costs less than 1 GB of VPN,
  // hourly is cheaper for light users. Exact "equivalent" is subjective — we
  // use this simple comparison as the heuristic the UI defaults off of.
  const gb = parseInt(gbPrice.raw, 10)
  const hr = parseInt(hrPrice.raw, 10)
  if (!Number.isFinite(gb) || !Number.isFinite(hr)) return false
  return hr < gb
}

export default function ConnectionModal({ node, onClose }: Props) {
  const active = node.isActive && node.isHealthy
  const { settings } = useSettings()
  const { goToPlansForNode } = useNavigation()
  // Plans compatible with THIS node. null = still loading.
  const [compatiblePlans, setCompatiblePlans] = useState<PlanInfo[] | null>(null)
  // User's existing plan allocations (subscriptions). Used to detect reuse vs. fresh subscribe.
  const [allocations, setAllocations] = useState<PlanAllocation[]>([])
  const gbPriceInit = getUdvpnPrice(node.gigabytePrices)
  const hrPriceInit = getUdvpnPrice(node.hourlyPrices)
  const preferHourly = settings?.preferHourlyWhenCheaper ?? false
  const defaultSubType: 'gigabytes' | 'hours' =
    preferHourly && hourlyIsCheaper(gbPriceInit, hrPriceInit) ? 'hours' : 'gigabytes'
  const [subType, setSubType] = useState<'gigabytes' | 'hours'>(defaultSubType)
  const [amount, setAmount] = useState(1)
  const [balance, setBalance] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [vpnWarning, setVpnWarning] = useState<{ type: string; name: string; iface?: string }[] | null>(null)
  const [probeResult, setProbeResult] = useState<NodeProbeResult | null>(null)
  const [probing, setProbing] = useState(false)

  const gbPrice = getUdvpnPrice(node.gigabytePrices)
  const hrPrice = getUdvpnPrice(node.hourlyPrices)
  const selectedPrice = subType === 'gigabytes' ? gbPrice : hrPrice
  const totalCost = selectedPrice ? (parseInt(selectedPrice.raw, 10) * amount / 1e6).toFixed(2) : '—'

  useEffect(() => {
    window.api.walletGetBalance().then((balances) => {
      const udvpn = balances.find((b: { denom: string }) => b.denom === 'udvpn')
      setBalance(udvpn ? (parseInt(udvpn.amount, 10) / 1e6).toFixed(2) : '0.00')
    })
  }, [])

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

      setCurrentStep('5/5')
      await window.api.connectionConnect({
        protocol: protocol as 'wireguard' | 'v2ray',
      })

      setTunnelConnected(true)
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
      await window.api.connectionDisconnect()
      setTunnelConnected(false)
      setSessionId(null)
      setCurrentStep(null)
      onClose()
    } finally {
      setDisconnecting(false)
    }
  }

  const title = tunnelConnected
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
          <h2 className="text-text-primary text-base font-semibold">
            {title}
          </h2>
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
          <div className="flex justify-between">
            <span className="text-text-secondary">Address</span>
            <span className="text-text-primary truncate ml-4 max-w-[280px] font-mono text-xs">{node.address}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Location</span>
            <span className="text-text-primary">{node.country}{node.city ? `, ${node.city}` : ''}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Type</span>
            <span className={node.type === 1 ? 'text-info' : 'text-warning'}>
              {node.type === 1 ? 'WireGuard' : 'V2Ray'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Status</span>
            <span className="flex items-center gap-2">
              <span className={`status-dot ${active ? 'status-dot-active' : 'status-dot-inactive'}`} />
              <span className={active ? 'text-success' : 'text-text-tertiary'}>
                {active ? 'Active' : 'Inactive'}
              </span>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Latency</span>
            {probing ? (
              <span className="flex items-center gap-2 text-text-tertiary">
                <Spinner className="text-accent" /> Measuring…
              </span>
            ) : probeResult ? (
              <span className={`font-mono ${probeResult.reachable ? 'text-success' : 'text-danger'}`}>
                {probeResult.reachable
                  ? `${probeResult.latencyMs}ms — Reachable`
                  : `Unreachable${probeResult.error ? ` — ${probeResult.error}` : ''}`}
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
                      <span className="text-danger ml-2">— will be disconnected</span>
                    )}
                    {v.type !== 'wireguard' && (
                      <span className="text-warning ml-2">— may cause routing conflicts</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleSubscribe()}
                className="btn btn-primary flex-1"
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

        {/* Subscription form */}
        {!tunnelConnected && !connecting && !error && !vpnWarning && (
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

            <button
              onClick={handleSubscribe}
              disabled={!active || (!matchingAllocation && !selectedPrice)}
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {matchingAllocation ? 'Connect via Plan' : 'Subscribe & Connect'}
            </button>

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
          <div className="space-y-3">
            <div className="bg-danger-subtle border border-danger p-3 rounded-md">
              <p className="text-danger text-sm">{error}</p>
            </div>
            <button
              onClick={() => { setError(null); setCurrentStep(null); setSessionId(null) }}
              className="btn btn-primary w-full"
            >
              Try Again
            </button>
          </div>
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
                <span className="text-text-primary">{node.type === 1 ? 'WireGuard' : 'V2Ray'}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="status-dot status-dot-active" />
              <span className="text-success font-medium">VPN tunnel active</span>
            </div>

            {node.type === 1 && (
              <p className="text-text-tertiary text-sm">
                WireGuard interface is up. Your traffic is now routed through this node.
              </p>
            )}

            <button onClick={handleDisconnect} disabled={disconnecting} className="btn btn-danger w-full flex items-center justify-center gap-2 disabled:opacity-50">
              {disconnecting ? <><Spinner className="text-white" /> Disconnecting...</> : 'Disconnect'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
