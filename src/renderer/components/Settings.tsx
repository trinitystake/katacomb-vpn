import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { WalletEntry, AppSettings, RpcCandidateInfo, DerivationPreview } from '../types'
import Toggle from './Toggle'
import Spinner from './Spinner'
import { useSettings } from '../contexts/SettingsContext'
import type { SettingsTab } from '../contexts/NavigationContext'
import { useRpcHealth } from '../hooks/useRpcHealth'
import { classifyRpc, rpcHealthLabel, rpcHostLabel, STALE_BLOCK_AGE_SEC } from '../../shared/rpc-health'
import { parseWalletExists } from '../../shared/wallet-errors'
import { formatHdPath, DERIVE_PREVIEW_MAX_COUNT } from '../../shared/hd-path'
import { STATE_DOT } from './RpcStatus'

interface Props {
  /** Which tab to land on — 'network' when something sent the user here to fix the RPC. */
  initialTab: SettingsTab
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

// Address indices shown per page in the derive picker, and how long a revealed
// recovery phrase stays on screen before it re-blurs.
const PREVIEW_PAGE = 10
const REBLUR_MS = 60_000
const CLIPBOARD_CLEAR_MS = 30_000

// What the derive / recovery-phrase modals act on: a stored wallet, or the
// retained seed — which has an encrypted file but no index entry, hence no address.
type SeedSource = { id: string; name: string; address?: string; accountIndex?: number }

export default function Settings({ initialTab, onClose, onWalletSwitch, onWalletsChanged }: Props) {
  const { reload: reloadGlobalSettings } = useSettings()
  const rpcHealth = useRpcHealth()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [wallets, setWallets] = useState<WalletEntry[]>([])
  const [rpcInput, setRpcInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [splitTunnelInput, setSplitTunnelInput] = useState('')
  const [knownRpcs, setKnownRpcs] = useState<RpcCandidateInfo[]>([])
  const [rpcsLoading, setRpcsLoading] = useState(true)
  const [rpcsError, setRpcsError] = useState<string | null>(null)
  // Derive-subaccount modal state. `source` is the wallet whose mnemonic we'll
  // reuse; the account index is typed, the address index is picked from the
  // preview list (which shows the real address behind each path).
  const [deriveSource, setDeriveSource] = useState<SeedSource | null>(null)
  const [deriveName, setDeriveName] = useState('')
  const [deriveAccount, setDeriveAccount] = useState('0')
  const [deriveAddressIndex, setDeriveAddressIndex] = useState<number | null>(null)
  const [previewRows, setPreviewRows] = useState<DerivationPreview[]>([])
  const [previewCount, setPreviewCount] = useState(PREVIEW_PAGE)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [deriveError, setDeriveError] = useState('')
  const [deriveLoading, setDeriveLoading] = useState(false)
  // Recovery-phrase modal. `phrase` holds the seed only while the modal is
  // open — closing clears it (see closePhraseModal).
  const [phraseWallet, setPhraseWallet] = useState<SeedSource | null>(null)
  const [phrase, setPhrase] = useState<string | null>(null)
  const [phraseRevealed, setPhraseRevealed] = useState(false)
  const [phraseLoading, setPhraseLoading] = useState(false)
  const [phraseError, setPhraseError] = useState('')
  const [phraseCopied, setPhraseCopied] = useState(false)
  const reblurTimer = useRef<number | null>(null)
  const copyClearTimer = useRef<number | null>(null)
  // Wallet deletion and seed removal, in-app rather than window.confirm(): the
  // last-wallet case is a three-way choice a native dialog can't express.
  const [deleteTarget, setDeleteTarget] = useState<WalletEntry | null>(null)
  const [removingSeed, setRemovingSeed] = useState(false)
  const [walletBusy, setWalletBusy] = useState(false)
  const [walletActionError, setWalletActionError] = useState('')
  // Set when a seed outlived its wallets, so this tab can still derive from it.
  const [retainedSeedId, setRetainedSeedId] = useState<string | null>(null)
  // Provider mode is stored per wallet, so the toggle needs to know which one is active.
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [s, w, store] = await Promise.all([
      window.api.settingsGet(),
      window.api.walletList(),
      window.api.walletStoreStatus(),
    ])
    setSettings(s)
    setRpcInput(s.rpcEndpoint)
    setSplitTunnelInput((s.splitTunnelRoutes || []).join('\n'))
    setWallets(w)
    setRetainedSeedId(store.retainedSeedId)
    setActiveWalletId(store.activeWalletId)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Probe the public list from sentnodes.com in main (parallel, cached 60s), so
  // the user compares real latency and block height instead of testing one
  // endpoint per click.
  const loadRpcs = useCallback(() => {
    setRpcsLoading(true)
    setRpcsError(null)
    return window.api.rpcProbeAll()
      .then(setKnownRpcs)
      .catch((err: unknown) => {
        setRpcsError(err instanceof Error ? err.message : 'Failed to load RPCs')
      })
      .finally(() => setRpcsLoading(false))
  }, [])

  useEffect(() => {
    if (tab === 'network') void loadRpcs()
  }, [tab, loadRpcs])

  // Healthy first, then fastest — the order the user would sort them in anyway.
  const sortedRpcs = useMemo(() => {
    const rank = (r: RpcCandidateInfo) => {
      if (r.aggregatorHealthy === false) return 3
      const state = classifyRpc(r.probe)
      return state === 'ok' ? 0 : state === 'degraded' ? 1 : 2
    }
    return [...knownRpcs].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.probe.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.probe.latencyMs ?? Number.MAX_SAFE_INTEGER),
    )
  }, [knownRpcs])

  async function saveRpc(endpoint = rpcInput.trim()) {
    if (!endpoint) return
    setSaving(true)
    try {
      const updated = await window.api.settingsSet({ rpcEndpoint: endpoint })
      setSettings(updated)
      setRpcInput(updated.rpcEndpoint)
      await reloadGlobalSettings()
    } finally {
      setSaving(false)
    }
  }

  async function handleSwitch(walletId: string) {
    await window.api.walletSwitch(walletId)
    onWalletSwitch()
  }

  // Only ever a non-active wallet, so the seed always survives in the remaining
  // entries and there's nothing to ask about.
  async function runDelete() {
    if (!deleteTarget) return
    setWalletBusy(true)
    setWalletActionError('')
    try {
      await window.api.walletDelete(deleteTarget.id)
      setDeleteTarget(null)
      await load()
      onWalletsChanged?.()
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : 'Failed to delete wallet')
    } finally {
      setWalletBusy(false)
    }
  }

  async function runRemoveSeed(keepSeed: boolean) {
    setWalletBusy(true)
    setWalletActionError('')
    try {
      await window.api.walletDeleteAll(keepSeed)
      setRemovingSeed(false)
      onWalletSwitch()
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : 'Failed to remove the seed')
      setWalletBusy(false)
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

  function openDeriveModal(source: SeedSource) {
    // Start on the source's own account: "another address on this seed" is the
    // common action, and the preview list greys out whatever is already stored.
    setDeriveSource(source)
    setDeriveName('')
    setDeriveAccount(String(source.accountIndex ?? 0))
    setDeriveAddressIndex(null)
    setPreviewRows([])
    setPreviewCount(PREVIEW_PAGE)
    setPreviewError('')
    setDeriveError('')
  }

  function closeDeriveModal() {
    setDeriveSource(null)
    setDeriveName('')
    setDeriveAddressIndex(null)
    setPreviewRows([])
    setPreviewError('')
    setDeriveError('')
    setDeriveLoading(false)
  }

  // The typed account index, or null while it's blank/invalid.
  const accountIndex = useMemo(() => {
    const parsed = parseInt(deriveAccount, 10)
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 2147483647 ? parsed : null
  }, [deriveAccount])

  // Derive the visible paths in main and show what each one would produce.
  // Debounced so holding the spinner doesn't queue a derivation per tick, and
  // `stale` drops a late response from a previous account index.
  useEffect(() => {
    if (!deriveSource || accountIndex === null) {
      setPreviewRows([])
      return
    }
    let stale = false
    setPreviewLoading(true)
    const timer = window.setTimeout(() => {
      window.api
        .walletDerivePreview({
          sourceWalletId: deriveSource.id,
          accountIndex,
          startIndex: 0,
          count: previewCount,
        })
        .then((rows) => {
          if (stale) return
          setPreviewRows(rows)
          setPreviewError('')
        })
        .catch((err: unknown) => {
          if (stale) return
          setPreviewRows([])
          setPreviewError(err instanceof Error ? err.message : 'Failed to derive addresses')
        })
        .finally(() => {
          if (!stale) setPreviewLoading(false)
        })
    }, 250)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [deriveSource, accountIndex, previewCount])

  // Land on the first free path, and move off one that turns out to be taken
  // (the account index changed under the selection).
  useEffect(() => {
    if (previewRows.length === 0) return
    const selected = previewRows.find((r) => r.addressIndex === deriveAddressIndex)
    if (selected && !selected.existingWalletName) return
    setDeriveAddressIndex(previewRows.find((r) => !r.existingWalletName)?.addressIndex ?? null)
  }, [previewRows, deriveAddressIndex])

  async function submitDerive() {
    if (!deriveSource || accountIndex === null || deriveAddressIndex === null) return
    setDeriveError('')
    const name = deriveName.trim()
    if (!name) {
      setDeriveError('Please enter a wallet name')
      return
    }
    setDeriveLoading(true)
    try {
      await window.api.walletDeriveSubaccount({
        sourceWalletId: deriveSource.id,
        accountIndex,
        addressIndex: deriveAddressIndex,
        name,
      })
      closeDeriveModal()
      await load()
      onWalletsChanged?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to derive subaccount'
      // The picker greys out taken paths, but addWalletEntry's uniqueness guard
      // is still the authority (and covers a race). Its error carries the
      // clashing wallet's id — show only the human half.
      setDeriveError(parseWalletExists(message)?.message ?? message)
      setDeriveLoading(false)
    }
  }

  function closePhraseModal() {
    if (reblurTimer.current !== null) window.clearTimeout(reblurTimer.current)
    reblurTimer.current = null
    setPhraseWallet(null)
    setPhrase(null)
    setPhraseRevealed(false)
    setPhraseLoading(false)
    setPhraseError('')
    setPhraseCopied(false)
  }

  // Don't leave timers running if the whole Settings modal is torn down while
  // the phrase is on screen (the seed itself goes with the component state).
  useEffect(() => () => {
    if (reblurTimer.current !== null) window.clearTimeout(reblurTimer.current)
    if (copyClearTimer.current !== null) window.clearTimeout(copyClearTimer.current)
  }, [])

  async function fetchPhrase() {
    if (!phraseWallet) return
    setPhraseLoading(true)
    setPhraseError('')
    try {
      const { mnemonic } = await window.api.walletRevealMnemonic(phraseWallet.id)
      setPhrase(mnemonic)
    } catch (err) {
      setPhraseError(err instanceof Error ? err.message : 'Failed to read the recovery phrase')
    } finally {
      setPhraseLoading(false)
    }
  }

  function revealPhrase() {
    setPhraseRevealed(true)
    if (reblurTimer.current !== null) window.clearTimeout(reblurTimer.current)
    reblurTimer.current = window.setTimeout(() => setPhraseRevealed(false), REBLUR_MS)
  }

  async function copyPhrase() {
    if (!phrase) return
    await navigator.clipboard.writeText(phrase)
    setPhraseCopied(true)
    // Same rule as the create-wallet screen: don't let the seed linger on the
    // clipboard (finding M5). The label says so while the copy is live.
    if (copyClearTimer.current !== null) window.clearTimeout(copyClearTimer.current)
    copyClearTimer.current = window.setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {})
      copyClearTimer.current = null
      setPhraseCopied(false)
    }, CLIPBOARD_CLEAR_MS)
  }

  // Show the derivation-path pill on each wallet row only when at least one
  // wallet is off the default path — avoids noise for single-account users.
  const showHdPath = wallets.some((w) => (w.accountIndex ?? 0) > 0 || (w.addressIndex ?? 0) > 0)

  if (!settings) return null

  // Every stored wallet is a subaccount of one seed, so "derive another" and
  // "show the recovery phrase" are seed-level actions, not per-row ones — they
  // operate on the active wallet, or on the retained seed when no wallets are left.
  const activeWallet = wallets.find((w) => w.id === settings.activeWalletId)
  const seedSource: SeedSource | null =
    activeWallet ?? (retainedSeedId ? { id: retainedSeedId, name: 'your saved seed' } : null)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      {/*
        Fixed height rather than shrink-to-fit. Measured natural heights at the
        default 1280x800 window (85vh ceiling = 658px): General 771px, Network
        472px, Wallets 380px at two wallets and 608px at five. So the box swung
        ~280px between tabs and grew with the wallet count — resizing under the
        cursor and moving the tab strip you just clicked.

        600px is a compactness choice, not a fitting one: General overflows any
        height available here, so it scrolls regardless. The content pane is
        already `overflow-y-auto`, so the longer tabs scroll instead of
        stretching the frame, and max-h keeps it inside short windows.
      */}
      <div
        className="bg-bg-secondary border border-border w-full max-w-2xl mx-4 h-[600px] max-h-[85vh] flex flex-col rounded-lg shadow-overlay"
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

                {/* Provider mode — reveals the Provider tab for the ACTIVE wallet.
                    Once that wallet has a provider registered on chain the tab
                    appears regardless of this toggle. */}
                <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                  <div>
                    <span className="text-text-primary text-sm">Provider Mode — this wallet</span>
                    <p className="text-text-tertiary text-xs mt-0.5">
                      Show the Provider tab, where you can register as a provider, publish plans and lease nodes.
                      Applies to the selected wallet only.
                    </p>
                  </div>
                  <Toggle
                    checked={Boolean(wallets.find((w) => w.id === activeWalletId)?.providerMode)}
                    disabled={!activeWalletId}
                    onChange={async (checked) => {
                      await window.api.providerModeSet(checked)
                      await load()
                      onWalletsChanged?.()
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
                  Applied when VPN connects. Prevents DNS leaks to your ISP. On V2Ray
                  nodes, a chosen resolver is queried over encrypted DNS (DoH), so the
                  node can't see your lookups. System Default stays plaintext.
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

              {/* Live health of the endpoint in use — this is where the user
                  lands when something told them the chain was unreachable. */}
              <div className="bg-bg-tertiary border border-border rounded-md px-3 py-2 flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[rpcHealth.state]}`} aria-hidden />
                <span className="text-text-primary font-mono truncate">{rpcHostLabel(rpcHealth.endpoint) || '—'}</span>
                <span className="text-text-secondary">{rpcHealthLabel(rpcHealth)}</span>
                {rpcHealth.height !== null && (
                  <span className="text-text-tertiary ml-auto shrink-0">
                    block {rpcHealth.height.toLocaleString('en')}
                    {rpcHealth.blockAgeSec !== null && ` · ${rpcHealth.blockAgeSec}s ago`}
                  </span>
                )}
                {rpcHealth.error && <span className="text-danger ml-auto shrink-0 truncate">{rpcHealth.error}</span>}
              </div>

              {/* This pane is where a paused pill sends the user, and the first
                  thing they reach for is a different endpoint — which cannot
                  clear it. Say what the pause is and what ends it. */}
              {rpcHealth.state === 'suspended' && (
                <p className="text-text-tertiary text-xs">
                  Paused while the VPN is connected — chain data is served from the cache and nothing is
                  queried through the tunnel. It resumes when you disconnect; changing endpoints will not
                  resume it, though a new one is saved and used from then on.
                </p>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={rpcInput}
                  onChange={(e) => setRpcInput(e.target.value)}
                  className="flex-1 bg-bg-tertiary border border-border text-text-primary text-sm font-mono px-3 py-2 rounded-sm focus:outline-none focus:border-border-focus"
                  placeholder="https://rpc.sentinel.co:443"
                />
                <button
                  onClick={() => saveRpc()}
                  disabled={saving || rpcInput === settings.rpcEndpoint}
                  className="btn btn-primary text-sm px-4 disabled:opacity-30"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  {/* While the tunnel is up these probes travel through it, so
                      they say nothing about the latency you would get once
                      disconnected — which is the only time the app uses them. */}
                  <span className="text-text-secondary text-xs">
                    Public endpoints from <a href="https://sentnodes.com/public-rpc" target="_blank" rel="noreferrer" className="hover:text-accent transition-colors">sentnodes.com</a>, fastest first
                    {rpcHealth.state === 'suspended' ? ' (timed through the VPN tunnel)' : ''}:
                  </span>
                  {rpcsLoading ? (
                    <span className="text-text-tertiary text-xs flex items-center gap-1">
                      <Spinner /> Testing
                    </span>
                  ) : (
                    <button onClick={() => void loadRpcs()} className="text-text-secondary hover:text-accent text-xs transition-colors">
                      Retest
                    </button>
                  )}
                </div>
                {rpcsError && (
                  <p className="text-danger text-xs">Failed to load RPC list: {rpcsError}</p>
                )}
                <div className="space-y-1 max-h-[240px] overflow-y-auto">
                  {sortedRpcs.map((ep) => {
                    const state = ep.aggregatorHealthy === false ? 'down' : classifyRpc(ep.probe)
                    const inUse = settings.rpcEndpoint === ep.endpoint
                    return (
                      <div
                        key={ep.endpoint}
                        className={`text-xs px-2.5 py-1.5 border rounded-md flex items-center gap-2 ${
                          inUse ? 'border-accent' : 'border-border'
                        } ${state === 'down' ? 'opacity-50' : ''}`}
                        title={[
                          ep.provider,
                          ep.location,
                          ep.probe.height !== null ? `Height: ${ep.probe.height.toLocaleString('en')}` : null,
                          ep.availability !== null ? `Availability: ${ep.availability}%` : null,
                          ep.probe.error,
                        ].filter(Boolean).join('\n')}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[state]}`} aria-hidden />
                        <span className={`truncate font-mono ${inUse ? 'text-accent' : 'text-text-secondary'}`}>
                          {rpcHostLabel(ep.endpoint)}
                        </span>
                        <span className="shrink-0 text-text-tertiary ml-auto">
                          {state === 'down'
                            ? 'unreachable'
                            : `${ep.probe.latencyMs}ms${ep.probe.blockAgeSec !== null && ep.probe.blockAgeSec > STALE_BLOCK_AGE_SEC ? ` · ${ep.probe.blockAgeSec}s behind` : ''}`}
                        </span>
                        {inUse ? (
                          <span className="shrink-0 text-success">in use</span>
                        ) : (
                          <button
                            onClick={() => saveRpc(ep.endpoint)}
                            disabled={saving}
                            className="shrink-0 text-accent hover:underline disabled:opacity-30"
                          >
                            Use
                          </button>
                        )}
                      </div>
                    )
                  })}
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
                {seedSource && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => openDeriveModal(seedSource)}
                      className="text-text-secondary text-xs hover:text-accent transition-colors"
                      title="Derive a new wallet from this seed at a different account or address index"
                    >
                      Derive Subaccount
                    </button>
                    <button
                      onClick={() => { closePhraseModal(); setPhraseWallet(seedSource) }}
                      className="text-text-secondary text-xs hover:text-accent transition-colors"
                      title="Show this seed's 12/24-word recovery phrase"
                    >
                      Recovery Phrase
                    </button>
                    <button
                      onClick={() => { setWalletActionError(''); setRemovingSeed(true) }}
                      className="text-danger text-xs hover:underline transition-colors"
                      title="Delete the seed and every wallet derived from it"
                    >
                      Remove seed
                    </button>
                  </div>
                )}
              </div>

              {wallets.length === 0 && (
                <p className="text-text-secondary text-sm">
                  {retainedSeedId
                    ? 'No wallets derived from the seed. Use Derive Subaccount to create one.'
                    : 'No wallets stored. Import or create one from the main screen.'}
                </p>
              )}

              <div className="space-y-2">
                {wallets.map((w) => {
                  // By id, not by address: matching on address lit up every entry
                  // sharing one, which is exactly how the duplicate-wallet bug
                  // showed itself (two rows, both badged Active).
                  const isActive = w.id === settings.activeWalletId
                  const isEditing = editingName === w.id

                  return (
                    <div
                      key={w.id}
                      className={`border px-4 py-3 space-y-2 rounded-md ${
                        isActive ? 'border-success bg-success-subtle' : 'border-border bg-bg-tertiary'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4">
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
                              {showHdPath && (
                                <span className="text-text-tertiary text-xs font-mono">
                                  {formatHdPath(w.accountIndex ?? 0, w.addressIndex ?? 0)}
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
                          {/* Delete removes ONE derived wallet and is never offered
                              for the active one — no count-based exception, so the
                              rule stays predictable. That leaves the last wallet
                              undeletable here by design: getting rid of everything
                              is "Remove seed", which is where the keep-the-seed
                              question belongs. */}
                          <button
                            onClick={() => { setWalletActionError(''); setDeleteTarget(w) }}
                            disabled={isActive}
                            title={
                              isActive
                                ? 'Switch to another wallet before deleting this one — or use Remove seed to clear everything'
                                : undefined
                            }
                            className="btn btn-danger text-xs px-3 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
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
                To add a seed phrase, log out and import or create a new seed phrase. To derive an additional wallet from an existing seed, use Derive Subaccount. The seed is encrypted with your OS keyring.
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
                Creates a new wallet from the seed of <span className="text-text-secondary">{deriveSource.name}</span> at a different BIP-44 path. Same seed, different address.
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
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={0}
                  value={deriveAccount}
                  onChange={(e) => setDeriveAccount(e.target.value)}
                  className="w-24 bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus font-mono"
                />
                <span className="text-text-tertiary text-xs font-mono">
                  m/44'/118'/{accountIndex ?? '?'}'/0/<span className="text-text-secondary">x</span>
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">Address</label>
                {previewLoading && <Spinner />}
              </div>

              {previewError && <p className="text-danger text-xs">{previewError}</p>}

              {accountIndex === null ? (
                <p className="text-text-tertiary text-xs">Enter an account index to see its addresses.</p>
              ) : (
                <div className="space-y-1 max-h-[220px] overflow-y-auto">
                  {previewRows.map((row) => {
                    const taken = row.existingWalletName !== null
                    const selected = row.addressIndex === deriveAddressIndex
                    return (
                      <button
                        key={row.addressIndex}
                        onClick={() => setDeriveAddressIndex(row.addressIndex)}
                        disabled={taken}
                        title={row.path}
                        className={`w-full text-left text-xs px-2.5 py-1.5 border rounded-md flex items-center gap-2 transition-colors ${
                          selected ? 'border-accent' : 'border-border'
                        } ${taken ? 'opacity-50 cursor-not-allowed' : 'hover:border-border-focus'}`}
                      >
                        <span className="font-mono text-text-tertiary shrink-0 w-6">{row.addressIndex}</span>
                        <span className={`font-mono truncate ${selected ? 'text-accent' : 'text-text-secondary'}`}>
                          {row.address}
                        </span>
                        {taken && (
                          <span className="text-text-tertiary ml-auto shrink-0">In wallet · {row.existingWalletName}</span>
                        )}
                      </button>
                    )
                  })}
                  {previewRows.length > 0 && previewCount < DERIVE_PREVIEW_MAX_COUNT && (
                    <button
                      onClick={() => setPreviewCount((c) => Math.min(c + PREVIEW_PAGE, DERIVE_PREVIEW_MAX_COUNT))}
                      className="text-text-secondary hover:text-accent text-xs transition-colors py-1"
                    >
                      Show more
                    </button>
                  )}
                </div>
              )}
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
                disabled={deriveLoading || !deriveName.trim() || deriveAddressIndex === null}
                className="btn btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
              >
                {deriveLoading ? 'Deriving...' : 'Derive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {phraseWallet && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]"
          onClick={() => !phraseLoading && closePhraseModal()}
        >
          <div
            className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-5 space-y-4 rounded-lg shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-text-primary text-base font-semibold">Recovery Phrase</h3>
              <p className="text-text-tertiary text-xs mt-1">
                <span className="text-text-secondary">{phraseWallet.name}</span>
                {phraseWallet.address ? ` · ${phraseWallet.address}` : ''}
              </p>
            </div>

            {phrase === null ? (
              <>
                <div className="border border-danger bg-danger-subtle rounded-md p-3 space-y-2">
                  <p className="text-danger text-xs font-medium">Anyone with these words controls this wallet's funds.</p>
                  <ul className="text-text-secondary text-xs space-y-1 list-disc pl-4">
                    <li>Never share them — nobody from Katacomb will ever ask for them.</li>
                    <li>Make sure nobody can see your screen, and that you aren't recording or sharing it.</li>
                    <li>Write them down offline; anything typed into a website is a theft attempt.</li>
                  </ul>
                </div>

                {phraseError && <p className="text-danger text-xs">{phraseError}</p>}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={closePhraseModal}
                    disabled={phraseLoading}
                    className="text-text-secondary hover:text-text-primary text-sm px-3 py-1.5 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={fetchPhrase}
                    disabled={phraseLoading}
                    className="btn btn-primary text-sm px-3 py-1.5 disabled:opacity-50 flex items-center gap-2"
                  >
                    {phraseLoading && <Spinner />}
                    Show phrase
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="relative">
                  <div
                    className={`grid grid-cols-3 gap-1.5 transition-[filter] ${
                      phraseRevealed ? '' : 'blur-sm select-none pointer-events-none'
                    }`}
                  >
                    {phrase.split(/\s+/).map((word, i) => (
                      <div
                        key={i}
                        className="bg-bg-tertiary border border-border rounded-sm px-2 py-1 flex items-baseline gap-1.5"
                      >
                        <span className="text-text-tertiary text-[10px] font-mono w-4 shrink-0">{i + 1}</span>
                        <span className="text-text-primary text-xs font-mono truncate">{word}</span>
                      </div>
                    ))}
                  </div>
                  {!phraseRevealed && (
                    <button
                      onClick={revealPhrase}
                      className="absolute inset-0 flex items-center justify-center"
                    >
                      <span className="btn btn-primary text-xs px-3 py-1.5">Click to reveal</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={copyPhrase}
                    className="text-text-secondary hover:text-accent text-xs transition-colors"
                  >
                    {phraseCopied ? 'Copied — clipboard clears itself in 30s' : 'Copy to clipboard'}
                  </button>
                  <span className="text-text-tertiary text-xs ml-auto">
                    {phraseRevealed ? 'Hides automatically after 60s' : 'Hidden'}
                  </span>
                </div>

                <div className="flex items-center justify-end pt-1">
                  <button onClick={closePhraseModal} className="btn btn-primary text-sm px-3 py-1.5">
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]"
          onClick={() => !walletBusy && setDeleteTarget(null)}
        >
          <div
            className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-5 space-y-4 rounded-lg shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-text-primary text-base font-semibold">Delete "{deleteTarget.name}"?</h3>
              <p className="text-text-tertiary text-xs mt-1 font-mono break-all">{deleteTarget.address}</p>
            </div>

            <p className="text-text-secondary text-xs">
              Removes this wallet from the device. The seed stays, so you can derive it again at
              the same path.
            </p>

            {walletActionError && <p className="text-danger text-xs">{walletActionError}</p>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={walletBusy}
                className="text-text-secondary hover:text-text-primary text-sm px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={runDelete}
                disabled={walletBusy}
                className="btn btn-danger text-sm px-3 py-1.5 disabled:opacity-50 flex items-center gap-2"
              >
                {walletBusy && <Spinner />}
                Delete wallet
              </button>
            </div>
          </div>
        </div>
      )}

      {removingSeed && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]"
          onClick={() => !walletBusy && setRemovingSeed(false)}
        >
          <div
            className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-5 space-y-4 rounded-lg shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-text-primary text-base font-semibold">Remove seed</h3>

            <div className="border border-danger bg-danger-subtle rounded-md p-3 space-y-2">
              <p className="text-danger text-xs font-medium">
                Either way, {wallets.length === 1 ? 'this wallet is' : `all ${wallets.length} wallets are`} removed
                from this device.
              </p>
              {wallets.length > 0 && (
                <ul className="text-text-secondary text-xs space-y-1 list-disc pl-4">
                  {wallets.map((w) => (
                    <li key={w.id}>
                      <span className="text-text-primary">{w.name}</span> — {w.address || 'address unknown'}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-text-secondary text-xs">App settings are kept.</p>
            </div>

            <div className="space-y-2 text-xs">
              <p className="text-text-secondary">
                <span className="text-text-primary font-medium">Keep seed</span> — the recovery
                phrase stays encrypted on this device, so you can derive new wallets without
                retyping it.
              </p>
              <p className="text-text-secondary">
                <span className="text-text-primary font-medium">Delete seed too</span> — the phrase
                is removed as well. Funds stay on-chain, reachable only by importing your
                written-down phrase again.
              </p>
            </div>

            {walletActionError && <p className="text-danger text-xs">{walletActionError}</p>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setRemovingSeed(false)}
                disabled={walletBusy}
                className="text-text-secondary hover:text-text-primary text-sm px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => runRemoveSeed(true)}
                disabled={walletBusy}
                className="btn btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
              >
                Keep seed
              </button>
              <button
                onClick={() => runRemoveSeed(false)}
                disabled={walletBusy}
                className="btn btn-danger text-sm px-3 py-1.5 disabled:opacity-50 flex items-center gap-2"
              >
                {walletBusy && <Spinner />}
                Delete seed too
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
