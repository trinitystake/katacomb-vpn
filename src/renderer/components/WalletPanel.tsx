import { useState, useEffect, useRef } from 'react'
import Spinner from './Spinner'
import { useBalance } from '../hooks/useBalance'

interface Props {
  address: string | null
  name: string | null
  /** Locks the wallet: clears it from memory, leaves the encrypted seed on disk. */
  onLogout: () => void
  connected: boolean
}

export default function WalletPanel({ address, name, onLogout, connected }: Props) {
  const { display: balance, refresh: refreshBalance } = useBalance()
  const [sessions, setSessions] = useState<{ id: string; nodeAddress: string; status: string }[]>([])
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (address) fetchSessions()
    intervalRef.current = setInterval(fetchSessions, 30_000)
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
      await Promise.all([refreshBalance(), fetchSessions()])
    } finally {
      setRefreshing(false)
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

  async function copyAddress() {
    if (!address) return
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!address) return null

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex items-center gap-1.5 text-sm">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-text-secondary hover:text-accent transition-colors"
          title="Wallet details"
        >
          Wallet
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
      </div>

      {expanded && (
        <div className="absolute right-0 top-full mt-2 bg-bg-secondary border border-border p-4 w-80 z-50 space-y-3 rounded-lg shadow-overlay">
          {name && (
            <div className="text-text-primary text-sm font-semibold pb-2 border-b border-border">
              {name}
            </div>
          )}
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
            <div className="flex justify-between items-center">
              <span className="text-text-secondary">Balance</span>
              <div className="flex items-center gap-2">
                {connected && (
                  <span
                    className="text-text-tertiary text-xs"
                    title="Connected to the VPN — the chain is unreachable through the tunnel, so this is the balance from before you connected."
                  >
                    cached
                  </span>
                )}
                <span className="text-success font-mono">{balance || '...'} P2P</span>
                <button
                  onClick={refresh}
                  disabled={refreshing || connected}
                  className="text-text-secondary hover:text-accent transition-colors disabled:opacity-50"
                  title={connected ? 'Balance refresh is unavailable while connected (RPC routes through the tunnel)' : 'Refresh balance'}
                  aria-label="Refresh balance"
                >
                  {refreshing ? (
                    <Spinner />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                  )}
                </button>
              </div>
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

          {/* "Lock", not "Logout": the seeds stay encrypted on this device and
              come back from the wallet picker. Deleting is a separate, explicit
              action in Settings → Wallets. */}
          <button
            onClick={onLogout}
            className="text-text-secondary hover:text-danger text-sm transition-colors w-full text-center"
            title="Lock — your wallets stay stored on this device"
          >
            Lock
          </button>
        </div>
      )}
    </div>
  )
}
