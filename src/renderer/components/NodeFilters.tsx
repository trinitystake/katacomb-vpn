import Spinner from './Spinner'
import type { NodeFilter } from '../types'

interface Props {
  filter: NodeFilter
  updateFilter: (patch: Partial<NodeFilter>) => void
  countries: string[]
  cities: string[]
  totalCount: number
  filteredCount: number
  lastFetched: Date | null
  loading: boolean
  onRefresh: () => void
  batchProgress: { done: number; total: number } | null
  onTestBatch: () => void
  onCancelBatch: () => void
}

export default function NodeFilters({
  filter,
  updateFilter,
  countries,
  cities,
  totalCount,
  filteredCount,
  lastFetched,
  loading,
  onRefresh,
  batchProgress,
  onTestBatch,
  onCancelBatch,
}: Props) {
  return (
    <div className="border-b border-border bg-bg-secondary px-4 py-3 space-y-3">
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

        <div className="flex items-center gap-0.5 border border-border rounded-sm overflow-hidden">
          {(['all', 'wireguard', 'v2ray'] as const).map((t) => (
            <button
              key={t}
              onClick={() => updateFilter({ type: t })}
              className={`px-2.5 py-1.5 text-sm transition-colors ${
                filter.type === t
                  ? 'bg-accent-subtle text-accent'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t === 'all' ? 'All' : t === 'wireguard' ? 'WG' : 'V2Ray'}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={filter.search}
          onChange={(e) => updateFilter({ search: e.target.value })}
          placeholder="Search moniker..."
          className="bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus w-[180px]"
        />

        <div className="flex-1" />

        <span className="text-text-secondary text-sm">
          {filteredCount}/{totalCount}
        </span>

        {lastFetched && (
          <span className="text-text-tertiary text-xs">
            {lastFetched.toLocaleTimeString()}
          </span>
        )}

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

      <div className="flex items-center gap-4 flex-wrap">
        {([
          ['activeOnly', 'Active'],
          ['healthyOnly', 'Healthy'],
          ['residentialOnly', 'Residential'],
          ['whitelistedOnly', 'Whitelisted'],
          ['hideDuplicates', 'Hide Dupes'],
          ['bookmarkedOnly', 'Bookmarked'],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5 text-sm text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filter[key]}
              onChange={(e) => updateFilter({ [key]: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  )
}
