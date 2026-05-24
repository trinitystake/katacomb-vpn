import { useMemo, useState } from 'react'
import { COUNTRY_CODES } from '../utils/country-codes'

interface Props {
  counts: Map<string, number>
  onSelect: (country: string) => void
}

type SortMode = 'name' | 'count'

export default function CountrySidebar({ counts, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('name')

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = Array.from(counts.entries())
      .filter(([country, count]) => count > 0 && (!q || country.toLowerCase().includes(q)))
    if (sort === 'count') {
      // Descending by count, alphabetical tiebreaker
      all.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    } else {
      all.sort((a, b) => a[0].localeCompare(b[0]))
    }
    return all
  }, [counts, query, sort])

  return (
    <aside className="w-[280px] shrink-0 h-full flex flex-col border-r border-border bg-bg-secondary">
      <div className="p-3 border-b border-border shrink-0 space-y-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search country..."
          className="w-full bg-bg-tertiary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
        />
        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-tertiary">Sort by</span>
          <div className="flex items-center gap-0.5 border border-border rounded-sm overflow-hidden">
            {(['name', 'count'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setSort(m)}
                className={`px-2 py-0.5 transition-colors ${
                  sort === m
                    ? 'bg-accent-subtle text-accent'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {m === 'name' ? 'Name' : 'Count'}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.map(([country, count]) => {
          const code = COUNTRY_CODES[country]
          return (
            <button
              key={country}
              onClick={() => onSelect(country)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left border-b border-border hover:bg-bg-hover transition-colors"
            >
              {code ? (
                <span className={`fi fi-${code} shrink-0`} style={{ width: 20, height: 15 }} />
              ) : (
                <span className="shrink-0 inline-block" style={{ width: 20, height: 15 }} />
              )}
              <span className="flex-1 text-sm text-text-primary truncate">{country}</span>
              <span className="text-text-secondary text-xs font-mono">{count}</span>
            </button>
          )
        })}
        {rows.length === 0 && (
          <div className="px-3 py-4 text-text-tertiary text-sm">No matching countries.</div>
        )}
      </div>
    </aside>
  )
}
