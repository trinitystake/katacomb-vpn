import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { stringToPath } from '@cosmjs/crypto'
import Long from 'long'
import { SentinelClient, privKeyFromMnemonic } from '@sentinel-official/sentinel-js-sdk'
import { Session as NodeSession } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/node/v3/session'
import { Session as SubSession } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/subscription/v3/session'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import {
  getRpcEndpoint,
  loadSettings,
  listWallets,
  addWalletEntry,
  getWalletMnemonic,
  migrateOldWallet,
  saveSettings,
  updateWalletAddress,
  isSeedSource,
  clearRetainedSeed,
} from './settings'
import { WALLET_PREFIX } from '../shared/chain-constants'
import { formatHdPath } from '../shared/hd-path'
import { withTimeout } from './async-utils'

// BIP-44 path for Cosmos SDK chains (coin type 118). Varying the account
// segment yields a different address from the same seed, the way Keplr /
// Ledger Live expose "subaccounts"; varying the address segment walks the
// addresses inside one account.
function cosmosHdPath(accountIndex: number, addressIndex = 0) {
  return stringToPath(formatHdPath(accountIndex, addressIndex))
}

// Fail fast instead of hanging if the configured RPC is slow/unreachable (finding L2).
const RPC_CONNECT_TIMEOUT_MS = 10_000

interface WalletState {
  wallet: DirectSecp256k1HdWallet | null
  address: string | null
  privKey: Uint8Array | null
  activeWalletId: string | null
}

const state: WalletState = {
  wallet: null,
  address: null,
  privKey: null,
  activeWalletId: null,
}

// Zero the previous private-key bytes before replacing them, so a wallet switch/
// restore/import doesn't leave the old key lingering in the heap until GC (finding
// L6). logout() also scrubs; this covers the reassignment paths.
function setPrivKey(next: Uint8Array | null): void {
  if (state.privKey && state.privKey !== next) state.privKey.fill(0)
  state.privKey = next
}

export function hasStoredWallet(): boolean {
  migrateOldWallet()
  const settings = loadSettings()
  if (!settings.activeWalletId) return false
  const wallets = listWallets()
  return wallets.some((w) => w.id === settings.activeWalletId)
}

export function generateMnemonicPhrase(strength: 12 | 24): string {
  const bits = strength === 12 ? 128 : 256
  return generateMnemonic(wordlist, bits)
}

export async function importWallet(mnemonic: string, name?: string, accountIndex = 0): Promise<string> {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: WALLET_PREFIX,
    hdPaths: [cosmosHdPath(accountIndex)],
  })
  const [account] = await wallet.getAccounts()
  // The hdPath is not optional here: privKeyFromMnemonic defaults to account 0,
  // which for any other account index would sign node handshakes with a key that
  // doesn't match the address the session was bought with.
  const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic, hdPath: cosmosHdPath(accountIndex) })

  const walletName = name || `Wallet ${listWallets().length + 1}`
  const entry = addWalletEntry(walletName, account.address, wallet.mnemonic, { accountIndex })
  saveSettings({ activeWalletId: entry.id })

  state.wallet = wallet
  state.address = account.address
  setPrivKey(privKey)
  state.activeWalletId = entry.id

  return account.address
}

export async function restoreWallet(): Promise<string | null> {
  migrateOldWallet()
  const settings = loadSettings()
  if (!settings.activeWalletId) return null

  try {
    const mnemonic = getWalletMnemonic(settings.activeWalletId)
    const wallets = listWallets()
    const entry = wallets.find((w) => w.id === settings.activeWalletId)
    const hdPath = cosmosHdPath(entry?.accountIndex ?? 0, entry?.addressIndex ?? 0)

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: WALLET_PREFIX,
      hdPaths: [hdPath],
    })
    const [account] = await wallet.getAccounts()
    const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic, hdPath })

    state.wallet = wallet
    state.address = account.address
    setPrivKey(privKey)
    state.activeWalletId = settings.activeWalletId

    // Update address in wallet index if it was blank (migration)
    if (entry && !entry.address) {
      updateWalletAddress(settings.activeWalletId, account.address)
    }

    return account.address
  } catch {
    return null
  }
}

export async function switchWallet(walletId: string): Promise<string | null> {
  const wallets = listWallets()
  const entry = wallets.find((w) => w.id === walletId)
  if (!entry) throw new Error('Wallet not found')

  saveSettings({ activeWalletId: walletId })

  try {
    const mnemonic = getWalletMnemonic(walletId)
    const hdPath = cosmosHdPath(entry.accountIndex ?? 0, entry.addressIndex ?? 0)
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: WALLET_PREFIX,
      hdPaths: [hdPath],
    })
    const [account] = await wallet.getAccounts()
    const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic, hdPath })

    state.wallet = wallet
    state.address = account.address
    setPrivKey(privKey)
    state.activeWalletId = walletId

    return account.address
  } catch {
    return null
  }
}

/**
 * Derive a new subaccount from an existing wallet's mnemonic, at a different
 * BIP-44 account and/or address index. Same seed → different address. The
 * resulting WalletEntry owns its own .enc file (mnemonic re-encrypted)
 * so the existing one-file-per-wallet model is preserved.
 */
export async function deriveSubaccount(
  sourceWalletId: string,
  accountIndex: number,
  addressIndex: number,
  name: string,
): Promise<string> {
  if (!isSeedSource(sourceWalletId)) throw new Error('Source wallet not found')

  const mnemonic = getWalletMnemonic(sourceWalletId)
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: WALLET_PREFIX,
    hdPaths: [cosmosHdPath(accountIndex, addressIndex)],
  })
  const [account] = await wallet.getAccounts()

  // Picking a path that's already stored yields an address we already hold;
  // addWalletEntry rejects that (and every other collision) at the store. The
  // renderer greys those rows out, but this is the authoritative check.
  const walletName = name.trim() || `Wallet ${listWallets().length + 1}`
  addWalletEntry(walletName, account.address, wallet.mnemonic, { accountIndex, addressIndex })

  // The new entry now holds its own encrypted copy of this seed, so the retained
  // one is redundant — drop it and we're back to the ordinary "the seed lives in
  // the wallets" model. Only fires when we derived from the retained seed itself.
  if (loadSettings().retainedSeedId === sourceWalletId) clearRetainedSeed()
  return account.address
}

export interface DerivationPreview {
  addressIndex: number
  path: string
  address: string
  /** Name of the stored wallet already holding this address, else null. */
  existingWalletName: string | null
}

/**
 * The addresses a source seed would produce at `count` consecutive address
 * indices under one account, each flagged with the stored wallet already
 * holding it. Matching on the derived address (not on the stored indices) is
 * what makes the flag exact: a wallet from a *different* seed at the same path
 * is a different address and must not grey the row out.
 *
 * Read-only — it creates nothing and returns no key material.
 */
export async function previewDerivations(
  sourceWalletId: string,
  accountIndex: number,
  startIndex: number,
  count: number,
): Promise<DerivationPreview[]> {
  if (!isSeedSource(sourceWalletId)) throw new Error('Source wallet not found')

  const indices = Array.from({ length: count }, (_, i) => startIndex + i)
  const mnemonic = getWalletMnemonic(sourceWalletId)
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: WALLET_PREFIX,
    hdPaths: indices.map((i) => cosmosHdPath(accountIndex, i)),
  })
  // getAccounts() returns one account per hdPath, in the order given.
  const accounts = await wallet.getAccounts()

  const byAddress = new Map(listWallets().filter((w) => w.address).map((w) => [w.address, w.name]))
  return accounts.map((account, i) => ({
    addressIndex: indices[i],
    path: formatHdPath(accountIndex, indices[i]),
    address: account.address,
    existingWalletName: byAddress.get(account.address) ?? null,
  }))
}

/** Credentials for one wallet. `privKey` is live key material — zero it after use. */
export interface WalletCredentials {
  wallet: DirectSecp256k1HdWallet
  address: string
  privKey: Uint8Array
}

/**
 * Derive a wallet's signing material by id WITHOUT making it the active wallet.
 *
 * Multihop with per-hop wallets needs to sign the exit hop's purchase, handshake and
 * cancel as a DIFFERENT account, while the user stays on the wallet they are using.
 * `switchWallet` cannot do that: it mutates the shared state, so the app would
 * silently change wallets underneath the Wallet panel, the balance poll and the
 * Sessions tab in the middle of a purchase.
 *
 * The returned `privKey` is live key material and is NOT tracked by `setPrivKey`, so
 * nothing else will zero it — the caller must, in a finally.
 */
export async function loadWalletCredentials(walletId: string): Promise<WalletCredentials> {
  const entry = listWallets().find((w) => w.id === walletId)
  if (!entry) throw new Error('Wallet not found')
  const mnemonic = getWalletMnemonic(walletId)
  const hdPath = cosmosHdPath(entry.accountIndex ?? 0, entry.addressIndex ?? 0)
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: WALLET_PREFIX,
    hdPaths: [hdPath],
  })
  const [account] = await wallet.getAccounts()
  const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic, hdPath })
  return { wallet, address: account.address, privKey }
}

export function getAddress(): string | null {
  return state.address
}

export function getWallet(): DirectSecp256k1HdWallet | null {
  return state.wallet
}

export function getPrivKey(): Uint8Array | null {
  return state.privKey
}

export async function getBalance(): Promise<{ denom: string; amount: string }[]> {
  if (!state.address) return []
  return getBalanceForAddress(state.address)
}

/**
 * The same read for an account that is NOT the active wallet — a per-hop-wallet
 * chain has to know the second account can afford the hop it is buying, and summing
 * both hops against the active balance would let a broke second wallet through.
 */
export async function getBalanceForAddress(address: string): Promise<{ denom: string; amount: string }[]> {
  if (!address) return []
  const client = await withTimeout(SentinelClient.connect(getRpcEndpoint()), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  try {
    const balances = await client.getAllBalances(address)
    return balances.map((b) => ({ denom: b.denom, amount: b.amount }))
  } finally {
    client.disconnect()
  }
}

/**
 * Is there a direct transfer on chain between these two accounts, in either
 * direction?
 *
 * Per-hop wallets only unlink a chain if the second account's funds did not visibly
 * come from the first. Sending it coins from the main wallet is the obvious way to
 * fund one and it defeats the entire feature — the transfer is public, so anyone who
 * pairs the two addresses has the link back. This is what turns that caveat from a
 * sentence the user can skim into something the app can actually show them.
 *
 * `checked: false` means the question could not be answered (a pruned RPC with no tx
 * index, an unreachable endpoint) — never report that as "clean", because a silent
 * pass here is precisely the false assurance the whole check exists to prevent.
 */
export async function findTransferBetween(
  a: string,
  b: string,
): Promise<{ checked: boolean; linked: boolean }> {
  if (!a || !b || a === b) return { checked: true, linked: false }
  try {
    const client = await withTimeout(SentinelClient.connect(getRpcEndpoint()), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
    try {
      for (const [sender, recipient] of [[a, b], [b, a]]) {
        const hits = await client.searchTx([
          { key: 'transfer.sender', value: sender },
          { key: 'transfer.recipient', value: recipient },
        ])
        if (hits.length > 0) return { checked: true, linked: true }
      }
      return { checked: true, linked: false }
    } finally {
      client.disconnect()
    }
  } catch {
    return { checked: false, linked: false }
  }
}

/** Id of the wallet currently loaded, or null when none is. */
export function getActiveWalletId(): string | null {
  return state.activeWalletId
}

export interface SessionInfo {
  id: string
  nodeAddress: string
  /** See sessionStatusLabel — 'active' | 'inactive_pending' | 'inactive' | 'unknown'. */
  status: string
  downloadBytes: string
  uploadBytes: string
  maxBytes: string
  inactiveAt: string | null
  startAt: string | null
  durationSeconds: number | null
  maxDurationSeconds: number | null
  subscriptionId: string | null
  priceDenom: string | null
  priceValue: string | null
}

function durationToSeconds(d?: { seconds: { toNumber(): number }; nanos: number }): number | null {
  if (!d) return null
  return d.seconds.toNumber() + d.nanos / 1e9
}

/**
 * The chain's SessionStatus enum, spelled out. Statuses 2 and 3 used to collapse
 * into one 'inactive' string, which hid the whole expiry state: a session that
 * runs out of quota moves to inactive_pending(2) on its own, and until it settles
 * to inactive(3) it is still the user's session — it just can no longer be
 * cancelled. Merging the two made it vanish from the Sessions tab the moment the
 * chain became reachable again, which is half of why the failing End button was
 * unreadable.
 */
function sessionStatusLabel(status: number): string {
  if (status === 1) return 'active'
  if (status === 2) return 'inactive_pending'
  if (status === 3) return 'inactive'
  return 'unknown'
}

function decodeSession(any: { typeUrl: string; value: Uint8Array }): SessionInfo | null {
  try {
    if (any.typeUrl === '/sentinel.node.v3.Session') {
      const session = NodeSession.decode(any.value)
      const base = session.baseSession
      if (!base) return null
      return {
        id: base.id.toString(),
        nodeAddress: base.nodeAddress,
        status: sessionStatusLabel(base.status),
        downloadBytes: base.downloadBytes,
        uploadBytes: base.uploadBytes,
        maxBytes: base.maxBytes,
        inactiveAt: base.inactiveAt ? base.inactiveAt.toISOString() : null,
        startAt: base.startAt ? base.startAt.toISOString() : null,
        durationSeconds: durationToSeconds(base.duration),
        maxDurationSeconds: durationToSeconds(base.maxDuration),
        subscriptionId: null,
        priceDenom: session.price?.denom || null,
        priceValue: session.price?.quoteValue || null,
      }
    }
    if (any.typeUrl === '/sentinel.subscription.v3.Session') {
      const session = SubSession.decode(any.value)
      const base = session.baseSession
      if (!base) return null
      return {
        id: base.id.toString(),
        nodeAddress: base.nodeAddress,
        status: sessionStatusLabel(base.status),
        downloadBytes: base.downloadBytes,
        uploadBytes: base.uploadBytes,
        maxBytes: base.maxBytes,
        inactiveAt: base.inactiveAt ? base.inactiveAt.toISOString() : null,
        startAt: base.startAt ? base.startAt.toISOString() : null,
        durationSeconds: durationToSeconds(base.duration),
        maxDurationSeconds: durationToSeconds(base.maxDuration),
        subscriptionId: session.subscriptionId.toString(),
        priceDenom: null,
        priceValue: null,
      }
    }
    return null
  } catch {
    return null
  }
}

export async function getActiveSessions(): Promise<SessionInfo[]> {
  if (!state.address) return []
  return getSessionsForAddress(state.address)
}

/**
 * The same query for an account that is NOT the active wallet.
 *
 * Multihop with per-hop wallets pays for the exit session from a second account, so
 * that session simply does not exist as far as `sessionsForAccount(active)` is
 * concerned — it would vanish from the Sessions tab, meter nothing, and be
 * uncancellable. Callers merge the results; the session ids are globally unique, so
 * there is nothing to reconcile.
 */
export async function getSessionsForAddress(address: string): Promise<SessionInfo[]> {
  if (!address) return []

  try {
    const client = await withTimeout(SentinelClient.connect(getRpcEndpoint()), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
    try {
      const result = await client.sentinelQuery?.session.sessionsForAccount(address, {
        key: new Uint8Array(),
        offset: Long.fromNumber(0, true),
        limit: Long.fromNumber(20, true),
        countTotal: true,
        reverse: false,
      })

      if (!result || !result.sessions) return []

      // 'inactive_pending' is kept alongside 'active': that is the state a session
      // lands in when its own quota runs out, and the user still needs to SEE it —
      // labelled as expired, with the End button withdrawn — rather than have it
      // silently disappear the moment the chain becomes reachable again. Fully
      // 'inactive' (settled) sessions stay filtered; the list would grow forever.
      return result.sessions
        .map((s: { typeUrl: string; value: Uint8Array }) => decodeSession(s))
        .filter((s): s is SessionInfo => s !== null && (s.status === 'active' || s.status === 'inactive_pending'))
    } finally {
      client.disconnect()
    }
  } catch {
    return []
  }
}

export function logout(): void {
  // We zero the private-key bytes (a Uint8Array is mutable), but the mnemonic held
  // inside state.wallet is a JS string — immutable and GC-managed, so it cannot be
  // reliably scrubbed from the V8 heap here and may persist until garbage
  // collection (and could surface in a swap file or core dump). Accepted limitation
  // of the runtime; the seed is never written to disk unencrypted (finding L3).
  state.wallet = null
  state.address = null
  if (state.privKey) {
    state.privKey.fill(0)
  }
  state.privKey = null
  state.activeWalletId = null
  saveSettings({ activeWalletId: null })
}
