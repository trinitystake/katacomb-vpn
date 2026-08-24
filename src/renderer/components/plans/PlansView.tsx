import { useEffect, useState } from 'react'
import { usePlansContext } from '../../contexts/PlansContext'
import { useNavigation } from '../../contexts/NavigationContext'
import { useConnection } from '../../hooks/useConnection'
import { formatTimeAgo } from '../../utils/format'
import MyPlansPanel from './MyPlansPanel'
import PlanCatalog from './PlanCatalog'
import Spinner from '../Spinner'

type Section = 'mine' | 'catalog'

/**
 * The Plans tab: My plans (the wallet's subscriptions, one-click connect) and
 * the Catalog (browse and subscribe). State lives in PlansContext above the
 * tab, so switching tabs no longer resets it.
 */
export default function PlansView() {
  const { overview, discovering, progress, discoverError, discover } = usePlansContext()
  const { plansNodeFilter } = useNavigation()
  const { status } = useConnection()
  // Rescan needs the chain, which our own tunnel makes unreachable (proxy mode
  // leaves routing alone, so it still works there).
  const chainFrozen = (status.state === 'connected' || status.state === 'reconnecting') && !status.proxyMode
  const [section, setSection] = useState<Section>(
    overview.subscriptions.length > 0 ? 'mine' : 'catalog',
  )

  // Arriving from a node's "See Plans tab" targets the catalog.
  useEffect(() => {
    if (plansNodeFilter) setSection('catalog')
  }, [plansNodeFilter])

  const staleness = overview.fetchedAt
    ? `Catalog updated ${formatTimeAgo(overview.fetchedAt)}`
    : 'Catalog not loaded yet'
  const catalogOld = overview.fetchedAt !== null && Date.now() - overview.fetchedAt > 3600_000

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0">
        {/* Section switch */}
        <div className="flex bg-bg-tertiary border border-border rounded-md p-0.5">
          {(['mine', 'catalog'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-3 py-1 text-sm rounded-[4px] transition-colors ${
                section === s
                  ? 'bg-bg-secondary text-accent font-medium'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {s === 'mine' ? `My plans${overview.subscriptions.length > 0 ? ` (${overview.subscriptions.length})` : ''}` : 'Catalog'}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 text-xs">
          {overview.stale && (
            <span className="text-warning">Cached data, chain unreachable while connected</span>
          )}
          <span className="flex items-center gap-1.5 text-text-tertiary" title={staleness}>
            <span className={`status-dot ${catalogOld ? 'status-dot-pending' : 'status-dot-active'}`} />
            {staleness}
          </span>
          <button
            onClick={() => void discover()}
            disabled={discovering || chainFrozen}
            title={chainFrozen ? 'The chain is not reachable while the VPN is connected' : 'Rescan the plan catalog from the chain'}
            className="btn btn-secondary text-xs px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {discovering ? <Spinner /> : 'Rescan'}
          </button>
        </div>
      </div>

      {discovering && progress && (
        <div className="px-5 py-2 border-b border-border text-xs text-text-secondary flex items-center gap-3 shrink-0">
          <Spinner className="text-accent" />
          {progress.phase === 'connecting'
            ? 'Connecting to the chain...'
            : progress.phase === 'nodes'
              ? `Checking node availability: ${progress.done} of ${progress.total}`
              : `Scanning plans: ${progress.done}${progress.phase === 'done' ? ' loaded' : ''}`}
          {(progress.phase === 'fetching' || progress.phase === 'nodes') && progress.done > 0 && (
            <div className="flex-1 h-1 bg-bg-tertiary rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, (progress.done / Math.max(progress.total, progress.done)) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {discoverError && !discovering && (
        <div className="mx-5 mt-3 bg-danger-subtle border border-danger px-3 py-2 rounded-md text-sm text-danger flex items-center gap-3 shrink-0">
          <span className="flex-1">{discoverError}</span>
          <button onClick={() => void discover()} className="btn btn-danger text-xs px-2 py-0.5">
            Retry
          </button>
        </div>
      )}

      {section === 'mine' ? (
        <MyPlansPanel onBrowse={() => setSection('catalog')} />
      ) : (
        <PlanCatalog />
      )}
    </div>
  )
}
