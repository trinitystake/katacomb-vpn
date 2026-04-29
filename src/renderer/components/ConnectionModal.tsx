import { useState, useEffect } from 'react'
import type { SentNode, NodeProbeResult, PlanInfo } from '../types'
import ProgressSteps from './ProgressSteps'
import Spinner from './Spinner'
import { useSettings } from '../contexts/SettingsContext'

function formatBytes(bytes: string): string {
  const n = parseInt(bytes, 10)
  if (!Number.isFinite(n) || n === 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—'
  const days = Math.floor(seconds / 86400)
  if (days > 0) return `${days}d`
  const hours = Math.floor(seconds / 3600)
  if (hours > 0) return `${hours}h`
  const mins = Math.floor(seconds / 60)
  return `${mins}m`
}

interface PlanPickerProps {
  plans: PlanInfo[] | null // null = loading
  selectedPlanId: string | null
  onSelect: (id: string) => void
  balance: string | null
}

function PlanPicker({ plans, selectedPlanId, onSelect, balance }: PlanPickerProps) {
  if (plans === null) {
    return (
      <div className="border border-border bg-bg-tertiary rounded-md px-4 py-6 text-center">
        <Spinner />
        <p className="text-text-secondary text-sm mt-2">Loading compatible plans for this node…</p>
      </div>
    )
  }
  if (plans.length === 0) {
    return (
      <div className="border border-border bg-bg-tertiary rounded-md px-4 py-6 text-center">
        <p className="text-text-secondary text-sm mb-1">No plans available for this node</p>
        <p className="text-text-tertiary text-xs">No discovered plan currently lists this node as compatible.</p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="border border-border bg-bg-tertiary rounded-md max-h-[240px] overflow-y-auto divide-y divide-border">
        {plans.map((plan) => {
          const udvpn = plan.prices.find((p) => p.denom === 'udvpn')
          const priceDisplay = udvpn ? (parseInt(udvpn.quoteValue, 10) / 1e6).toFixed(2) : '—'
          const active = selectedPlanId === plan.id
          return (
            <button
              key={plan.id}
              type="button"
              onClick={() => onSelect(plan.id)}
              className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                active ? 'bg-accent/10' : 'hover:bg-bg-hover'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`font-mono font-semibold ${active ? 'text-accent' : 'text-text-primary'}`}>
                  #{plan.id}
                </span>
                <span className="text-text-primary font-mono">{priceDisplay} P2P</span>
              </div>
              <div className="flex items-center justify-between text-xs text-text-secondary">
                <span>{formatBytes(plan.bytes)} · {formatDuration(plan.durationSeconds)}</span>
                {active && <span className="text-accent">Selected</span>}
              </div>
              <div className="text-text-tertiary text-xs font-mono mt-1 truncate" title={plan.provAddress}>
                {plan.provAddress.slice(0, 20)}...{plan.provAddress.slice(-8)}
              </div>
            </button>
          )
        })}
      </div>
      {balance !== null && (
        <div className="text-sm text-text-secondary">
          Wallet balance: <span className="text-success font-mono">{balance} P2P</span>
        </div>
      )}
    </div>
  )
}

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
  // Plans compatible with THIS node. null = still loading.
  const [compatiblePlans, setCompatiblePlans] = useState<PlanInfo[] | null>(null)
  const gbPriceInit = getUdvpnPrice(node.gigabytePrices)
  const hrPriceInit = getUdvpnPrice(node.hourlyPrices)
  const preferHourly = settings?.preferHourlyWhenCheaper ?? false
  const defaultSubType: 'gigabytes' | 'hours' =
    preferHourly && hourlyIsCheaper(gbPriceInit, hrPriceInit) ? 'hours' : 'gigabytes'
  const [mode, setMode] = useState<'node' | 'plan'>('node')
  const [subType, setSubType] = useState<'gigabytes' | 'hours'>(defaultSubType)
  const [amount, setAmount] = useState(1)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
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
    const unsub = window.api.onConnectionProgress((step, _detail) => {
      setCurrentStep(step)
    })
    return unsub
  }, [])

  async function handleProbe() {
    setProbing(true)
    setProbeResult(null)
    try {
      const result = await window.api.nodeTestProbe({ nodeAddress: node.address, remoteUrl: node.api })
      setProbeResult(result)
    } catch {
      setProbeResult({ nodeAddress: node.address, timestamp: Date.now(), reachable: false, latencyMs: null, error: 'Probe failed' })
    } finally {
      setProbing(false)
    }
  }

  async function handleSubscribe() {
    if (mode === 'node' && !selectedPrice) return
    if (mode === 'plan' && !selectedPlanId) return

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

      if (mode === 'plan' && selectedPlanId) {
        const res = await window.api.planSubscribe({
          planId: selectedPlanId,
          denom: 'udvpn',
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
        </div>

        {/* Node probe test */}
        {!tunnelConnected && !connecting && !error && !vpnWarning && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleProbe}
              disabled={probing}
              className="text-sm text-text-secondary hover:text-accent transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {probing ? <><Spinner className="text-accent" /> Testing...</> : 'Test Node'}
            </button>
            {probeResult && (
              <span className={`text-sm font-mono ${probeResult.reachable ? 'text-success' : 'text-danger'}`}>
                {probeResult.reachable
                  ? `${probeResult.latencyMs}ms — Reachable`
                  : `Unreachable${probeResult.error ? ` — ${probeResult.error}` : ''}`
                }
              </span>
            )}
          </div>
        )}

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
            {compatiblePlans !== null && compatiblePlans.length > 0 && (
              <div className="flex gap-2 border border-border rounded-md p-0.5 bg-bg-tertiary">
                <button
                  onClick={() => setMode('node')}
                  className={`flex-1 text-xs py-1.5 rounded-sm transition-colors ${
                    mode === 'node' ? 'bg-accent text-bg-primary font-medium' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  Node Subscription
                </button>
                <button
                  onClick={() => setMode('plan')}
                  className={`flex-1 text-xs py-1.5 rounded-sm transition-colors ${
                    mode === 'plan' ? 'bg-accent text-bg-primary font-medium' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  Plan Subscription
                </button>
              </div>
            )}

            {mode === 'node' && (
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

            {mode === 'plan' && (
              <PlanPicker
                plans={compatiblePlans}
                selectedPlanId={selectedPlanId}
                onSelect={setSelectedPlanId}
                balance={balance}
              />
            )}

            <button
              onClick={handleSubscribe}
              disabled={
                !active ||
                (mode === 'node' && !selectedPrice) ||
                (mode === 'plan' && !selectedPlanId)
              }
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Subscribe & Connect
            </button>
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
