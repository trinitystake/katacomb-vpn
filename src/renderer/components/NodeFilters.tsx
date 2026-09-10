import { useEffect, useRef, useState, type ReactElement } from 'react'
import Spinner from './Spinner'
import type { NodeFilter } from '../types'
import { PROTOCOL_FILTER_OPTIONS, type ProtocolType } from '../utils/protocols'
import { formatTimeAgo } from '../utils/format'
import CountryFlag from './CountryFlag'
import {
  ActivityIcon,
  CloseIcon,
  HeartIcon,
  HomeIcon,
  LayersIcon,
  PowerIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  StarIcon,
} from './Icons'

const V2RAY_CONNECTION_OPTIONS = [
  ['vmess', 'VMess'],
  ['vmess-tls', 'VMess+TLS'],
  ['vless-tls', 'VLess+TLS'],
  ['vless-none', 'VLess+none ⚠'],
  ['unknown', 'Unknown'],
] as const

type IconComponent = (props: { className?: string }) => ReactElement
type StatusKey = 'activeOnly' | 'healthyOnly' | 'residentialOnly' | 'whitelistedOnly' | 'hideDuplicates'

/**
 * The five booleans on the node record, shown as toggle chips so their state is
 * visible at a glance and one click away. Bookmarked is the user's own mark rather
 * than the directory's, which is why it is rendered separately, last.
 */
const STATUS_OPTIONS: readonly [StatusKey, string, IconComponent][] = [
  ['activeOnly', 'Active', PowerIcon],
  ['healthyOnly', 'Healthy', HeartIcon],
  ['residentialOnly', 'Residential', HomeIcon],
  ['whitelistedOnly', 'Whitelisted', ShieldIcon],
  ['hideDuplicates', 'Hide duplicates', LayersIcon],
]

const SELECT_CLASS =
  'bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus w-[140px]'

const CHIP_ON = 'bg-accent-subtle border-accent text-accent'
const CHIP_OFF = 'bg-bg-tertiary border-border text-text-secondary hover:border-border-focus hover:text-text-primary'

const GHOST_BUTTON_CLASS =
  'flex items-center gap-1.5 text-text-secondary hover:text-accent text-sm transition-colors disabled:opacity-30'

interface Props {
  filter: NodeFilter
  updateFilter: (patch: Partial<NodeFilter>) => void
  totalCount: number
  filteredCount: number
  loading: boolean
  /** When the directory was last read; null until the first successful fetch. */
  lastFetched: Date | null
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

// Same active-control vocabulary as the tab underline and the count pills: an accent
// outline on a subtle fill, never a filled accent (six filled chips would out-shout
// the table).
function Chip({
  on,
  label,
  Icon,
  onToggle,
}: {
  on: boolean
  label: string
  Icon: IconComponent
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`flex items-center gap-1.5 border rounded-full px-2.5 py-1 text-xs transition-colors select-none ${on ? CHIP_ON : CHIP_OFF}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  )
}

export default function NodeFilters({
  filter,
  updateFilter,
  totalCount,
  filteredCount,
  loading,
  lastFetched,
  onRefresh,
  batchProgress,
  onTestBatch,
  onCancelBatch,
  protocolOptions = PROTOCOL_FILTER_OPTIONS,
}: Props) {
  const [connOpen, setConnOpen] = useState(false)
  const connRef = useRef<HTMLDivElement | null>(null)

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

  // Highlight the button + show a dot when the list is being narrowed by connection type.
  const connFiltered = Object.values(filter.v2rayConnection).some((v) => !v)

  return (
    /* One row that wraps. Search, the protocol select and the chips stay on the first
       line; the count and the two actions drop to a second line below ~1440px. There is
       no Country or City select: the search box covers typing a place and the Map tab
       covers browsing one, and a country picked on the Map arrives as the chip below. */
    <div className="border-b border-border bg-bg-secondary px-4 py-3">
      <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
        <div className="relative">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          <input
            type="text"
            value={filter.search}
            onChange={(e) => updateFilter({ search: e.target.value })}
            placeholder="Search moniker, address, location"
            className="bg-bg-tertiary border border-border text-text-primary text-sm pl-8 pr-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus w-[250px] placeholder:text-text-tertiary"
          />
        </div>

        <select
          value={filter.type === 'all' ? 'all' : String(filter.type)}
          onChange={(e) => {
            const v = e.target.value
            updateFilter({ type: v === 'all' ? 'all' : (Number(v) as ProtocolType) })
          }}
          className={SELECT_CLASS}
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

        {STATUS_OPTIONS.map(([key, label, Icon]) => (
          <Chip
            key={key}
            on={filter[key]}
            label={label}
            Icon={Icon}
            onToggle={() => updateFilter({ [key]: !filter[key] })}
          />
        ))}
        <Chip
          on={filter.bookmarkedOnly}
          label="Bookmarked"
          Icon={StarIcon}
          onToggle={() => updateFilter({ bookmarkedOnly: !filter.bookmarkedOnly })}
        />

        {/* The country the Map tab handed over. Always "on" while present; the only
            action is to dismiss it. */}
        {filter.country && (
          <button
            type="button"
            onClick={() => updateFilter({ country: '' })}
            title={`Only ${filter.country}. Click to show every country again.`}
            className={`flex items-center gap-1.5 border rounded-full pl-2.5 pr-2 py-1 text-xs transition-colors select-none ${CHIP_ON}`}
          >
            <CountryFlag country={filter.country} />
            {filter.country}
            <CloseIcon className="w-3 h-3" />
          </button>
        )}

        {/* One group with ml-auto rather than a flex-1 spacer: a zero-basis spacer
            never wraps, so below ~1440px the count and actions dropped to a second line
            on the LEFT. A grouped item wraps as a unit and keeps its right alignment. */}
        <div className="ml-auto flex items-center gap-3">
          {/* No ticker behind "Updated": the tab re-renders on the 15s status poll and
              every 60s feed push, which is enough for a label whose only job is to age
              visibly when refreshes stop succeeding. */}
          <span className="text-text-secondary text-xs">
            {filteredCount.toLocaleString('en')} of {totalCount.toLocaleString('en')} nodes
            {lastFetched && (
              <span className="text-text-tertiary"> · Updated {formatTimeAgo(lastFetched.getTime())}</span>
            )}
          </span>

          {batchProgress ? (
            <button
              onClick={onCancelBatch}
              className="text-warning hover:text-danger text-sm transition-colors flex items-center gap-1.5"
            >
              <Spinner />
              Testing {batchProgress.done}/{batchProgress.total}, click to cancel
            </button>
          ) : (
            <button
              onClick={onTestBatch}
              disabled={filteredCount === 0}
              className={GHOST_BUTTON_CLASS}
              title={`Probe the ${filteredCount.toLocaleString('en')} listed nodes for latency`}
            >
              <ActivityIcon className="w-3.5 h-3.5" />
              Test nodes
            </button>
          )}

          <button
            onClick={onRefresh}
            disabled={loading}
            className={GHOST_BUTTON_CLASS}
            title="Fetch the node directory again"
          >
            {loading ? <Spinner className="text-accent" /> : <RefreshIcon className="w-3.5 h-3.5" />}
            {loading ? 'Fetching' : 'Refresh'}
          </button>
        </div>
      </div>
    </div>
  )
}
