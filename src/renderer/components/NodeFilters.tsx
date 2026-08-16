import { useEffect, useRef, useState } from 'react'
import Spinner from './Spinner'
import { DEFAULT_FILTER } from '../hooks/useNodes'
import type { NodeFilter } from '../types'
import { PROTOCOL_FILTER_OPTIONS, type ProtocolType } from '../utils/protocols'

const V2RAY_CONNECTION_OPTIONS = [
  ['vmess', 'VMess'],
  ['vmess-tls', 'VMess+TLS'],
  ['vless-tls', 'VLess+TLS'],
  ['vless-none', 'VLess+none ⚠'],
  ['unknown', 'Unknown'],
] as const

/**
 * The six booleans that used to sit on their own row under the bar. Five are flags on
 * the node record (`isActive`, `isHealthy`, …); Bookmarked is the user's own mark,
 * which is why it hangs below a rule rather than in the list with them.
 */
const STATUS_OPTIONS = [
  ['activeOnly', 'Active'],
  ['healthyOnly', 'Healthy'],
  ['residentialOnly', 'Residential'],
  ['whitelistedOnly', 'Whitelisted'],
  ['hideDuplicates', 'Hide Dupes'],
] as const

interface Props {
  filter: NodeFilter
  updateFilter: (patch: Partial<NodeFilter>) => void
  countries: string[]
  cities: string[]
  totalCount: number
  filteredCount: number
  loading: boolean
  onRefresh: () => void
  batchProgress: { done: number; total: number } | null
  onTestBatch: () => void
  onCancelBatch: () => void
  /**
   * Which protocols the select offers. Defaults to all of them; the Multi-hop tab
   * narrows it to the two that can be chained.
   */
  protocolOptions?: readonly { value: ProtocolType; label: string }[]
}

export default function NodeFilters({
  filter,
  updateFilter,
  countries,
  cities,
  totalCount,
  filteredCount,
  loading,
  onRefresh,
  batchProgress,
  onTestBatch,
  onCancelBatch,
  protocolOptions = PROTOCOL_FILTER_OPTIONS,
}: Props) {
  const [connOpen, setConnOpen] = useState(false)
  const connRef = useRef<HTMLDivElement | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const statusRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!connOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (connRef.current && !connRef.current.contains(e.target as Node)) {
        setConnOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [connOpen])

  useEffect(() => {
    if (!statusOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [statusOpen])

  // Highlight the button + show a dot when the list is being narrowed by connection type.
  const connFiltered = Object.values(filter.v2rayConnection).some((v) => !v)
  // Same signal for the status button, against the DEFAULTS rather than against "all
  // off": three of these start ticked, so "any is on" would light the dot permanently
  // and say nothing. This says "you changed something in here", which is what a
  // collapsed control has to say for the user to trust it.
  const statusFiltered =
    STATUS_OPTIONS.some(([key]) => filter[key] !== DEFAULT_FILTER[key]) ||
    filter.bookmarkedOnly !== DEFAULT_FILTER.bookmarkedOnly

  return (
    <div className="border-b border-border bg-bg-secondary px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={filter.country}
          onChange={(e) => updateFilter({ country: e.target.value })}
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus min-w-[140px]"
        >
          <option value="">All Countries</option>
          {countries.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select
          value={filter.city}
          onChange={(e) => updateFilter({ city: e.target.value })}
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus min-w-[140px]"
        >
          <option value="">All Cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <input
          type="text"
          value={filter.search}
          onChange={(e) => updateFilter({ search: e.target.value })}
          placeholder="Search moniker..."
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus w-[180px]"
        />

        {/* Six checkboxes that used to be a second row under the bar. Collapsed to
            match the Connection control next to it: same button, same dot, same panel.
            They are the least-touched controls in the bar and were taking the most
            room. */}
        <div ref={statusRef} className="relative">
          <button
            onClick={() => setStatusOpen((o) => !o)}
            className={`flex items-center gap-1.5 border rounded-sm px-2.5 py-1.5 text-sm transition-colors ${
              statusFiltered
                ? 'border-accent text-accent'
                : 'bg-bg-tertiary border-border text-text-primary hover:border-border-focus'
            }`}
            title="Filter by node status and your bookmarks"
          >
            {statusFiltered && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
            Status
            <span className="text-text-tertiary text-[10px]">▾</span>
          </button>

          {statusOpen && (
            <div className="absolute left-0 top-full mt-1 z-20 w-44 bg-bg-secondary border border-border rounded-md shadow-overlay p-2 space-y-1">
              <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-text-tertiary select-none">
                Node status
              </div>
              {STATUS_OPTIONS.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 px-1 py-0.5 text-sm text-text-secondary cursor-pointer select-none rounded-sm hover:bg-bg-hover">
                  <input
                    type="checkbox"
                    checked={filter[key]}
                    onChange={(e) => updateFilter({ [key]: e.target.checked })}
                    className="accent-[var(--color-accent)]"
                  />
                  {label}
                </label>
              ))}
              <label className="flex items-center gap-2 px-1 py-0.5 mt-1 pt-2 border-t border-border text-sm text-text-secondary cursor-pointer select-none rounded-sm hover:bg-bg-hover">
                <input
                  type="checkbox"
                  checked={filter.bookmarkedOnly}
                  onChange={(e) => updateFilter({ bookmarkedOnly: e.target.checked })}
                  className="accent-[var(--color-accent)]"
                />
                Bookmarked
              </label>
            </div>
          )}
        </div>

        <select
          value={filter.type === 'all' ? 'all' : String(filter.type)}
          onChange={(e) => {
            const v = e.target.value
            updateFilter({ type: v === 'all' ? 'all' : (Number(v) as ProtocolType) })
          }}
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus min-w-[140px]"
        >
          <option value="all">All Protocols</option>
          {protocolOptions.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>

        {filter.type === 2 && (
          <div ref={connRef} className="relative">
            <button
              onClick={() => setConnOpen((o) => !o)}
              className={`flex items-center gap-1.5 border rounded-sm px-2.5 py-1.5 text-sm transition-colors ${
                connFiltered
                  ? 'border-accent text-accent'
                  : 'bg-bg-tertiary border-border text-text-primary hover:border-border-focus'
              }`}
              title="Filter V2Ray nodes by connection type"
            >
              {connFiltered && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
              Connection
              <span className="text-text-tertiary text-[10px]">▾</span>
            </button>

            {connOpen && (
              <div className="absolute left-0 top-full mt-1 z-20 w-44 bg-bg-secondary border border-border rounded-md shadow-overlay p-2 space-y-1">
                <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-text-tertiary select-none">
                  Connection types
                </div>
                {V2RAY_CONNECTION_OPTIONS.map(([cat, label]) => (
                  <label key={cat} className="flex items-center gap-2 px-1 py-0.5 text-sm text-text-secondary cursor-pointer select-none rounded-sm hover:bg-bg-hover">
                    <input
                      type="checkbox"
                      checked={filter.v2rayConnection[cat]}
                      onChange={(e) => updateFilter({ v2rayConnection: { ...filter.v2rayConnection, [cat]: e.target.checked } })}
                      className="accent-[var(--color-accent)]"
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        <span className="text-text-secondary text-sm">
          {filteredCount}/{totalCount}
        </span>

        {batchProgress ? (
          <button
            onClick={onCancelBatch}
            className="text-warning hover:text-danger text-sm transition-colors flex items-center gap-1"
          >
            Testing {batchProgress.done}/{batchProgress.total}... Cancel
          </button>
        ) : (
          <button
            onClick={onTestBatch}
            disabled={filteredCount === 0}
            className="text-text-secondary hover:text-accent text-sm transition-colors disabled:opacity-30"
          >
            Test Nodes ({filteredCount})
          </button>
        )}

        <button
          onClick={onRefresh}
          disabled={loading}
          className="text-text-secondary hover:text-accent text-sm transition-colors disabled:opacity-30 flex items-center gap-1"
        >
          {loading ? <><Spinner className="text-accent" /> Fetching</> : 'Refresh'}
        </button>
      </div>
    </div>
  )
}
