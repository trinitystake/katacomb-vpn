import { useState, useEffect, useCallback, useMemo } from 'react'
import type { WalletStoreStatus, AppSettings, RpcCandidateInfo } from '../types'
import Toggle from './Toggle'
import Spinner from './Spinner'
import { useSettings } from '../contexts/SettingsContext'
import type { SettingsTab } from '../contexts/NavigationContext'
import { useRpcHealth } from '../hooks/useRpcHealth'
import { classifyRpc, rpcHealthLabel, rpcHostLabel, STALE_BLOCK_AGE_SEC } from '../../shared/rpc-health'
import { parseSplitTunnelRoutes, MAX_SPLIT_TUNNEL_ROUTES } from '../../shared/split-tunnel'
import { STATE_DOT } from './RpcStatus'
import WalletsTab from './settings/WalletsTab'

interface Props {
  /** Which tab to land on — 'network' when something sent the user here to fix the RPC. */
  initialTab: SettingsTab
  /**
   * A session is live, in any mode: tunnel, local proxy, or the reconnect window.
   * Main refuses every change to the active wallet then (assertNotConnected), so
   * the Wallets tab greys those actions out behind a banner. Broader than
   * WalletPanel's chainFrozen, which is false in proxy mode.
   */
  connected: boolean
  onClose: () => void
  onWalletSwitch: () => void
  // Called after a wallet rename / derive succeeds, so the top-bar Wallet
  // popover can re-fetch the active wallet's display name.
  onWalletsChanged?: () => void
  /** Closes Settings and opens the import/create screen for another seed. */
  onAddWallet: () => void
  /**
   * Whether the Provider tab is actually showing right now.
   *
   * Passed in rather than read off the wallet entry, because `providerMode` is
   * tri-state and the unset case is decided by the chain (see useProvider).
   */
  providerTabVisible: boolean
}

const DNS_OPTIONS = [
  { label: 'System Default', value: 'system' },
  { label: 'Cloudflare (1.1.1.1)', value: '1.1.1.1' },
  { label: 'Cloudflare WARP (1.0.0.1)', value: '1.0.0.1' },
  { label: 'Google (8.8.8.8)', value: '8.8.8.8' },
  { label: 'Quad9 (9.9.9.9)', value: '9.9.9.9' },
  { label: 'NextDNS (45.90.28.0)', value: '45.90.28.0' },
]

// A stored wallet as the store reports it, with its seed membership.
type StoredWallet = WalletStoreStatus['wallets'][number]

export default function Settings({ initialTab, connected, onClose, onWalletSwitch, onWalletsChanged, onAddWallet, providerTabVisible }: Props) {
  const { reload: reloadGlobalSettings } = useSettings()
  const rpcHealth = useRpcHealth()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [wallets, setWallets] = useState<StoredWallet[]>([])
  const [rpcInput, setRpcInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [splitTunnelInput, setSplitTunnelInput] = useState('')
  // The save is all-or-nothing at the IPC boundary, so the pane pre-checks the
  // same rule and reports the offending lines; `splitTunnelError` carries
  // whatever SETTINGS_SET still rejects, which used to vanish into an
  // unhandled rejection and read as a dead button.
  const [splitTunnelError, setSplitTunnelError] = useState('')
  const [splitTunnelSaving, setSplitTunnelSaving] = useState(false)
  const [splitTunnelSaved, setSplitTunnelSaved] = useState(false)
  const [knownRpcs, setKnownRpcs] = useState<RpcCandidateInfo[]>([])
  const [rpcsLoading, setRpcsLoading] = useState(true)
  const [rpcsError, setRpcsError] = useState<string | null>(null)
  /** What the last Retest and reselect run concluded. Null until one runs. */
  const [reselectNote, setReselectNote] = useState<string | null>(null)
  // Provider mode is stored per wallet, so the toggle needs to know which one is active.
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [s, store] = await Promise.all([window.api.settingsGet(), window.api.walletStoreStatus()])
    setSettings(s)
    setRpcInput(s.rpcEndpoint)
    setSplitTunnelInput((s.splitTunnelRoutes || []).join('\n'))
    setWallets(store.wallets)
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

  // Retest and reselect (auto mode): one shared probe pass in main runs the
  // selection and returns the exact rows it graded, so this list can never
  // disagree with the decision it reports.
  const reselect = useCallback(async () => {
    setRpcsLoading(true)
    setRpcsError(null)
    setReselectNote(null)
    try {
      const report = await window.api.rpcAutoSelect()
      setKnownRpcs(report.candidates)
      if (report.switched) {
        const updated = await window.api.settingsGet()
        setSettings(updated)
        setRpcInput(updated.rpcEndpoint)
        await reloadGlobalSettings()
        setReselectNote(`Switched to ${rpcHostLabel(report.endpoint)}.`)
      } else if (report.selected) {
        setReselectNote(`Kept ${rpcHostLabel(report.endpoint)}, no candidate beat it by enough to switch.`)
      } else {
        setReselectNote('Selection skipped: the chain is not reachable right now (VPN tunnel or kill switch).')
      }
    } catch (err: unknown) {
      setRpcsError(err instanceof Error ? err.message : 'Failed to reselect')
    } finally {
      setRpcsLoading(false)
    }
  }, [reloadGlobalSettings])

  // Not while our own tunnel or kill switch stops the traffic: the probes would
  // ride the tunnel (or all fail), main refuses to select on them anyway, and the
  // list would be graded on numbers that mean nothing once disconnected. Not on
  // 'unknown', which is only the state before the first health push.
  const chainUnreachable = rpcHealth.state === 'suspended' || rpcHealth.state === 'blocked'
  useEffect(() => {
    if (tab !== 'network') return
    if (chainUnreachable) {
      setRpcsLoading(false)
      return
    }
    void loadRpcs()
  }, [tab, loadRpcs, chainUnreachable])

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
      // Choosing an endpoint by hand is an explicit manual choice, so it also
      // turns Smart RPC off, in the same settings write.
      const patch =
        settings?.rpcMode === 'auto'
          ? { rpcEndpoint: endpoint, rpcMode: 'manual' as const }
          : { rpcEndpoint: endpoint }
      const updated = await window.api.settingsSet(patch)
      setSettings(updated)
      setRpcInput(updated.rpcEndpoint)
      await reloadGlobalSettings()
    } finally {
      setSaving(false)
    }
  }

  // Same rule SETTINGS_SET enforces, applied as the user types so a bad line is
  // named here instead of silently rejecting the whole list.
  const splitTunnel = useMemo(() => parseSplitTunnelRoutes(splitTunnelInput), [splitTunnelInput])
  const splitTunnelDirty =
    splitTunnel.routes.join('\n') !== (settings?.splitTunnelRoutes || []).join('\n') ||
    splitTunnel.invalid.length > 0

  async function saveSplitTunnel() {
    setSplitTunnelError('')
    setSplitTunnelSaved(false)
    if (splitTunnel.invalid.length > 0 || splitTunnel.tooMany) return
    setSplitTunnelSaving(true)
    try {
      const updated = await window.api.settingsSet({ splitTunnelRoutes: splitTunnel.routes })
      setSettings(updated)
      setSplitTunnelInput((updated.splitTunnelRoutes || []).join('\n'))
      setSplitTunnelSaved(true)
    } catch (err: unknown) {
      // Anything main still refuses (or an IPC failure) lands here rather than
      // in an unhandled rejection the user never sees.
      setSplitTunnelError(err instanceof Error ? err.message : 'Failed to save routes')
    } finally {
      setSplitTunnelSaving(false)
    }
  }


  if (!settings) return null

  const rpcAuto = settings.rpcMode === 'auto'


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

                {/* Local network sharing — a hole in the kill switch's DROP-all
                    chain, so it only means anything while that chain is armed.
                    With the kill switch off the LAN is already reachable: no
                    protocol's routing captures it. */}
                <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                  <div>
                    <span className="text-text-primary text-sm">Local Network Sharing</span>
                    <p className="text-text-tertiary text-xs mt-0.5">
                      {settings.killSwitch
                        ? 'Reach other devices on your network (SSH, printers, NAS) while the kill switch is on. This traffic stays on your LAN and is not encrypted by the VPN.'
                        : 'Only applies while the kill switch is on. Your local network is already reachable without it.'}
                    </p>
                  </div>
                  <Toggle
                    checked={settings.lanSharing}
                    disabled={!settings.killSwitch}
                    onChange={async (checked) => {
                      const updated = await window.api.settingsSet({ lanSharing: checked })
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
                <ProviderModeRow
                  visible={providerTabVisible}
                  disabled={!activeWalletId}
                  onToggle={async (checked) => {
                    await window.api.providerModeSet(checked)
                    await load()
                    onWalletsChanged?.()
                  }}
                />
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
                  onChange={(e) => {
                    setSplitTunnelInput(e.target.value)
                    setSplitTunnelError('')
                    setSplitTunnelSaved(false)
                  }}
                  className={`w-full bg-bg-tertiary border text-text-primary text-sm font-mono px-3 py-2 rounded-sm focus:outline-none h-20 resize-none ${
                    splitTunnel.invalid.length > 0 || splitTunnel.tooMany
                      ? 'border-danger focus:border-danger'
                      : 'border-border focus:border-border-focus'
                  }`}
                  placeholder="10.0.0.0/8&#10;172.16.0.0/12&#10;192.168.0.0/16"
                />

                {/* Why the save would be refused, said before it is clicked —
                    the whole list is rejected if one line is bad. */}
                {splitTunnel.invalid.length > 0 && (
                  <p className="text-danger text-xs">
                    Not a valid IPv4 CIDR: {splitTunnel.invalid.map((r) => `"${r}"`).join(', ')}.
                    Each line needs an address and a prefix, like 192.168.1.0/24. Hostnames,
                    IPv6 and 0.0.0.0/x are not accepted.
                  </p>
                )}
                {splitTunnel.tooMany && (
                  <p className="text-danger text-xs">
                    Too many routes: {MAX_SPLIT_TUNNEL_ROUTES} is the maximum.
                  </p>
                )}
                {splitTunnelError && <p className="text-danger text-xs">{splitTunnelError}</p>}

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void saveSplitTunnel()}
                    disabled={
                      splitTunnelSaving ||
                      splitTunnel.invalid.length > 0 ||
                      splitTunnel.tooMany ||
                      !splitTunnelDirty
                    }
                    className="btn btn-primary text-xs px-3 disabled:opacity-30"
                  >
                    {splitTunnelSaving ? 'Saving...' : 'Save Routes'}
                  </button>
                  <button
                    onClick={() => {
                      const defaults = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
                      setSplitTunnelInput(defaults.join('\n'))
                      setSplitTunnelError('')
                      setSplitTunnelSaved(false)
                    }}
                    className="text-text-secondary text-xs hover:text-accent transition-colors"
                  >
                    Reset
                  </button>
                  {splitTunnelSaved && <span className="text-success text-xs">Saved</span>}
                </div>
                <p className="text-text-tertiary text-xs">
                  CIDR routes (one per line) that bypass the VPN tunnel. Private networks are excluded by default.
                  Applies to V2Ray, XRAY and Hysteria2 nodes, which route through tun2socks.
                </p>
              </div>

            </>
          )}

          {tab === 'network' && (
            <div className="space-y-3">
              <label className="text-text-secondary text-xs font-medium uppercase tracking-wide block">
                RPC Endpoint
              </label>

              {/* Smart RPC, the default. Startup and confirmed-fault switches
                  happen in main (runAutoRpcSelection); this toggle is the only
                  control, and picking an endpoint below flips it off. */}
              <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                <div>
                  <span className="text-text-primary text-sm">Automatic Endpoint Selection</span>
                  <p className="text-text-tertiary text-xs mt-0.5">
                    Picks the fastest healthy public endpoint at startup and switches away from one that
                    fails. Choosing an endpoint below turns this off.
                  </p>
                </div>
                <Toggle
                  checked={rpcAuto}
                  onChange={async (checked) => {
                    setReselectNote(null)
                    const updated = await window.api.settingsSet({ rpcMode: checked ? 'auto' : 'manual' })
                    setSettings(updated)
                    setRpcInput(updated.rpcEndpoint)
                    await reloadGlobalSettings()
                  }}
                />
              </div>

              {/* Live health of the endpoint in use — this is where the user
                  lands when something told them the chain was unreachable. */}
              <div className="bg-bg-tertiary border border-border rounded-md px-3 py-2 flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[rpcHealth.state]}`} aria-hidden />
                <span className="text-text-primary font-mono truncate">{rpcHostLabel(rpcHealth.endpoint) || '—'}</span>
                {rpcAuto && <span className="text-text-tertiary shrink-0">auto</span>}
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
                  Paused while the VPN is connected. Chain data is served from the cache and nothing is
                  queried through the tunnel. It resumes when you disconnect; changing endpoints will not
                  resume it, though a new one is saved and used from then on.
                </p>
              )}

              {/* Same trap as the pause, one step further along: here the chain
                  really is unreachable, so the endpoint looks guilty. */}
              {rpcHealth.state === 'blocked' && (
                <p className="text-text-tertiary text-xs">
                  Blocked by the kill switch, which stayed on after your session ended so nothing leaves
                  the machine untunnelled. Use “Restore internet” in the banner, or turn the kill switch
                  off under General. Changing endpoints will not resume it.
                </p>
              )}

              {!rpcAuto && (
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
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  {/* While the tunnel is up these probes would travel through it, so
                      they would say nothing about the latency you get once
                      disconnected, which is the only time the app uses them; behind
                      an armed kill switch they all fail, which would read as every
                      endpoint being down. So they are paused instead (chainUnreachable)
                      and the note says which of the two it is. */}
                  <span className="text-text-secondary text-xs">
                    Public endpoints from <a href="https://sentnodes.com/public-rpc" target="_blank" rel="noreferrer" className="hover:text-accent transition-colors">sentnodes.com</a>, fastest first:
                  </span>
                  {chainUnreachable ? (
                    <span className="text-text-tertiary text-xs">
                      {rpcHealth.state === 'blocked'
                        ? 'Endpoint testing is paused while the kill switch is blocking traffic'
                        : 'Endpoint testing is paused while the VPN is connected'}
                    </span>
                  ) : rpcsLoading ? (
                    <span className="text-text-tertiary text-xs flex items-center gap-1">
                      <Spinner /> Testing
                    </span>
                  ) : (
                    <button
                      onClick={() => void (rpcAuto ? reselect() : loadRpcs())}
                      className="text-text-secondary hover:text-accent text-xs transition-colors"
                      title={rpcAuto ? 'Probe every endpoint again and let the automatic selection act on the result. It keeps your endpoint unless another is meaningfully better.' : undefined}
                    >
                      {rpcAuto ? 'Retest and reselect' : 'Retest'}
                    </button>
                  )}
                </div>
                {rpcsError && (
                  <p className="text-danger text-xs">Failed to load RPC list: {rpcsError}</p>
                )}
                {rpcAuto && reselectNote && !rpcsLoading && (
                  <p className="text-text-tertiary text-xs">{reselectNote}</p>
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
                            title={rpcAuto ? 'Use this endpoint and turn automatic selection off' : undefined}
                          >
                            Use
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {!rpcAuto && rpcInput !== settings.rpcEndpoint && (
                <p className="text-warning text-xs">
                  Unsaved changes. Click Save to apply.
                </p>
              )}
            </div>
          )}

          {tab === 'wallets' && (
            <WalletsTab
              wallets={wallets}
              settings={settings}
              connected={connected}
              reload={load}
              onWalletSwitch={onWalletSwitch}
              onWalletsChanged={onWalletsChanged}
              onAddWallet={onAddWallet}
            />
          )}
        </div>
      </div>

    </div>
  )
}

/**
 * The Provider Mode toggle with its own busy and error state: the IPC write can
 * fail (no active wallet resolved, disk error), and a bare Toggle swallowed the
 * rejection so the switch just snapped back with no explanation.
 */
function ProviderModeRow({ visible, disabled, onToggle }: {
  /** The EFFECTIVE state, not the stored flag. providerMode is tri-state:
      left unset, a provider found on chain reveals the tab on its own, and
      a toggle reading "off" beside a visible tab is just wrong. Flipping it
      writes an explicit true/false either way, which then wins outright. */
  visible: boolean
  disabled: boolean
  onToggle: (checked: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
      <div>
        <span className="text-text-primary text-sm">Provider Mode: this wallet</span>
        <p className="text-text-tertiary text-xs mt-0.5">
          Show the Provider tab, where you can register as a provider, publish plans and lease nodes.
          Applies to the selected wallet only. Turning it off only hides the tab: your provider,
          plans and leases carry on exactly as they are on chain.
        </p>
        {error && <p className="text-danger text-xs mt-1">{error}</p>}
      </div>
      <Toggle
        checked={visible}
        disabled={disabled || busy}
        onChange={async (checked) => {
          setBusy(true)
          setError(null)
          try {
            await onToggle(checked)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save the setting')
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
