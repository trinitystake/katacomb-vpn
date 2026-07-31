import { useState, useEffect, useCallback } from 'react'
import type { WalletStoreStatus } from '../types'

interface WalletInfo {
  address: string | null
  name: string | null
  loading: boolean
  /** Everything on disk, so App can show the picker when nothing is active. */
  store: WalletStoreStatus | null
}

const EMPTY: WalletInfo = { address: null, name: null, loading: false, store: null }

export function useWallet() {
  const [info, setInfo] = useState<WalletInfo>({ ...EMPTY, loading: true })

  /**
   * Read the store and the active wallet together. The name is resolved by
   * `activeWalletId`, not by address — matching on address returned whichever
   * entry happened to be first when two shared one.
   */
  const load = useCallback(async () => {
    try {
      const store = await window.api.walletStoreStatus()
      const hasStored = await window.api.walletHasStored()
      const address = hasStored ? await window.api.walletGetAddress() : null
      const name = store.wallets.find((w) => w.id === store.activeWalletId)?.name ?? null
      setInfo({ address, name, loading: false, store })
    } catch {
      setInfo(EMPTY)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function importWallet(mnemonic: string, name?: string): Promise<string> {
    const result = await window.api.walletImport(mnemonic, name)
    await load()
    return result.address
  }

  async function logout() {
    await window.api.walletLogout()
    // The seeds stay on disk — reload so the picker can offer them back rather
    // than dropping the user on the import screen.
    await load()
  }

  return {
    ...info,
    importWallet,
    logout,
    /** Re-read after a change made elsewhere (renaming, switching, deleting). */
    refreshIdentity: load,
  }
}
