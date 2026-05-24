import { useState, useEffect, useCallback, useRef } from 'react'

const POLL_BALANCE_MS = 300_000

interface WalletInfo {
  address: string | null
  name: string | null
  balance: string | null
  loading: boolean
}

async function fetchActiveName(address: string): Promise<string | null> {
  try {
    const wallets = await window.api.walletList()
    return wallets.find((w) => w.address === address)?.name ?? null
  } catch {
    return null
  }
}

export function useWallet() {
  const [info, setInfo] = useState<WalletInfo>({
    address: null,
    name: null,
    balance: null,
    loading: true,
  })
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchBalance = useCallback(async () => {
    try {
      const balances = await window.api.walletGetBalance()
      const udvpn = balances.find((b: { denom: string }) => b.denom === 'udvpn')
      const balance = udvpn ? (parseInt(udvpn.amount, 10) / 1e6).toFixed(2) : '0.00'
      setInfo((prev) => ({ ...prev, balance }))
    } catch {
      // silent
    }
  }, [])

  const initialize = useCallback(async () => {
    try {
      const hasStored = await window.api.walletHasStored()
      if (hasStored) {
        const address = await window.api.walletGetAddress()
        const name = address ? await fetchActiveName(address) : null
        setInfo((prev) => ({ ...prev, address, name, loading: false }))
        if (address) await fetchBalance()
      } else {
        setInfo({ address: null, name: null, balance: null, loading: false })
      }
    } catch {
      setInfo({ address: null, name: null, balance: null, loading: false })
    }
  }, [fetchBalance])

  useEffect(() => {
    initialize()
    intervalRef.current = setInterval(fetchBalance, POLL_BALANCE_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [initialize, fetchBalance])

  async function importWallet(mnemonic: string, name?: string): Promise<string> {
    const result = await window.api.walletImport(mnemonic, name)
    const resolvedName = await fetchActiveName(result.address)
    setInfo({ address: result.address, name: resolvedName, balance: null, loading: false })
    await fetchBalance()
    return result.address
  }

  // Re-fetch the active wallet's address + name. Called after operations
  // outside this hook that can change them (e.g. renaming the active wallet
  // in the Settings modal).
  const refreshIdentity = useCallback(async () => {
    try {
      const address = await window.api.walletGetAddress()
      const name = address ? await fetchActiveName(address) : null
      setInfo((prev) => ({ ...prev, address, name }))
    } catch {
      // silent
    }
  }, [])

  async function logout() {
    await window.api.walletLogout()
    setInfo({ address: null, name: null, balance: null, loading: false })
  }

  return {
    ...info,
    importWallet,
    logout,
    refresh: fetchBalance,
    refreshIdentity,
  }
}
