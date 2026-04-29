import { useState, useEffect, useCallback } from 'react'
import type { WalletEntry, AppSettings } from '../types'
import Toggle from './Toggle'
import { useSettings } from '../contexts/SettingsContext'
import { CHAIN_ID, DENOM, GAS_PRICE_STR } from '../../shared/chain-constants'

interface PendingNumbers {
  pollStatusSec: number
  pollIpSec: number
  pollBalanceSec: number
  pollAllocationSec: number
  planDiscoveryMaxId: number
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

interface NumberFieldProps {
  label: string
  unit: string
  min: number
  max: number
  value: number
  onChange: (value: number) => void
  onBlur: (value: number) => void
  help?: string
}

function NumberField({ label, unit, min, max, value, onChange, onBlur, help }: NumberFieldProps) {
  return (
    <div className="bg-bg-tertiary border border-border rounded-md px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-text-primary text-xs">{label}</span>
        <span className="text-text-tertiary text-xs">{min}–{max}{unit ? ` ${unit}` : ''}</span>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={min}
          max={max}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          onBlur={(e) => onBlur(parseInt(e.target.value, 10))}
          className="flex-1 bg-bg-primary border border-border text-text-primary text-sm font-mono px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus"
        />
        {unit && <span className="text-text-tertiary text-xs">{unit}</span>}
      </div>
      {help && <p className="text-text-tertiary text-xs mt-1">{help}</p>}
    </div>
  )
}

interface Props {
  currentAddress: string | null
  onClose: () => void
  onWalletSwitch: () => void
}

const KNOWN_RPC_ENDPOINTS = [
  { url: 'https://rpc.sentinel.co:443', region: 'Global' },
  { url: 'https://rpc-sentinel.busurnode.com:443', region: 'EU' },
  { url: 'https://sentinel-rpc.publicnode.com:443', region: 'Global' },
  { url: 'https://rpc.sentinel.quokkastake.io:443', region: 'EU' },
  { url: 'https://sentinel-rpc.polkachu.com:443', region: 'US' },
  { url: 'https://sentinel.rpc.nodeshub.online:443', region: 'EU' },
  { url: 'https://rpc-sentinel.whispernode.com:443', region: 'US' },
  { url: 'https://sentinel-rpc.validatornode.com:443', region: 'Global' },
  { url: 'https://rpc.sentinel.chaintools.tech:443', region: 'US' },
  { url: 'https://sentinel-rpc.badgerbite.io:443', region: 'EU' },
  { url: 'https://sentinel-rpc.openbitlab.com:443', region: 'EU' },
  { url: 'https://rpc-sentinel-ia.cosmosia.notional.ventures:443', region: 'US' },
  { url: 'https://sentinel-rpc.0base.dev:443', region: 'Asia' },
  { url: 'https://sentinel.declab.pro:26628', region: 'EU' },
  { url: 'https://sentinel-mainnet-rpc.autostake.com:443', region: 'US' },
  { url: 'https://rpc.dvpn.me:443', region: 'EU' },
  { url: 'https://rpc.mathnodes.com:443', region: 'US' },
  { url: 'https://rpc.noncompliant.network:443', region: 'Global' },
]

const DNS_OPTIONS = [
  { label: 'System Default', value: 'system' },
  { label: 'Cloudflare (1.1.1.1)', value: '1.1.1.1' },
  { label: 'Cloudflare WARP (1.0.0.1)', value: '1.0.0.1' },
  { label: 'Google (8.8.8.8)', value: '8.8.8.8' },
  { label: 'Quad9 (9.9.9.9)', value: '9.9.9.9' },
  { label: 'NextDNS (45.90.28.0)', value: '45.90.28.0' },
]

export default function Settings({ currentAddress, onClose, onWalletSwitch }: Props) {
  const { reload: reloadGlobalSettings } = useSettings()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [wallets, setWallets] = useState<WalletEntry[]>([])
  const [rpcInput, setRpcInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [savingAdvanced, setSavingAdvanced] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [tab, setTab] = useState<'general' | 'wallets'>('general')
  const [rpcChecking, setRpcChecking] = useState<string | null>(null)
  const [rpcLatency, setRpcLatency] = useState<Record<string, number>>({})
  const [splitTunnelInput, setSplitTunnelInput] = useState('')
  const [pending, setPending] = useState<PendingNumbers | null>(null)

  const load = useCallback(async () => {
    const [s, w] = await Promise.all([
      window.api.settingsGet(),
      window.api.walletList(),
    ])
    setSettings(s)
    setRpcInput(s.rpcEndpoint)
    setSplitTunnelInput((s.splitTunnelRoutes || []).join('\n'))
    setWallets(w)
    setPending({
      pollStatusSec: s.pollStatusSec,
      pollIpSec: s.pollIpSec,
      pollBalanceSec: s.pollBalanceSec,
      pollAllocationSec: s.pollAllocationSec,
      planDiscoveryMaxId: s.planDiscoveryMaxId,
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function saveRpc() {
    if (!rpcInput.trim()) return
    setSaving(true)
    try {
      const updated = await window.api.settingsSet({ rpcEndpoint: rpcInput.trim() })
      setSettings(updated)
      await reloadGlobalSettings()
    } finally {
      setSaving(false)
    }
  }

  async function saveAdvanced() {
    if (!pending) return
    setSavingAdvanced(true)
    try {
      const updated = await window.api.settingsSet({
        pollStatusSec: clamp(pending.pollStatusSec, 1, 30),
        pollIpSec: clamp(pending.pollIpSec, 30, 300),
        pollBalanceSec: clamp(pending.pollBalanceSec, 60, 600),
        pollAllocationSec: clamp(pending.pollAllocationSec, 30, 600),
        planDiscoveryMaxId: clamp(pending.planDiscoveryMaxId, 100, 1000),
      })
      setSettings(updated)
      setPending({
        pollStatusSec: updated.pollStatusSec,
        pollIpSec: updated.pollIpSec,
        pollBalanceSec: updated.pollBalanceSec,
        pollAllocationSec: updated.pollAllocationSec,
        planDiscoveryMaxId: updated.planDiscoveryMaxId,
      })
      await reloadGlobalSettings()
    } finally {
      setSavingAdvanced(false)
    }
  }

  function hasAdvancedChanges(): boolean {
    if (!settings || !pending) return false
    return (
      pending.pollStatusSec !== settings.pollStatusSec ||
      pending.pollIpSec !== settings.pollIpSec ||
      pending.pollBalanceSec !== settings.pollBalanceSec ||
      pending.pollAllocationSec !== settings.pollAllocationSec ||
      pending.planDiscoveryMaxId !== settings.planDiscoveryMaxId
    )
  }

  async function handleSwitch(walletId: string) {
    await window.api.walletSwitch(walletId)
    onWalletSwitch()
  }

  async function handleDelete(wallet: WalletEntry) {
    if (!confirm(`Delete wallet "${wallet.name}"?\n\nAddress: ${wallet.address}\n\nThis removes the encrypted seed from this device. Make sure you have a backup!`)) {
      return
    }
    await window.api.walletDelete(wallet.id)
    await load()
    if (wallet.address === currentAddress) {
      onWalletSwitch()
    }
  }

  async function handleRename(walletId: string) {
    if (!nameInput.trim()) return
    await window.api.walletRename(walletId, nameInput.trim())
    setEditingName(null)
    setNameInput('')
    await load()
  }

  if (!settings) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-text-primary text-base font-semibold">Settings</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg transition-colors">
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border px-6 shrink-0">
          {(['general', 'wallets'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {tab === 'general' && (
            <>
              {/* VPN Security */}
              <div className="space-y-3">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                  VPN Security
                </label>

                {/* Kill Switch */}
                <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                  <div>
                    <span className="text-text-primary text-sm">Kill Switch</span>
                    <p className="text-text-tertiary text-xs mt-0.5">Block all traffic if VPN drops</p>
                  </div>
                  <Toggle
                    checked={settings.killSwitch}
                    onChange={async (checked) => {
                      const updated = await window.api.settingsSet({ killSwitch: checked })
                      setSettings(updated)
                    }}
                  />
                </div>

                {/* Auto-Reconnect */}
                <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                  <div>
                    <span className="text-text-primary text-sm">Auto-Reconnect</span>
                    <p className="text-text-tertiary text-xs mt-0.5">Reconnect automatically on unexpected disconnect (up to 5 attempts)</p>
                  </div>
                  <Toggle
                    checked={settings.autoReconnect}
                    onChange={async (checked) => {
                      const updated = await window.api.settingsSet({ autoReconnect: checked })
                      setSettings(updated)
                    }}
                  />
                </div>
              </div>

              {/* DNS Resolver */}
              <div className="space-y-3">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                  DNS Resolver
                </label>
                <select
                  value={settings.dnsResolver}
                  onChange={async (e) => {
                    const updated = await window.api.settingsSet({ dnsResolver: e.target.value })
                    setSettings(updated)
                  }}
                  className="w-full bg-bg-tertiary border border-border text-text-primary text-sm px-3 py-2 rounded-sm focus:outline-none focus:border-border-focus"
                >
                  {DNS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-text-tertiary text-xs">
                  Applied when VPN connects. Prevents DNS leaks to your ISP.
                </p>
              </div>

              {/* Split Tunneling */}
              <div className="space-y-3">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                  Split Tunneling
                </label>
                <textarea
                  value={splitTunnelInput}
                  onChange={(e) => setSplitTunnelInput(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border text-text-primary text-sm font-mono px-3 py-2 rounded-sm focus:outline-none focus:border-border-focus h-20 resize-none"
                  placeholder="10.0.0.0/8&#10;172.16.0.0/12&#10;192.168.0.0/16"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      const routes = splitTunnelInput.split('\n').map((r) => r.trim()).filter(Boolean)
                      const updated = await window.api.settingsSet({ splitTunnelRoutes: routes })
                      setSettings(updated)
                      setSplitTunnelInput(updated.splitTunnelRoutes.join('\n'))
                    }}
                    disabled={splitTunnelInput === (settings.splitTunnelRoutes || []).join('\n')}
                    className="btn btn-primary text-xs px-3 disabled:opacity-30"
                  >
                    Save Routes
                  </button>
                  <button
                    onClick={() => {
                      const defaults = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
                      setSplitTunnelInput(defaults.join('\n'))
                    }}
                    className="text-text-secondary text-xs hover:text-accent transition-colors"
                  >
                    Reset
                  </button>
                </div>
                <p className="text-text-tertiary text-xs">
                  CIDR routes (one per line) that bypass the VPN tunnel. Private networks are excluded by default.
                </p>
              </div>

              {/* RPC Endpoint */}
              <div className="space-y-3">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                  RPC Endpoint
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={rpcInput}
                    onChange={(e) => setRpcInput(e.target.value)}
                    className="flex-1 bg-bg-tertiary border border-border text-text-primary text-sm font-mono px-3 py-2 rounded-sm focus:outline-none focus:border-border-focus"
                    placeholder="https://rpc.sentinel.co:443"
                  />
                  <button
                    onClick={saveRpc}
                    disabled={saving || rpcInput === settings.rpcEndpoint}
                    className="btn btn-primary text-sm px-4 disabled:opacity-30"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>

                <div className="space-y-1.5">
                  <span className="text-text-secondary text-xs">Known endpoints:</span>
                  <div className="grid grid-cols-2 gap-1.5 max-h-[200px] overflow-y-auto">
                    {KNOWN_RPC_ENDPOINTS.map((ep) => (
                      <button
                        key={ep.url}
                        onClick={async () => {
                          setRpcInput(ep.url)
                          setRpcChecking(ep.url)
                          try {
                            const result = await window.api.rpcCheck(ep.url)
                            setRpcLatency((prev) => ({ ...prev, [ep.url]: result.latencyMs }))
                          } catch { /* silent */ }
                          setRpcChecking(null)
                        }}
                        className={`text-xs px-2.5 py-2 border transition-colors text-left flex items-center justify-between gap-1 rounded-md ${
                          rpcInput === ep.url
                            ? 'border-accent text-accent'
                            : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                        }`}
                      >
                        <span className="truncate font-mono">
                          {settings.rpcEndpoint === ep.url && <span className="text-success mr-1">●</span>}
                          {ep.url.replace('https://', '').replace(':443', '')}
                        </span>
                        <span className="shrink-0 text-text-tertiary">
                          {rpcChecking === ep.url ? '...' : rpcLatency[ep.url] ? `${rpcLatency[ep.url]}ms` : ep.region}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {rpcInput !== settings.rpcEndpoint && (
                  <p className="text-warning text-xs">
                    Unsaved changes. Click Save to apply.
                  </p>
                )}
              </div>

              {/* Pricing Preference */}
              <div className="space-y-3">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                  Pricing Preference
                </label>
                <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                  <div>
                    <span className="text-text-primary text-sm">Prefer hourly pricing when cheaper</span>
                    <p className="text-text-tertiary text-xs mt-0.5">When opening a node, default to hourly if it costs less per equivalent usage</p>
                  </div>
                  <Toggle
                    checked={settings.preferHourlyWhenCheaper}
                    onChange={async (checked) => {
                      const updated = await window.api.settingsSet({ preferHourlyWhenCheaper: checked })
                      setSettings(updated)
                      await reloadGlobalSettings()
                    }}
                  />
                </div>
              </div>

              {/* Polling Intervals */}
              {pending && (
                <div className="space-y-3">
                  <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                    Polling Intervals
                  </label>
                  <p className="text-text-tertiary text-xs leading-relaxed">
                    How often the app re-queries live data. Lower values mean fresher numbers but more network activity.
                    Changes apply immediately — no restart needed. Defaults are fine for most users.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      label="Status check"
                      unit="sec"
                      min={1}
                      max={30}
                      value={pending.pollStatusSec}
                      onChange={(v) => setPending({ ...pending, pollStatusSec: v })}
                      onBlur={(v) => setPending({ ...pending, pollStatusSec: clamp(v, 1, 30) })}
                      help="How often the VPN tunnel state is re-queried. Drives the connection indicator in the top bar and the reconnect UI."
                    />
                    <NumberField
                      label="IP check"
                      unit="sec"
                      min={30}
                      max={300}
                      value={pending.pollIpSec}
                      onChange={(v) => setPending({ ...pending, pollIpSec: v })}
                      onBlur={(v) => setPending({ ...pending, pollIpSec: clamp(v, 30, 300) })}
                      help="How often your public IP and geolocation refresh in the header. Paused while VPN is connected or the window is hidden."
                    />
                    <NumberField
                      label="Balance check"
                      unit="sec"
                      min={60}
                      max={600}
                      value={pending.pollBalanceSec}
                      onChange={(v) => setPending({ ...pending, pollBalanceSec: v })}
                      onBlur={(v) => setPending({ ...pending, pollBalanceSec: clamp(v, 60, 600) })}
                      help="How often your wallet balance is re-read from the chain. Shown in the wallet panel."
                    />
                    <NumberField
                      label="Allocation check"
                      unit="sec"
                      min={30}
                      max={600}
                      value={pending.pollAllocationSec}
                      onChange={(v) => setPending({ ...pending, pollAllocationSec: v })}
                      onBlur={(v) => setPending({ ...pending, pollAllocationSec: clamp(v, 30, 600) })}
                      help="How often active sessions and plan subscriptions refresh. Drives the Active Sessions panel and the Plans tab."
                    />
                  </div>
                </div>
              )}

              {/* Plan Discovery */}
              {pending && (
                <div className="space-y-3">
                  <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                    Plan Discovery
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      label="Max plan ID to probe"
                      unit=""
                      min={100}
                      max={1000}
                      value={pending.planDiscoveryMaxId}
                      onChange={(v) => setPending({ ...pending, planDiscoveryMaxId: v })}
                      onBlur={(v) => setPending({ ...pending, planDiscoveryMaxId: clamp(v, 100, 1000) })}
                      help="Ceiling for plan scan"
                    />
                  </div>
                </div>
              )}

              {/* Advanced Save button */}
              {pending && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveAdvanced}
                    disabled={savingAdvanced || !hasAdvancedChanges()}
                    className="btn btn-primary text-sm px-4 disabled:opacity-30"
                  >
                    {savingAdvanced ? 'Saving...' : 'Save Settings'}
                  </button>
                  {hasAdvancedChanges() && (
                    <span className="text-warning text-xs">Unsaved changes</span>
                  )}
                </div>
              )}

              {/* Chain */}
              <div className="space-y-3">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                  Chain
                </label>
                <div className="border border-border bg-bg-tertiary rounded-md divide-y divide-border">
                  <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-text-secondary">Chain ID</span>
                    <span className="text-text-primary font-mono">{CHAIN_ID}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-text-secondary">Denom</span>
                    <span className="text-text-primary font-mono">{DENOM}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-text-secondary">Gas Price</span>
                    <span className="text-text-primary font-mono">{GAS_PRICE_STR}</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === 'wallets' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide">
                  Stored Wallets ({wallets.length})
                </label>
              </div>

              {wallets.length === 0 && (
                <p className="text-text-secondary text-sm">No wallets stored. Import or create one from the main screen.</p>
              )}

              <div className="space-y-2">
                {wallets.map((w) => {
                  const isActive = w.address === currentAddress
                  const isEditing = editingName === w.id

                  return (
                    <div
                      key={w.id}
                      className={`border px-4 py-3 space-y-2 rounded-md ${
                        isActive ? 'border-success bg-success-subtle' : 'border-border bg-bg-tertiary'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={nameInput}
                                onChange={(e) => setNameInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleRename(w.id)}
                                className="bg-bg-primary border border-border text-text-primary text-sm px-2 py-1 w-40 rounded-sm focus:outline-none focus:border-border-focus"
                                autoFocus
                              />
                              <button
                                onClick={() => handleRename(w.id)}
                                className="text-success text-xs hover:underline"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditingName(null)}
                                className="text-text-secondary text-xs hover:underline"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <>
                              <span className="text-text-primary text-sm font-semibold">{w.name}</span>
                              <button
                                onClick={() => { setEditingName(w.id); setNameInput(w.name) }}
                                className="text-text-secondary text-xs hover:text-accent transition-colors"
                              >
                                Rename
                              </button>
                            </>
                          )}
                          {isActive && (
                            <span className="text-success text-xs font-medium">Active</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {!isActive && (
                            <button
                              onClick={() => handleSwitch(w.id)}
                              className="btn btn-primary text-xs px-3 py-1"
                            >
                              Switch
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(w)}
                            className="btn btn-danger text-xs px-3 py-1"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      <div className="text-text-secondary text-xs font-mono break-all">
                        {w.address || 'Address will appear after switching to this wallet'}
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="text-text-tertiary text-xs">
                To add a new wallet, log out and import or create a new seed phrase. Each wallet's seed is encrypted with your OS keyring.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
