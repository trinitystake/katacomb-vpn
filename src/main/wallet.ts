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
} from './settings'
import { WALLET_PREFIX } from '../shared/chain-constants'
import { withTimeout } from './async-utils'

// BIP-44 path for Cosmos SDK chains (coin type 118). Varying the account
// segment yields a different address from the same seed, the way Keplr /
// Ledger Live expose "subaccounts".
const COSMOS_COIN_TYPE = 118
function cosmosHdPath(accountIndex: number) {
  return stringToPath(`m/44'/${COSMOS_COIN_TYPE}'/${accountIndex}'/0/0`)
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
  const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })

  const walletName = name || `Wallet ${listWallets().length + 1}`
  const entry = addWalletEntry(walletName, account.address, wallet.mnemonic, accountIndex)
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
    const accountIndex = entry?.accountIndex ?? 0

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: WALLET_PREFIX,
      hdPaths: [cosmosHdPath(accountIndex)],
    })
    const [account] = await wallet.getAccounts()
    const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })

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
    const accountIndex = entry.accountIndex ?? 0
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: WALLET_PREFIX,
      hdPaths: [cosmosHdPath(accountIndex)],
    })
    const [account] = await wallet.getAccounts()
    const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })

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
 * Derive a new subaccount from an existing wallet's mnemonic, using a
 * different BIP-44 account index. Same seed → different address. The
 * resulting WalletEntry owns its own .enc file (mnemonic re-encrypted)
 * so the existing one-file-per-wallet model is preserved.
 */
export async function deriveSubaccount(
  sourceWalletId: string,
  accountIndex: number,
  name: string,
): Promise<string> {
  const wallets = listWallets()
  const source = wallets.find((w) => w.id === sourceWalletId)
  if (!source) throw new Error('Source wallet not found')

  const mnemonic = getWalletMnemonic(sourceWalletId)
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: WALLET_PREFIX,
    hdPaths: [cosmosHdPath(accountIndex)],
  })
  const [account] = await wallet.getAccounts()

  // Reject if an existing wallet already holds this address (e.g. picking
  // index 0 when the source is already at index 0).
  if (wallets.some((w) => w.address === account.address)) {
    throw new Error(`A wallet with address ${account.address} already exists`)
  }

  const walletName = name.trim() || `Wallet ${listWallets().length + 1}`
  addWalletEntry(walletName, account.address, wallet.mnemonic, accountIndex)
  return account.address
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

  const client = await withTimeout(SentinelClient.connect(getRpcEndpoint()), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  try {
    const balances = await client.getAllBalances(state.address)
    return balances.map((b) => ({ denom: b.denom, amount: b.amount }))
  } finally {
    client.disconnect()
  }
}

export interface SessionInfo {
  id: string
  nodeAddress: string
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

function decodeSession(any: { typeUrl: string; value: Uint8Array }): SessionInfo | null {
  try {
    if (any.typeUrl === '/sentinel.node.v3.Session') {
      const session = NodeSession.decode(any.value)
      const base = session.baseSession
      if (!base) return null
      return {
        id: base.id.toString(),
        nodeAddress: base.nodeAddress,
        status: base.status === 1 ? 'active' : 'inactive',
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
        status: base.status === 1 ? 'active' : 'inactive',
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

  try {
    const client = await withTimeout(SentinelClient.connect(getRpcEndpoint()), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
    try {
      const result = await client.sentinelQuery?.session.sessionsForAccount(state.address, {
        key: new Uint8Array(),
        offset: Long.fromNumber(0, true),
        limit: Long.fromNumber(20, true),
        countTotal: true,
        reverse: false,
      })

      if (!result || !result.sessions) return []

      return result.sessions
        .map((s: { typeUrl: string; value: Uint8Array }) => decodeSession(s))
        .filter((s): s is SessionInfo => s !== null && s.status === 'active')
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
