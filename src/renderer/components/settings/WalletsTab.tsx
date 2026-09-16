import { useState, useEffect, useMemo, useRef } from 'react'
import type { WalletStoreStatus, AppSettings, DerivationPreview } from '../../types'
import Spinner from '../Spinner'
import { parseWalletExists } from '../../../shared/wallet-errors'
import { displayConnectError } from '../../utils/connect-errors'
import { formatHdPath, DERIVE_PREVIEW_MAX_COUNT } from '../../../shared/hd-path'
import { groupWalletsBySeed, type SeedGroup } from '../../../shared/seed-groups'

// Address indices shown per page in the derive picker, and how long a revealed
// recovery phrase stays on screen before it re-blurs.
const PREVIEW_PAGE = 10
const REBLUR_MS = 60_000
const CLIPBOARD_CLEAR_MS = 30_000

type StoredWallet = WalletStoreStatus['wallets'][number]
// What the derive / recovery-phrase / remove-seed modals act on: one seed and the
// wallets stored under it. Any member's id serves as the seed source in main.
type Group = SeedGroup<StoredWallet>

interface Props {
  wallets: StoredWallet[]
  settings: AppSettings
  /**
   * A session is live, in any mode: tunnel, local proxy, or the reconnect window.
   * Main refuses every change to the active wallet then (assertNotConnected), so
   * these actions grey out behind a banner. The handlers are the enforcement;
   * this is only the UX.
   */
  connected: boolean
  /** Re-read settings and the wallet store after a mutation. */
  reload: () => Promise<void>
  onWalletSwitch: () => void
  onWalletsChanged?: () => void
  onAddWallet: () => void
}

/**
 * The Wallets tab and its four modals (derive subaccount, recovery phrase,
 * delete wallet, remove seed).
 *
 * Split out of Settings.tsx because it owns its own world: of the ~60 symbols
 * that file declared, 41 were used by this tab alone - every piece of modal
 * state, and the seed material that must not outlive the modal. Nothing here is
 * shared with the General or Network tabs beyond `settings` and the wallet list.
 *
 * The modals are rendered as siblings of the tab body (a fragment), exactly as
 * they were in Settings.tsx: they are `fixed inset-0` overlays at z-[60], above
 * the settings dialog's own z-50, so nesting them inside the scrolling pane
 * would change what they cover.
 */
export default function WalletsTab({
  wallets, settings, connected, reload, onWalletSwitch, onWalletsChanged, onAddWallet,
}: Props) {
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
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
      await reload()
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
      await reload()
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
    await reload()
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
      await reload()
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
    <>
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
    </>
  )
}
