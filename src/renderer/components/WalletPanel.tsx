import { useState, useEffect, useRef } from 'react'
import Spinner from './Spinner'

interface Props {
  address: string | null
  onLogout: () => void
}

export default function WalletPanel({ address, onLogout }: Props) {
  const [balance, setBalance] = useState<string | null>(null)
  const [sessions, setSessions] = useState<{ id: string; nodeAddress: string; status: string }[]>([])
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (address) {
      fetchBalance()
      fetchSessions()
    }
    intervalRef.current = setInterval(() => {
      fetchBalance()
      fetchSessions()
    }, 30_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [address])

  useEffect(() => {
    if (!expanded) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [expanded])

  async function refresh() {
    setRefreshing(true)
    try {
      await Promise.all([fetchBalance(), fetchSessions()])
    } finally {
      setRefreshing(false)
    }
  }

  async function fetchBalance() {
    try {
      const balances = await window.api.walletGetBalance()
      const udvpn = balances.find((b: { denom: string }) => b.denom === 'udvpn')
      setBalance(udvpn ? (parseInt(udvpn.amount, 10) / 1e6).toFixed(2) : '0.00')
    } catch {
      // silent
    }
  }

  async function fetchSessions() {
    try {
      const s = await window.api.walletSessions()
      setSessions(s)
    } catch {
      // silent
    }
  }

  function truncateAddress(addr: string): string {
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`
  }

  async function copyAddress() {
    if (!address) return
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!address) return null

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex items-center gap-4 text-sm">
        {balance !== null && (
          <span className="text-success font-medium font-mono">
            {balance} <span className="text-text-secondary font-normal font-sans">P2P</span>
          </span>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-text-secondary hover:text-accent transition-colors font-mono text-xs"
          title="Wallet details"
        >
          {truncateAddress(address)}
        </button>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-text-secondary hover:text-accent transition-colors"
          title="Wallet details"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {expanded ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
          </svg>
        </button>
        <button
          onClick={onLogout}
          className="text-text-secondary hover:text-danger transition-colors text-sm"
          title="Logout"
        >
          Logout
        </button>
      </div>

      {expanded && (
        <div className="absolute right-0 top-full mt-2 bg-bg-secondary border border-border p-4 w-80 z-50 space-y-3 rounded-lg shadow-overlay">
          <div className="space-y-2 text-sm">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-text-secondary text-xs">Address</span>
                <button
                  onClick={copyAddress}
                  className="text-text-secondary hover:text-accent transition-colors text-xs"
                  title="Copy address"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <button
                onClick={copyAddress}
                className="text-text-primary font-mono text-xs break-all mt-0.5 text-left w-full hover:text-accent transition-colors"
                title="Copy address"
              >
                {address}
              </button>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Balance</span>
              <span className="text-success font-mono">{balance || '...'} P2P</span>
            </div>
          </div>

          {sessions.length > 0 && (
            <div className="border-t border-border pt-2">
              <span className="text-text-secondary text-xs font-medium">Active Sessions</span>
              <div className="mt-1 space-y-1">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between text-sm">
                    <span className="text-text-primary font-mono">#{s.id}</span>
                    <span className={s.status === 'active' ? 'text-success' : 'text-text-secondary'}>
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={refresh}
            disabled={refreshing}
            className="text-text-secondary hover:text-accent text-sm transition-colors w-full text-center inline-flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {refreshing ? <><Spinner className="text-accent" /> Refreshing</> : 'Refresh'}
          </button>
        </div>
      )}
    </div>
  )
}
