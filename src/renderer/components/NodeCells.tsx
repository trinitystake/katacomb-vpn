import type { MouseEvent } from 'react'
import type { SentNode, NodeProbeResult } from '../types'
import CopyButton from './CopyButton'
import ProtocolIcon from './ProtocolIcon'
import { ActivityIcon, HomeIcon, LayersIcon, ShieldIcon } from './Icons'
import { protocolMeta } from '../utils/protocols'
import { v2rayConnectionBadge, isCleartextConnection } from '../utils/v2ray-connection'
import { nodeStatusMeta, type NodeState } from '../utils/node-status'

/**
 * The cells the Nodes and Multi-hop tables share, so the two tables cannot drift:
 * each carries a rule (the directory-claim tooltips, whitelisted-is-never-green, the
 * cleartext-red V2Ray badge, the four latency states, the status pill) that must read
 * identically in both. Plain markup with no rule (the Location cell) stays inline in
 * each table.
 *
 * Widths are declared once here and used by both the header buttons and the cells.
 * Every fixed cell is `shrink-0`; the identity cell is the one flexible column. Both
 * tables are virtualized with a FIXED 48px row (`estimateSize: () => 48`), so a
 * two-line cell is text-sm over text-[10px]/[11px] with `leading-tight` and nothing
 * taller: a third line would be clipped silently.
 */
export const NODE_COL = {
  bookmark: 'w-[28px]',
  identity: 'flex-1 min-w-[180px]',
  location: 'w-[132px]',
  type: 'w-[110px]',
  price: 'w-[96px]',
  leases: 'w-[60px]',
  sessions: 'w-[72px]',
  peers: 'w-[60px]',
  latency: 'w-[72px]',
  status: 'w-[80px]',
} as const

export const ROW_HEIGHT = 48

/** Probe results older than this are shown dimmed rather than removed. */
export const PROBE_CACHE_TTL = 10 * 60 * 1000

function formatPrice(prices: { denom: string; value: string }[] | null | undefined): string {
  if (!prices) return '—'
  const p = prices.find((x) => x.denom === 'udvpn')
  if (!p) return '—'
  const val = parseInt(p.value, 10) / 1e6
  if (val >= 1000) return val.toLocaleString('en', { maximumFractionDigits: 0 })
  return val.toLocaleString('en', { maximumFractionDigits: 2 })
}

/**
 * Moniker over address. The moniker is a real button and the row's keyboard target:
 * the row itself must stay a div, because it also contains the bookmark, copy and
 * latency buttons and a button may not nest interactive content. The trust icons are
 * inert spans, so a click on them still reaches the row.
 */
export function NodeIdentityCell({ node, onActivate }: { node: SentNode; onActivate: () => void }) {
  return (
    <div className={`${NODE_COL.identity} pr-3 leading-tight`}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e: MouseEvent) => { e.stopPropagation(); onActivate() }}
          className="truncate text-left font-medium text-text-primary hover:text-accent transition-colors"
        >
          {node.moniker || '—'}
        </button>
        {node.isResidential && (
          <span className="shrink-0 text-info" title="Residential: the node directory places this address in a consumer ISP range. That is the directory's own label, not a check this app performs.">
            <HomeIcon className="w-3.5 h-3.5" />
          </span>
        )}
        {/* Deliberately neutral, never green. Node operators are adversaries in this
            app's threat model and there is nothing on chain to verify against, so a
            "safe" colour here would be an assurance the directory cannot give. */}
        {node.isWhitelisted && (
          <span className="shrink-0 text-text-secondary" title="Whitelisted: the node directory lists this node on its own whitelist. That is the directory's own label, not a check this app performs.">
            <ShieldIcon className="w-3.5 h-3.5" />
          </span>
        )}
        {node.isDuplicate && (
          <span className="shrink-0 text-warning" title="Duplicate: the node directory lists another node with the same identity. Hide duplicates in the filter bar removes these.">
            <LayersIcon className="w-3.5 h-3.5" />
          </span>
        )}
      </div>
      {/* The full address, ellipsized by the column rather than by hand: wide windows
          show all of it, and the copy button carries the full string regardless. */}
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-tertiary">
        <span className="truncate" title={node.address}>{node.address}</span>
        <CopyButton value={node.address} label="Copy address" />
      </div>
    </div>
  )
}

/**
 * Protocol mark + short name over version (+ the V2Ray transport badge, red when it
 * is cleartext). The mark is neutral on purpose: protocolMeta().color borrows the
 * status hues, and the Status pill in the same row uses them for a different meaning.
 */
export function TypeCell({ node }: { node: SentNode }) {
  const badge = node.type === 2 ? (v2rayConnectionBadge(node.connection) ?? 'unknown') : null
  const cleartext = node.type === 2 && isCleartextConnection(node.connection)
  // node.version is normalized to '' (never null) in node-normalize; an empty line 2
  // still renders as a non-breaking space so every Type cell is two lines tall.
  const line2 = [node.version, badge].filter(Boolean).join(' · ')
  return (
    <div className={`${NODE_COL.type} shrink-0 leading-tight`}>
      <span className="flex items-center gap-1.5">
        <ProtocolIcon type={node.type} className="w-4 h-4 shrink-0 text-text-secondary" />
        <span className="truncate text-text-primary">{protocolMeta(node.type).short}</span>
      </span>
      <span
        className={`block text-[10px] truncate ${cleartext ? 'text-danger' : 'text-text-tertiary'}`}
        title={badge ? 'V2Ray protocol/security advertised by the node (unverified until you connect)' : undefined}
      >
        {line2 || '\u00a0'}
      </span>
    </div>
  )
}

/** Hourly over per-gigabyte, in P2P, right-aligned so the digits line up down the column. */
export function PriceCell({ node }: { node: SentNode }) {
  return (
    <div className={`${NODE_COL.price} shrink-0 text-right font-mono text-xs leading-tight`} title="Price in P2P">
      <div>
        <span className="text-text-primary">{formatPrice(node.hourlyPrices)}</span>
        <span className="text-text-tertiary text-[10px]"> /hr</span>
      </div>
      <div>
        <span className="text-text-primary">{formatPrice(node.gigabytePrices)}</span>
        <span className="text-text-tertiary text-[10px]"> /GB</span>
      </div>
    </div>
  )
}

/**
 * The latency probe button. Four states: untested (an activity mark, so it reads as
 * an action), testing, a reachable result in milliseconds, or Fail; a result older
 * than PROBE_CACHE_TTL is dimmed, not removed.
 */
export function LatencyCell({
  probe,
  testing,
  onTest,
}: {
  probe: NodeProbeResult | undefined
  testing: boolean
  onTest: () => void
}) {
  let content
  if (testing) {
    content = <span className="text-text-tertiary">...</span>
  } else if (!probe) {
    content = <ActivityIcon className="w-4 h-4 text-text-secondary group-hover:text-accent transition-colors" />
  } else {
    const stale = Date.now() - probe.timestamp > PROBE_CACHE_TTL
    if (probe.reachable && probe.latencyMs !== null) {
      content = <span className={stale ? 'text-text-tertiary' : 'text-success'}>{probe.latencyMs} ms</span>
    } else {
      content = <span className={stale ? 'text-text-tertiary' : 'text-danger'}>Fail</span>
    }
  }
  return (
    <button
      type="button"
      onClick={(e: MouseEvent) => { e.stopPropagation(); onTest() }}
      disabled={testing}
      className={`${NODE_COL.latency} group shrink-0 flex items-center justify-center font-mono text-xs transition-colors hover:text-accent disabled:pointer-events-none`}
      title="Test node latency"
    >
      {content}
    </button>
  )
}

// Full literal class strings, never assembled from a variable: Tailwind only emits
// classes it can see in the source.
const PILL_CLASS: Record<NodeState, string> = {
  active: 'bg-success-subtle text-success',
  unhealthy: 'bg-warning-subtle text-warning',
  inactive: 'bg-bg-tertiary text-text-tertiary',
}

/**
 * Status as a labelled pill. `connected` is this app's own tunnel, which outranks the
 * directory's two booleans for the one row it applies to.
 */
export function StatusCell({ node, connected = false }: { node: SentNode; connected?: boolean }) {
  const meta = nodeStatusMeta(node)
  return (
    <div className={`${NODE_COL.status} shrink-0 flex justify-center`}>
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] leading-none whitespace-nowrap ${
          connected ? PILL_CLASS.active : PILL_CLASS[meta.state]
        }`}
        title={`${meta.label}: ${meta.detail}`}
      >
        <span className={`status-dot ${connected ? 'status-dot-active' : meta.dotClass}`} />
        {connected ? 'Connected' : meta.label}
      </span>
    </div>
  )
}
