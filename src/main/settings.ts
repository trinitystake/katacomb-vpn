import { app, safeStorage } from 'electron'
import { readFileSync, existsSync, unlinkSync, mkdirSync, cpSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { WALLET_EXISTS } from '../shared/error-markers'
import { writeFileAtomic } from './fs-utils'

// --- Pre-rename profile migration ---

// userData is derived from package.json `name`, so the Sentinel dVPN → Katacomb
// VPN rename moved it. Everything the user owns lived under the old directory.
const LEGACY_USER_DATA_DIR = 'sentinel-dvpn-app'
// Caches (*-cache.json) and Chromium state are deliberately not carried over —
// they regenerate, and copying them would just move stale data.
const MIGRATED_ENTRIES = ['settings.json', 'wallets-index.json', 'wallets', 'sessions']

/**
 * One-time copy of the pre-rename profile into the new userData directory.
 * Copies rather than moves, so the old directory survives as a fallback.
 *
 * NOTE: the `.enc` seed files come across but will NOT decrypt — safeStorage's
 * libsecret key is looked up by app name, so the rename invalidates it (verified:
 * same ciphertext decrypts under `sentinel-dvpn-app` and fails under
 * `katacomb-vpn`). Copying them anyway keeps the wallet's name and address
 * visible, so the user knows which seed phrase to re-enter; getWalletMnemonic
 * turns the resulting failure into that instruction.
 */
export function migrateLegacyUserData(): void {
  const dest = app.getPath('userData')
  // Already migrated (or a fresh install that has since created wallets).
  if (existsSync(join(dest, 'wallets-index.json'))) return

  const legacy = join(app.getPath('appData'), LEGACY_USER_DATA_DIR)
  if (!existsSync(join(legacy, 'wallets-index.json'))) return

  mkdirSync(dest, { recursive: true })
  for (const entry of MIGRATED_ENTRIES) {
    const from = join(legacy, entry)
    if (!existsSync(from)) continue
    try {
      cpSync(from, join(dest, entry), { recursive: true, preserveTimestamps: true })
    } catch {
      // Best-effort: a partial migration still beats starting empty, and the
      // legacy directory is left untouched either way.
    }
  }
}

// --- App Settings ---

export interface AppSettings {
  rpcEndpoint: string
  activeWalletId: string | null
  killSwitch: boolean
  /**
   * Let LAN destinations (SSH, printers, NAS) past the kill switch's DROP-all
   * chain. Only meaningful while the kill switch is armed — with it off the LAN
   * is already reachable, since no protocol's routing captures it. The ranges
   * live in the root helper; this boolean is all that crosses the boundary.
   */
  lanSharing: boolean
  dnsResolver: string
  autoReconnect: boolean
  bookmarkedNodes: string[]
  splitTunnelRoutes: string[]
  /**
   * A seed kept on disk after its last derived wallet was deleted, so the user can
   * derive new wallets without retyping the phrase. Holds the id of the wallet it
   * outlived — that entry is gone from the index but its `wallets/<id>.enc` is
   * deliberately NOT unlinked, which is the only way a seed can exist with no
   * wallets (every entry stores its own copy of the mnemonic). Only ever set while
   * zero wallets are stored; deriving from it or removing it clears it.
   */
  retainedSeedId: string | null
}

const DEFAULT_SETTINGS: AppSettings = {
  rpcEndpoint: 'https://rpc.sentinel.co:443',
  activeWalletId: null,
  killSwitch: false,
  lanSharing: false,
  dnsResolver: 'system',
  autoReconnect: false,
  bookmarkedNodes: [],
  splitTunnelRoutes: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  retainedSeedId: null,
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * True only when the OS keyring provides *real* encryption. On Linux without a
 * libsecret/kwallet keyring, Electron's safeStorage silently selects the
 * `basic_text` backend, which "encrypts" with a hardcoded key — so the seed
 * `.enc` files would be trivially reversible by anyone who can read them. We
 * refuse to PERSIST secrets in that case (finding H1). Reads intentionally stay
 * on the looser `isEncryptionAvailable()` so a wallet saved under a real backend
 * still loads even if the keyring is transiently unavailable.
 */
export function isSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  // getSelectedStorageBackend is Linux-only (the app's only target); a non-Linux
  // or 'unknown' backend is treated as acceptable — only the known-insecure
  // basic_text is rejected.
  try {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    return true
  }
}

const INSECURE_STORAGE_MESSAGE =
  'Secure storage is unavailable: no OS keyring (GNOME Keyring / KWallet) was found, ' +
  'so the seed phrase can only be stored with reversible encryption. Refusing to save it. ' +
  'Install and unlock a keyring (e.g. gnome-keyring / libsecret) and try again.'

export function loadSettings(): AppSettings {
  const path = settingsPath()
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    return { ...DEFAULT_SETTINGS, ...data }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const merged = { ...current, ...settings }
  writeFileAtomic(settingsPath(), JSON.stringify(merged, null, 2))
  return merged
}

export function getRpcEndpoint(): string {
  return loadSettings().rpcEndpoint
}

// --- Wallet Store (multiple wallets with names) ---

export interface WalletEntry {
  id: string
  name: string
  address: string
  // BIP-44 account and address indices used to derive `address` from this
  // entry's mnemonic (`m/44'/118'/<account>'/0/<address>`). Missing on legacy
  // entries — treat either as 0.
  accountIndex?: number
  addressIndex?: number
  /**
   * Reveals the Provider tab for THIS wallet. Not a preference so much as a mode:
   * the tab also appears on its own once the wallet has a provider registered on
   * chain, so this only matters before a first registration. Per-wallet on
   * purpose — as one global setting it followed the user onto every seed they
   * imported afterwards, offering a provider console to wallets that have none.
   */
  providerMode?: boolean
}

function walletsDir(): string {
  const dir = join(app.getPath('userData'), 'wallets')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function walletIndexPath(): string {
  return join(app.getPath('userData'), 'wallets-index.json')
}

export function listWallets(): WalletEntry[] {
  const path = walletIndexPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
}

function saveWalletIndex(wallets: WalletEntry[]): void {
  writeFileAtomic(walletIndexPath(), JSON.stringify(wallets, null, 2))
}

export function addWalletEntry(
  name: string,
  address: string,
  mnemonic: string,
  { accountIndex = 0, addressIndex = 0 }: { accountIndex?: number; addressIndex?: number } = {},
): WalletEntry {
  if (!isSecureStorageAvailable()) {
    throw new Error(INSECURE_STORAGE_MESSAGE)
  }

  // One entry per address, enforced here rather than at each caller — importing a
  // seed that's already stored used to create a second entry for the same address
  // (two rows, both showing as active, one wallet). The blank-address guard
  // matters: migrateOldWallet writes `address: ''` until the first restore fills
  // it in, and blank is not an identity.
  const clash = listWallets().find((w) => w.address && w.address === address)
  if (clash) {
    throw new Error(`${WALLET_EXISTS}:${clash.id}: That seed is already stored as "${clash.name}".`)
  }

  const id = randomUUID()
  const encrypted = safeStorage.encryptString(mnemonic)
  writeFileAtomic(join(walletsDir(), `${id}.enc`), encrypted)

  const entry: WalletEntry = { id, name, address, accountIndex, addressIndex }
  const wallets = listWallets()
  wallets.push(entry)
  saveWalletIndex(wallets)

  // Set as active if first wallet
  const settings = loadSettings()
  if (!settings.activeWalletId) {
    saveSettings({ activeWalletId: id })
  }

  return entry
}

export function updateWalletAddress(id: string, address: string): void {
  const wallets = listWallets()
  const wallet = wallets.find((w) => w.id === id)
  if (wallet) {
    wallet.address = address
    saveWalletIndex(wallets)
  }
}

export function setWalletProviderMode(id: string, enabled: boolean): void {
  const wallets = listWallets()
  const wallet = wallets.find((w) => w.id === id)
  if (!wallet) throw new Error('Wallet not found')
  wallet.providerMode = enabled
  saveWalletIndex(wallets)
}

/**
 * One-time move of `providerMode` from app settings onto the wallet entry.
 *
 * It was a single global boolean, so once it was switched on for the wallet that
 * really had a provider, every seed imported afterwards inherited the Provider
 * tab. Carry the old value onto the active wallet — the one the user last had it
 * on for — and drop the key, so every other wallet starts from off.
 *
 * Must run after dedupeWalletEntries, which can itself rewrite activeWalletId.
 */
export function migrateProviderModeToWallet(): void {
  const path = settingsPath()
  if (!existsSync(path)) return
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return
  }
  if (!('providerMode' in raw)) return

  const enabled = raw['providerMode'] === true
  delete raw['providerMode']
  writeFileAtomic(path, JSON.stringify(raw, null, 2))
  if (!enabled) return

  const activeId = typeof raw['activeWalletId'] === 'string' ? raw['activeWalletId'] : null
  if (activeId && listWallets().some((w) => w.id === activeId)) {
    setWalletProviderMode(activeId, true)
  }
}

export function renameWallet(id: string, newName: string): void {
  const wallets = listWallets()
  const wallet = wallets.find((w) => w.id === id)
  if (!wallet) throw new Error('Wallet not found')
  wallet.name = newName
  saveWalletIndex(wallets)
}

export function deleteWalletEntry(id: string, { keepSeed = false }: { keepSeed?: boolean } = {}): void {
  const wallets = listWallets()
  const filtered = wallets.filter((w) => w.id !== id)
  saveWalletIndex(filtered)

  // Keeping the seed means leaving this entry's `.enc` behind and pointing
  // retainedSeedId at it. Only meaningful for the last wallet — while others
  // remain they still hold their own copies, so the file is just redundant.
  if (keepSeed && filtered.length === 0) {
    saveSettings({ retainedSeedId: id })
  } else {
    const encPath = join(walletsDir(), `${id}.enc`)
    if (existsSync(encPath)) unlinkSync(encPath)
  }

  // If deleted wallet was active, switch to another or clear
  const settings = loadSettings()
  if (settings.activeWalletId === id) {
    saveSettings({ activeWalletId: filtered.length > 0 ? filtered[0].id : null })
  }
}

/** Drop the retained seed and its encrypted file. No-op when none is retained. */
export function clearRetainedSeed(): void {
  const { retainedSeedId } = loadSettings()
  if (!retainedSeedId) return
  const encPath = join(walletsDir(), `${retainedSeedId}.enc`)
  if (existsSync(encPath)) unlinkSync(encPath)
  saveSettings({ retainedSeedId: null })
}

/**
 * Ids that can act as a derivation source: any stored wallet, plus the retained
 * seed — which has no index entry but still has its `.enc` on disk.
 */
export function isSeedSource(id: string): boolean {
  return listWallets().some((w) => w.id === id) || loadSettings().retainedSeedId === id
}

export function getWalletMnemonic(id: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keyring encryption is not available')
  }
  const encPath = join(walletsDir(), `${id}.enc`)
  if (!existsSync(encPath)) throw new Error('Wallet file not found')
  const encrypted = readFileSync(encPath)
  try {
    return safeStorage.decryptString(encrypted)
  } catch {
    // safeStorage's keyring entry is keyed by app name, so a seed saved before
    // the rename cannot be decrypted now. Tell the user what to do instead of
    // surfacing "Error while decrypting the ciphertext provided to …".
    throw new Error(
      'This wallet was saved under the app\'s previous name and can no longer be unlocked. ' +
      'Remove it and import the same seed phrase again. Your funds are on-chain and unaffected.'
    )
  }
}

/**
 * Can this wallet's seed actually be decrypted? Used to show a stored wallet as
 * needing re-entry BEFORE the user picks it and hits a failure. Never returns
 * the seed itself.
 */
export function canUnlockWallet(id: string): boolean {
  try {
    getWalletMnemonic(id)
    return true
  } catch {
    return false
  }
}

/**
 * Collapse index entries that share an address down to one, deleting the
 * redundant `.enc` files. Repairs installs made before `addWalletEntry` enforced
 * uniqueness, where re-importing an already-stored seed produced a second entry
 * for the same wallet (both then rendered as "Active").
 *
 * The survivor is the oldest entry **whose seed can actually be decrypted** —
 * not simply the oldest. A duplicate created by re-importing after the app
 * rename is the common case, and there the older entry is precisely the one
 * whose `.enc` no longer opens (safeStorage keys its entry by app name). Keeping
 * it would throw away the only working copy.
 *
 * Entries with a blank address are left alone — migrateOldWallet writes one
 * until the first restore fills it in, and blank is not an identity.
 */
export function dedupeWalletEntries(): void {
  const wallets = listWallets()

  const byAddress = new Map<string, WalletEntry[]>()
  for (const wallet of wallets) {
    if (!wallet.address) continue
    const group = byAddress.get(wallet.address)
    if (group) group.push(wallet)
    else byAddress.set(wallet.address, [wallet])
  }
  if (![...byAddress.values()].some((group) => group.length > 1)) return

  // Only decrypt when there's actually a duplicate to resolve, so a normal
  // startup never pays for this.
  const survivorId = new Map<string, string>() // address → id we keep
  for (const [address, group] of byAddress) {
    const survivor = group.find((w) => canUnlockWallet(w.id)) ?? group[0]
    survivorId.set(address, survivor.id)
  }

  const kept: WalletEntry[] = []
  const dropped: string[] = []
  // id of the entry each dropped one collapsed into, so a stale activeWalletId
  // can be repointed rather than cleared.
  const survivorOf = new Map<string, string>()

  for (const wallet of wallets) {
    const survivor = wallet.address ? survivorId.get(wallet.address) : undefined
    if (survivor !== undefined && survivor !== wallet.id) {
      dropped.push(wallet.id)
      survivorOf.set(wallet.id, survivor)
      continue
    }
    kept.push(wallet)
  }

  if (dropped.length === 0) return

  saveWalletIndex(kept)
  for (const id of dropped) {
    const encPath = join(walletsDir(), `${id}.enc`)
    if (existsSync(encPath)) {
      try {
        unlinkSync(encPath)
      } catch {
        // Index is already correct; a leftover file is inert.
      }
    }
  }

  const activeWalletId = loadSettings().activeWalletId
  if (activeWalletId && survivorOf.has(activeWalletId)) {
    saveSettings({ activeWalletId: survivorOf.get(activeWalletId)! })
  }

  console.log(`[wallets] merged ${dropped.length} duplicate entr${dropped.length === 1 ? 'y' : 'ies'}`)
}

/**
 * Migrate old single-wallet format (wallet.enc) to the new multi-wallet store.
 * Called once on startup.
 */
export function migrateOldWallet(): void {
  const oldPath = join(app.getPath('userData'), 'wallet.enc')
  if (!existsSync(oldPath)) return

  const wallets = listWallets()
  if (wallets.length > 0) {
    // Already migrated, just delete old file
    unlinkSync(oldPath)
    return
  }

  // Re-encrypting under the insecure basic_text backend would persist the seed
  // reversibly (finding H1) — leave the old file untouched so it can migrate once
  // a real keyring is available.
  if (!isSecureStorageAvailable()) return

  try {
    const encrypted = readFileSync(oldPath)
    const mnemonic = safeStorage.decryptString(encrypted)

    // We need to derive the address — import dynamically to avoid circular deps
    // For migration, we store mnemonic and will derive address when loaded
    const id = randomUUID()
    const reEncrypted = safeStorage.encryptString(mnemonic)
    writeFileAtomic(join(walletsDir(), `${id}.enc`), reEncrypted)

    const entry: WalletEntry = { id, name: 'My Wallet', address: '' }
    // Index + active-id are written (atomically) before the old file is removed,
    // so a crash mid-migration leaves the original wallet.enc recoverable.
    saveWalletIndex([entry])
    saveSettings({ activeWalletId: id })

    // Delete old file
    unlinkSync(oldPath)
  } catch (err) {
    // Migration failed — leave old file so the user can re-import. Surface the
    // cause instead of swallowing it silently.
    console.error('[migrate] Failed to migrate legacy wallet.enc:', err)
  }
}
