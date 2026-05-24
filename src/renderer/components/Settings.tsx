import { useState, useEffect, useCallback } from 'react'
import type { WalletEntry, AppSettings, PublicRpc } from '../types'
import Toggle from './Toggle'
import ThemeToggle from './ThemeToggle'
import Spinner from './Spinner'
import { useSettings } from '../contexts/SettingsContext'

interface Props {
  currentAddress: string | null
  onClose: () => void
  onWalletSwitch: () => void
  // Called after a wallet rename / derive succeeds, so the top-bar Wallet
  // popover can re-fetch the active wallet's display name.
  onWalletsChanged?: () => void
}

const DNS_OPTIONS = [
  { label: 'System Default', value: 'system' },
  { label: 'Cloudflare (1.1.1.1)', value: '1.1.1.1' },
  { label: 'Cloudflare WARP (1.0.0.1)', value: '1.0.0.1' },
  { label: 'Google (8.8.8.8)', value: '8.8.8.8' },
  { label: 'Quad9 (9.9.9.9)', value: '9.9.9.9' },
  { label: 'NextDNS (45.90.28.0)', value: '45.90.28.0' },
]

export default function Settings({ currentAddress, onClose, onWalletSwitch, onWalletsChanged }: Props) {
  const { reload: reloadGlobalSettings } = useSettings()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [wallets, setWallets] = useState<WalletEntry[]>([])
  const [rpcInput, setRpcInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [tab, setTab] = useState<'general' | 'network' | 'wallets'>('general')
  const [rpcChecking, setRpcChecking] = useState<string | null>(null)
  const [rpcLatency, setRpcLatency] = useState<Record<string, number>>({})
  const [splitTunnelInput, setSplitTunnelInput] = useState('')
  const [knownRpcs, setKnownRpcs] = useState<PublicRpc[]>([])
  const [rpcsLoading, setRpcsLoading] = useState(true)
  const [rpcsError, setRpcsError] = useState<string | null>(null)
  // Derive-subaccount modal state. `source` is the wallet whose mnemonic we'll
  // reuse; `index` is the BIP-44 account index to derive at.
  const [deriveSource, setDeriveSource] = useState<WalletEntry | null>(null)
  const [deriveName, setDeriveName] = useState('')
  const [deriveIndex, setDeriveIndex] = useState('1')
  const [deriveError, setDeriveError] = useState('')
  const [deriveLoading, setDeriveLoading] = useState(false)

  const load = useCallback(async () => {
    const [s, w] = await Promise.all([
      window.api.settingsGet(),
      window.api.walletList(),
    ])
    setSettings(s)
    setRpcInput(s.rpcEndpoint)
    setSplitTunnelInput((s.splitTunnelRoutes || []).join('\n'))
    setWallets(w)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Fetch the live public RPC list from sentnodes.com (cached in main for 60s)
  useEffect(() => {
    let cancelled = false
    setRpcsLoading(true)
    setRpcsError(null)
    window.api.rpcList()
      .then((rpcs) => {
        if (cancelled) return
        setKnownRpcs(rpcs)
        setRpcsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRpcsError(err instanceof Error ? err.message : 'Failed to load RPCs')
        setRpcsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

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
    onWalletsChanged?.()
  }

  function openDeriveModal(source: WalletEntry) {
    // Suggest the smallest non-zero index not already in use, since the user
    // is starting from an existing wallet (which is most likely at index 0).
    const used = new Set(wallets.map((w) => w.accountIndex ?? 0))
    let next = 1
    while (used.has(next)) next += 1
    setDeriveSource(source)
    setDeriveName('')
    setDeriveIndex(String(next))
    setDeriveError('')
  }

  function closeDeriveModal() {
    setDeriveSource(null)
    setDeriveName('')
    setDeriveIndex('')
    setDeriveError('')
    setDeriveLoading(false)
  }

  async function submitDerive() {
    if (!deriveSource) return
    setDeriveError('')
    const name = deriveName.trim()
    if (!name) {
      setDeriveError('Please enter a wallet name')
      return
    }
    const idx = parseInt(deriveIndex, 10)
    if (!Number.isInteger(idx) || idx < 0) {
      setDeriveError('Account index must be a non-negative integer')
      return
    }
    setDeriveLoading(true)
    try {
      await window.api.walletDeriveSubaccount({
        sourceWalletId: deriveSource.id,
        accountIndex: idx,
        name,
      })
      closeDeriveModal()
      await load()
      onWalletsChanged?.()
    } catch (err) {
      setDeriveError(err instanceof Error ? err.message : 'Failed to derive subaccount')
      setDeriveLoading(false)
    }
  }

  // Show the account-index pill on each wallet row only when at least one
  // wallet is a non-default subaccount — avoids noise for single-account users.
  const showAccountIndex = wallets.some((w) => (w.accountIndex ?? 0) > 0)

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
          {(['general', 'network', 'wallets'] as const).map((t) => (
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
              {/* Appearance */}
              <div className="space-y-3">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                  Appearance
                </label>
                <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                  <div>
                    <span className="text-text-primary text-sm">Theme</span>
                    <p className="text-text-tertiary text-xs mt-0.5">Light, system, or dark color scheme</p>
                  </div>
                  <ThemeToggle />
                </div>
              </div>

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

            </>
          )}

          {tab === 'network' && (
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
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary text-xs">
                    Public endpoints from <a href="https://sentnodes.com/public-rpc" target="_blank" rel="noreferrer" className="hover:text-accent transition-colors">sentnodes.com</a>:
                  </span>
                  {rpcsLoading && (
                    <span className="text-text-tertiary text-xs flex items-center gap-1">
                      <Spinner /> Loading
                    </span>
                  )}
                </div>
                {rpcsError && (
                  <p className="text-danger text-xs">Failed to load RPC list: {rpcsError}</p>
                )}
                <div className="grid grid-cols-2 gap-1.5 max-h-[200px] overflow-y-auto">
                  {knownRpcs.map((ep) => (
                    <button
                      key={ep.address}
                      onClick={async () => {
                        setRpcInput(ep.address)
                        setRpcChecking(ep.address)
                        try {
                          const result = await window.api.rpcCheck(ep.address)
                          setRpcLatency((prev) => ({ ...prev, [ep.address]: result.latencyMs }))
                        } catch { /* silent */ }
                        setRpcChecking(null)
                      }}
                      className={`text-xs px-2.5 py-2 border transition-colors text-left flex items-center justify-between gap-1 rounded-md ${
                        rpcInput === ep.address
                          ? 'border-accent text-accent'
                          : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                      }`}
                      title={`${ep.provider}\nHeight: ${ep.height.toLocaleString('en')}\nAvailability: ${ep.availability}%`}
                    >
                      <span className="truncate font-mono">
                        {settings.rpcEndpoint === ep.address && <span className="text-success mr-1">●</span>}
                        {ep.address.replace('https://', '').replace(':443', '')}
                      </span>
                      <span className="shrink-0 text-text-tertiary">
                        {rpcChecking === ep.address ? '...' : rpcLatency[ep.address] ? `${rpcLatency[ep.address]}ms` : ep.location}
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
                              {showAccountIndex && (
                                <span className="text-text-tertiary text-xs font-mono">
                                  Account {w.accountIndex ?? 0}
                                </span>
                              )}
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
                            onClick={() => openDeriveModal(w)}
                            className="text-text-secondary text-xs hover:text-accent transition-colors px-2"
                            title="Derive a new wallet from this seed at a different account index"
                          >
                            Derive Subaccount
                          </button>
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
                To add a new wallet, log out and import or create a new seed phrase. To derive a second address from an existing seed, use Derive Subaccount. Each wallet's seed is encrypted with your OS keyring.
              </p>
            </div>
          )}
        </div>
      </div>

      {deriveSource && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]"
          onClick={() => !deriveLoading && closeDeriveModal()}
        >
          <div
            className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-5 space-y-4 rounded-lg shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-text-primary text-base font-semibold">Derive Subaccount</h3>
              <p className="text-text-tertiary text-xs mt-1">
                Creates a new wallet from the seed of <span className="text-text-secondary">{deriveSource.name}</span> at a different BIP-44 account index. Same seed, different address.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">Wallet name</label>
              <input
                type="text"
                value={deriveName}
                onChange={(e) => setDeriveName(e.target.value)}
                placeholder="e.g. Sub 1"
                maxLength={100}
                autoFocus
                className="w-full bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
              />
            </div>

            <div className="space-y-2">
              <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">Account index</label>
              <input
                type="number"
                min={0}
                value={deriveIndex}
                onChange={(e) => setDeriveIndex(e.target.value)}
                className="w-full bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus font-mono"
              />
              <p className="text-text-tertiary text-xs font-mono">
                m/44'/118'/{deriveIndex || '?'}'/0/0
              </p>
            </div>

            {deriveError && (
              <p className="text-danger text-xs">{deriveError}</p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={closeDeriveModal}
                disabled={deriveLoading}
                className="text-text-secondary hover:text-text-primary text-sm px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitDerive}
                disabled={deriveLoading || !deriveName.trim()}
                className="btn btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
              >
                {deriveLoading ? 'Deriving...' : 'Derive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
