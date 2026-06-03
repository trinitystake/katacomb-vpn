import { app, safeStorage } from 'electron'
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeFileAtomic } from './fs-utils'

// --- App Settings ---

export interface AppSettings {
  rpcEndpoint: string
  activeWalletId: string | null
  killSwitch: boolean
  dnsResolver: string
  autoReconnect: boolean
  bookmarkedNodes: string[]
  splitTunnelRoutes: string[]
}

const DEFAULT_SETTINGS: AppSettings = {
  rpcEndpoint: 'https://rpc.sentinel.co:443',
  activeWalletId: null,
  killSwitch: false,
  dnsResolver: 'system',
  autoReconnect: false,
  bookmarkedNodes: [],
  splitTunnelRoutes: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

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
  // BIP-44 account index used to derive `address` from this entry's mnemonic.
  // Missing on legacy entries — treat as 0.
  accountIndex?: number
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

export function addWalletEntry(name: string, address: string, mnemonic: string, accountIndex = 0): WalletEntry {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keyring encryption is not available')
  }

  const id = randomUUID()
  const encrypted = safeStorage.encryptString(mnemonic)
  writeFileAtomic(join(walletsDir(), `${id}.enc`), encrypted)

  const entry: WalletEntry = { id, name, address, accountIndex }
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

export function renameWallet(id: string, newName: string): void {
  const wallets = listWallets()
  const wallet = wallets.find((w) => w.id === id)
  if (!wallet) throw new Error('Wallet not found')
  wallet.name = newName
  saveWalletIndex(wallets)
}

export function deleteWalletEntry(id: string): void {
  const wallets = listWallets()
  const filtered = wallets.filter((w) => w.id !== id)
  saveWalletIndex(filtered)

  const encPath = join(walletsDir(), `${id}.enc`)
  if (existsSync(encPath)) unlinkSync(encPath)

  // If deleted wallet was active, switch to another or clear
  const settings = loadSettings()
  if (settings.activeWalletId === id) {
    saveSettings({ activeWalletId: filtered.length > 0 ? filtered[0].id : null })
  }
}

export function getWalletMnemonic(id: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keyring encryption is not available')
  }
  const encPath = join(walletsDir(), `${id}.enc`)
  if (!existsSync(encPath)) throw new Error('Wallet file not found')
  const encrypted = readFileSync(encPath)
  return safeStorage.decryptString(encrypted)
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

  if (!safeStorage.isEncryptionAvailable()) return

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
