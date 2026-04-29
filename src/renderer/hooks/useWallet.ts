import { useState, useEffect, useCallback, useRef } from 'react'
import { useSettings } from '../contexts/SettingsContext'

interface WalletInfo {
  address: string | null
  balance: string | null
  loading: boolean
}

export function useWallet() {
  const [info, setInfo] = useState<WalletInfo>({
    address: null,
    balance: null,
    loading: true,
  })
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { settings } = useSettings()
  const pollSec = settings?.pollBalanceSec ?? 30

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
        setInfo((prev) => ({ ...prev, address, loading: false }))
        if (address) await fetchBalance()
      } else {
        setInfo({ address: null, balance: null, loading: false })
      }
    } catch {
      setInfo({ address: null, balance: null, loading: false })
    }
  }, [fetchBalance])

  useEffect(() => {
    initialize()
    intervalRef.current = setInterval(fetchBalance, pollSec * 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [initialize, fetchBalance, pollSec])

  async function importWallet(mnemonic: string): Promise<string> {
    const result = await window.api.walletImport(mnemonic)
    setInfo({ address: result.address, balance: null, loading: false })
    await fetchBalance()
    return result.address
  }

  async function logout() {
    await window.api.walletLogout()
    setInfo({ address: null, balance: null, loading: false })
  }

  return {
    ...info,
    importWallet,
    logout,
    refresh: fetchBalance,
  }
}
