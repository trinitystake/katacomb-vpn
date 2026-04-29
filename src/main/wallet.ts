import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
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

export async function importWallet(mnemonic: string, name?: string): Promise<string> {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: WALLET_PREFIX,
  })
  const [account] = await wallet.getAccounts()
  const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })

  const walletName = name || `Wallet ${listWallets().length + 1}`
  const entry = addWalletEntry(walletName, account.address, wallet.mnemonic)
  saveSettings({ activeWalletId: entry.id })

  state.wallet = wallet
  state.address = account.address
  state.privKey = privKey
  state.activeWalletId = entry.id

  return account.address
}

export async function restoreWallet(): Promise<string | null> {
  migrateOldWallet()
  const settings = loadSettings()
  if (!settings.activeWalletId) return null

  try {
    const mnemonic = getWalletMnemonic(settings.activeWalletId)

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: WALLET_PREFIX,
    })
    const [account] = await wallet.getAccounts()
    const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })

    state.wallet = wallet
    state.address = account.address
    state.privKey = privKey
    state.activeWalletId = settings.activeWalletId

    // Update address in wallet index if it was blank (migration)
    const wallets = listWallets()
    const entry = wallets.find((w) => w.id === settings.activeWalletId)
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
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: WALLET_PREFIX,
    })
    const [account] = await wallet.getAccounts()
    const privKey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })

    state.wallet = wallet
    state.address = account.address
    state.privKey = privKey
    state.activeWalletId = walletId

    return account.address
  } catch {
    return null
  }
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

  const client = await SentinelClient.connect(getRpcEndpoint())
  const balances = await client.getAllBalances(state.address)
  client.disconnect()
  return balances.map((b) => ({ denom: b.denom, amount: b.amount }))
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
    const client = await SentinelClient.connect(getRpcEndpoint())
    const result = await client.sentinelQuery?.session.sessionsForAccount(state.address, {
      limit: Long.fromNumber(20, true),
      countTotal: true,
    })
    client.disconnect()

    if (!result || !result.sessions) return []

    return result.sessions
      .map((s: { typeUrl: string; value: Uint8Array }) => decodeSession(s))
      .filter((s): s is SessionInfo => s !== null && s.status === 'active')
  } catch {
    return []
  }
}

export function logout(): void {
  state.wallet = null
  state.address = null
  if (state.privKey) {
    state.privKey.fill(0)
  }
  state.privKey = null
  state.activeWalletId = null
  saveSettings({ activeWalletId: null })
}
