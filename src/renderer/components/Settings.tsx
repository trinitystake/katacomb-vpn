import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { WalletStoreStatus, AppSettings, RpcCandidateInfo, DerivationPreview } from '../types'
import Toggle from './Toggle'
import Spinner from './Spinner'
import { useSettings } from '../contexts/SettingsContext'
import type { SettingsTab } from '../contexts/NavigationContext'
import { useRpcHealth } from '../hooks/useRpcHealth'
import { classifyRpc, rpcHealthLabel, rpcHostLabel, STALE_BLOCK_AGE_SEC } from '../../shared/rpc-health'
import { parseWalletExists } from '../../shared/wallet-errors'
import { displayConnectError } from '../utils/connect-errors'
import { formatHdPath, DERIVE_PREVIEW_MAX_COUNT } from '../../shared/hd-path'
import { parseSplitTunnelRoutes, MAX_SPLIT_TUNNEL_ROUTES } from '../../shared/split-tunnel'
import { groupWalletsBySeed, type SeedGroup } from '../../shared/seed-groups'
import { STATE_DOT } from './RpcStatus'

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

// Address indices shown per page in the derive picker, and how long a revealed
// recovery phrase stays on screen before it re-blurs.
const PREVIEW_PAGE = 10
const REBLUR_MS = 60_000
const CLIPBOARD_CLEAR_MS = 30_000

// A stored wallet as the store reports it, with its seed membership.
type StoredWallet = WalletStoreStatus['wallets'][number]
// What the derive / recovery-phrase / remove-seed modals act on: one seed and the
// wallets stored under it. Any member's id serves as the seed source in main.
type Group = SeedGroup<StoredWallet>

export default function Settings({ initialTab, connected, onClose, onWalletSwitch, onWalletsChanged, onAddWallet, providerTabVisible }: Props) {
  const { reload: reloadGlobalSettings } = useSettings()
  const rpcHealth = useRpcHealth()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [wallets, setWallets] = useState<StoredWallet[]>([])
  const [rpcInput, setRpcInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
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
  // Derive-subaccount modal state. `deriveGroup` is the seed whose mnemonic
  // we'll reuse; the account index is typed, the address index is picked from
  // the preview list (which shows the real address behind each path).
  const [deriveGroup, setDeriveGroup] = useState<Group | null>(null)
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
  const [phraseGroup, setPhraseGroup] = useState<Group | null>(null)
  const [phrase, setPhrase] = useState<string | null>(null)
  const [phraseRevealed, setPhraseRevealed] = useState(false)
  const [phraseLoading, setPhraseLoading] = useState(false)
  const [phraseError, setPhraseError] = useState('')
  const [phraseCopied, setPhraseCopied] = useState(false)
  const reblurTimer = useRef<number | null>(null)
  const copyClearTimer = useRef<number | null>(null)
  // Wallet deletion and seed removal, in-app rather than window.confirm(): the
  // last-wallet case is a three-way choice a native dialog can't express.
  const [deleteTarget, setDeleteTarget] = useState<StoredWallet | null>(null)
  const [removeSeedTarget, setRemoveSeedTarget] = useState<Group | null>(null)
  const [walletBusy, setWalletBusy] = useState(false)
  const [walletActionError, setWalletActionError] = useState('')
  // Switch has no modal of its own, so its refusal renders above the list. Not
  // walletActionError: that one is cleared only by the Delete / Remove-seed
  // openers and would leak a stale modal error onto the tab.
  const [switchError, setSwitchError] = useState('')
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

  async function handleSwitch(walletId: string) {
    setSwitchError('')
    try {
      await window.api.walletSwitch(walletId)
      onWalletSwitch()
    } catch (err) {
      setSwitchError(displayConnectError(err instanceof Error ? err.message : 'Failed to switch wallet'))
    }
  }

  // Only ever a non-active wallet. Whether its seed survives depends on the
  // rest of its group; the modal says which (see deleteNote).
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
    if (!removeSeedTarget) return
    setWalletBusy(true)
    setWalletActionError('')
    try {
      const { activeWalletChanged } = await window.api.walletDeleteSeed(removeSeedTarget.members[0].id, keepSeed)
      if (activeWalletChanged) {
        // Main moved to another wallet, or none is left: reload the way a
        // Switch does, so every wallet-scoped view starts over.
        onWalletSwitch()
        return
      }
      setRemoveSeedTarget(null)
      await load()
      onWalletsChanged?.()
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : 'Failed to remove the seed')
    }
    setWalletBusy(false)
  }

  async function handleRename(walletId: string) {
    if (!nameInput.trim()) return
    await window.api.walletRename(walletId, nameInput.trim())
    setEditingName(null)
    setNameInput('')
    await load()
    onWalletsChanged?.()
  }

  function openDeriveModal(group: Group) {
    // Start on the seed's first account: "another address on this seed" is the
    // common action, and the preview list greys out whatever is already stored.
    setDeriveGroup(group)
    setDeriveName('')
    setDeriveAccount(String(group.members[0].accountIndex ?? 0))
    setDeriveAddressIndex(null)
    setPreviewRows([])
    setPreviewCount(PREVIEW_PAGE)
    setPreviewError('')
    setDeriveError('')
  }

  function closeDeriveModal() {
    setDeriveGroup(null)
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
    if (!deriveGroup || accountIndex === null) {
      setPreviewRows([])
      return
    }
    let stale = false
    setPreviewLoading(true)
    const timer = window.setTimeout(() => {
      window.api
        .walletDerivePreview({
          sourceWalletId: deriveGroup.members[0].id,
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
  }, [deriveGroup, accountIndex, previewCount])

  // Land on the first free path, and move off one that turns out to be taken
  // (the account index changed under the selection).
  useEffect(() => {
    if (previewRows.length === 0) return
    const selected = previewRows.find((r) => r.addressIndex === deriveAddressIndex)
    if (selected && !selected.existingWalletName) return
    setDeriveAddressIndex(previewRows.find((r) => !r.existingWalletName)?.addressIndex ?? null)
  }, [previewRows, deriveAddressIndex])

  async function submitDerive() {
    if (!deriveGroup || accountIndex === null || deriveAddressIndex === null) return
    setDeriveError('')
    const name = deriveName.trim()
    if (!name) {
      setDeriveError('Please enter a wallet name')
      return
    }
    setDeriveLoading(true)
    try {
      await window.api.walletDeriveSubaccount({
        sourceWalletId: deriveGroup.members[0].id,
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
    setPhraseGroup(null)
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
    if (!phraseGroup) return
    setPhraseLoading(true)
    setPhraseError('')
    try {
      const { mnemonic } = await window.api.walletRevealMnemonic(phraseGroup.members[0].id)
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

  // Wallets nested under the seed they were derived from. `locked` holds the
  // ones whose seed cannot be decrypted, so their membership is unknown.
  const { groups, locked } = useMemo(() => groupWalletsBySeed(wallets), [wallets])

  if (!settings) return null

  const rpcAuto = settings.rpcMode === 'auto'

  // What deleting one row does to its seed, which depends on the rest of its group.
  const deleteNote = (w: StoredWallet): string => {
    if (w.seedGroup === null) {
      return 'This wallet cannot be unlocked, so nothing usable is removed. Import the same recovery phrase again to get it back.'
    }
    const group = groups.find((g) => g.key === w.seedGroup)
    if (group && group.members.length > 1) {
      return `Removes this wallet from the device. The seed stays with the other wallets of ${group.label}, so you can derive it again at the same path.`
    }
    return `This is the only wallet of ${group?.label ?? 'this seed'}, so its seed is removed from this device too. Funds stay on-chain, reachable only by importing your written-down phrase again.`
  }

  // Remove-seed modal facts. Keep seed rides the retained-seed model, which only
  // holds a seed while ZERO wallets are stored, so it is offered only when this
  // group's wallets are the last ones (rows that cannot be unlocked count too).
  const removeSeedMembers = removeSeedTarget?.members ?? []
  const removeSeedIsLast = removeSeedMembers.length === wallets.length
  const removeSeedHitsActive = removeSeedMembers.some((w) => w.id === settings.activeWalletId)
  const removeSeedSubject =
    removeSeedMembers.length === 1
      ? 'this wallet is'
      : `all ${removeSeedMembers.length} wallets of ${removeSeedTarget?.label} are`

  const renderWalletRow = (w: StoredWallet) => {
    // By id, not by address: matching on address lit up every entry
    // sharing one, which is exactly how the duplicate-wallet bug
    // showed itself (two rows, both badged Active).
    const isActive = w.id === settings.activeWalletId
    const isEditing = editingName === w.id

    return (
      <div
        key={w.id}
        className={`border px-4 py-3 space-y-2 rounded-md ${
          isActive
            ? 'border-success bg-success-subtle'
            : w.unlockable
              ? 'border-border bg-bg-tertiary'
              : 'border-warning bg-warning-subtle'
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
            {!isActive && w.unlockable && (
              <button
                onClick={() => handleSwitch(w.id)}
                disabled={connected}
                title={connected ? 'Disconnect first to switch wallets' : undefined}
                className="btn btn-primary text-xs px-3 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
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
              disabled={isActive || connected}
              title={
                connected
                  ? 'Disconnect first to delete a wallet'
                  : isActive
                    ? 'Switch to another wallet before deleting this one, or use Remove seed on its group'
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
  }

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
            <div className="space-y-4">
              {/* Same banner shape as the connect modals. Main refuses every change
                  to the active wallet while a session is live (assertNotConnected);
                  this is the half that explains instead of erroring. Rename, Derive
                  Subaccount and Recovery Phrase never change the active wallet, so
                  they stay usable. */}
              {connected && (
                <div className="bg-warning-subtle border border-warning p-3 rounded-md text-sm text-warning">
                  You are connected. Disconnect first to switch, add or remove wallets.
                </div>
              )}
              <div className="flex items-center justify-between">
                <label className="text-text-secondary text-xs font-medium uppercase tracking-wide">
                  Stored Wallets ({wallets.length})
                </label>
                <button
                  onClick={onAddWallet}
                  disabled={connected}
                  className="text-accent text-xs hover:underline transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                  title={connected ? 'Disconnect first to add a wallet' : 'Import or create another seed phrase'}
                >
                  Add Wallet
                </button>
              </div>
              {switchError && <p className="text-danger text-xs">{switchError}</p>}

              {/* One box per seed. The seed-level actions live on its header,
                  so each seed's phrase, subaccounts and removal are reachable
                  without switching to a wallet under it first. */}
              {groups.map((group) => (
                <div key={group.key} className="border border-border rounded-md">
                  <div className="flex items-center justify-between gap-4 px-4 py-2 border-b border-border">
                    <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">
                      {group.label} · {group.members.length} {group.members.length === 1 ? 'wallet' : 'wallets'}
                    </span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => openDeriveModal(group)}
                        className="text-text-secondary text-xs hover:text-accent transition-colors"
                        title="Derive a new wallet from this seed at a different account or address index"
                      >
                        Derive Subaccount
                      </button>
                      <button
                        onClick={() => { closePhraseModal(); setPhraseGroup(group) }}
                        className="text-text-secondary text-xs hover:text-accent transition-colors"
                        title="Show this seed's 12/24-word recovery phrase"
                      >
                        Recovery Phrase
                      </button>
                      <button
                        onClick={() => { setWalletActionError(''); setRemoveSeedTarget(group) }}
                        disabled={connected}
                        className="text-danger text-xs hover:underline transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                        title={connected ? 'Disconnect first to remove a seed' : 'Delete this seed and every wallet derived from it'}
                      >
                        Remove seed
                      </button>
                    </div>
                  </div>
                  <div className="p-2 space-y-2">{group.members.map(renderWalletRow)}</div>
                </div>
              ))}

              {locked.length > 0 && (
                <div className="border border-warning rounded-md">
                  <div className="px-4 py-2 border-b border-warning space-y-1">
                    <span className="text-warning text-xs font-medium uppercase tracking-wide block">
                      Cannot be unlocked · {locked.length} {locked.length === 1 ? 'wallet' : 'wallets'}
                    </span>
                    <p className="text-text-secondary text-xs">
                      Saved under the app's previous name, so {locked.length === 1 ? 'its seed' : 'their seeds'} can
                      no longer be unlocked. Import the same recovery phrase again. Your funds are on-chain
                      and unaffected.
                    </p>
                  </div>
                  <div className="p-2 space-y-2">{locked.map(renderWalletRow)}</div>
                </div>
              )}

              <p className="text-text-tertiary text-xs">
                Add Wallet imports or creates another seed phrase. Derive Subaccount adds another wallet to a seed already stored here. Seeds are encrypted with your OS keyring.
              </p>
            </div>
          )}
        </div>
      </div>

      {deriveGroup && (
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
                Creates a new wallet from <span className="text-text-secondary">{deriveGroup.label}</span> ({deriveGroup.members.map((m) => m.name).join(', ')}) at a different BIP-44 path. Same seed, different address.
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

      {phraseGroup && (
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
                <span className="text-text-secondary">{phraseGroup.label}</span>: unlocks{' '}
                {phraseGroup.members.map((m) => m.name).join(', ')}
              </p>
            </div>

            {phrase === null ? (
              <>
                <div className="border border-danger bg-danger-subtle rounded-md p-3 space-y-2">
                  <p className="text-danger text-xs font-medium">Anyone with these words controls this wallet's funds.</p>
                  <ul className="text-text-secondary text-xs space-y-1 list-disc pl-4">
                    <li>Never share them. Nobody from Katacomb will ever ask for them.</li>
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
                {phraseGroup.members.length > 1 && (
                  <p className="text-text-secondary text-xs">
                    These words unlock every wallet in {phraseGroup.label}. Only the derivation path differs.
                  </p>
                )}
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
                    {phraseCopied ? 'Copied. Clipboard clears itself in 30s' : 'Copy to clipboard'}
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

            <p className="text-text-secondary text-xs">{deleteNote(deleteTarget)}</p>

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

      {removeSeedTarget && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]"
          onClick={() => !walletBusy && setRemoveSeedTarget(null)}
        >
          <div
            className="bg-bg-secondary border border-border w-full max-w-md mx-4 p-5 space-y-4 rounded-lg shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-text-primary text-base font-semibold">Remove {removeSeedTarget.label}</h3>

            <div className="border border-danger bg-danger-subtle rounded-md p-3 space-y-2">
              <p className="text-danger text-xs font-medium">
                {removeSeedIsLast
                  ? `Either way, ${removeSeedSubject}`
                  : removeSeedSubject.charAt(0).toUpperCase() + removeSeedSubject.slice(1)}{' '}
                removed from this device.
              </p>
              <ul className="text-text-secondary text-xs space-y-1 list-disc pl-4">
                {removeSeedMembers.map((w) => (
                  <li key={w.id}>
                    <span className="text-text-primary">{w.name}</span> · {w.address || 'address unknown'}
                  </li>
                ))}
              </ul>
              {removeSeedHitsActive && (
                <p className="text-text-secondary text-xs">
                  The wallet in use is among them. Afterwards the app reloads on another stored
                  wallet, or on the wallet screen when none is left.
                </p>
              )}
              <p className="text-text-secondary text-xs">App settings are kept.</p>
            </div>

            {removeSeedIsLast ? (
              <div className="space-y-2 text-xs">
                <p className="text-text-secondary">
                  <span className="text-text-primary font-medium">Keep seed</span>: the recovery
                  phrase stays encrypted on this device, so you can derive new wallets without
                  retyping it.
                </p>
                <p className="text-text-secondary">
                  <span className="text-text-primary font-medium">Delete seed too</span>: the phrase
                  is removed as well. Funds stay on-chain, reachable only by importing your
                  written-down phrase again.
                </p>
              </div>
            ) : (
              <div className="space-y-2 text-xs">
                <p className="text-text-secondary">
                  The seed is removed from this device with them. Funds stay on-chain, reachable
                  only by importing your written-down phrase again.
                </p>
                {locked.length > 0 && (
                  <p className="text-text-secondary">
                    To keep this seed on the device instead, first delete the wallets that cannot
                    be unlocked.
                  </p>
                )}
              </div>
            )}

            {walletActionError && <p className="text-danger text-xs">{walletActionError}</p>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setRemoveSeedTarget(null)}
                disabled={walletBusy}
                className="text-text-secondary hover:text-text-primary text-sm px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              {removeSeedIsLast && (
                <button
                  onClick={() => runRemoveSeed(true)}
                  disabled={walletBusy}
                  className="btn btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
                >
                  Keep seed
                </button>
              )}
              <button
                onClick={() => runRemoveSeed(false)}
                disabled={walletBusy}
                className="btn btn-danger text-sm px-3 py-1.5 disabled:opacity-50 flex items-center gap-2"
              >
                {walletBusy && <Spinner />}
                {removeSeedIsLast
                  ? 'Delete seed too'
                  : removeSeedMembers.length === 1
                    ? 'Delete wallet'
                    : `Delete ${removeSeedMembers.length} wallets`}
              </button>
            </div>
          </div>
        </div>
      )}
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
