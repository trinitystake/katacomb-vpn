import type { ChainEligibility, SentNode } from '../types'

/**
 * The rules that decide which nodes a two-hop chain may be built from, kept apart
 * from the page that renders them so the one that costs money is a test rather than
 * a comment.
 */

export type ChainRole = 'entry' | 'exit'
export type BillingType = 'gigabytes' | 'hours'

/**
 * Only v2ray/xray can be chained at all: the exit is dialled through the entry with
 * `proxySettings.tag`, a v2ray-core feature no other protocol in this client has an
 * equivalent for.
 */
export const CHAINABLE_TYPES = [2, 4]

export function isChainable(node: SentNode): boolean {
  return CHAINABLE_TYPES.includes(node.type) && node.isActive && node.isHealthy
}

/**
 * Only v9.0.0 nodes publish the inbound listing the chain checks read, so anything
 * older cannot be graded before paying. 485 of the 487 measured report no TLS at all,
 * so picking one is a near-certain double refund rather than a gamble worth offering.
 * They stay LISTED, so the table explains itself instead of silently hiding most of
 * the network.
 */
export function majorVersion(node: SentNode): number {
  return parseInt((node.version || '').split('.')[0], 10) || 0
}

/** Whether this node can be graded at all, i.e. whether probing it can tell us anything. */
export function isCheckable(node: SentNode): boolean {
  return majorVersion(node) >= 9
}

export function udvpnPrice(node: SentNode, type: BillingType): number | null {
  const prices = type === 'gigabytes' ? node.gigabytePrices : node.hourlyPrices
  const p = prices?.find((x) => x.denom === 'udvpn')
  if (!p) return null
  const value = parseInt(p.value, 10)
  return Number.isFinite(value) ? value : null
}

export interface ChainRowState {
  /**
   * Whether this row may be picked for `role`. True ONLY on positive evidence: a
   * node that has not answered the check yet, one that could not be reached, and one
   * too old to publish anything to check are all false. Under the chain's TLS rule an
   * unverifiable node is not a maybe, it is a near-certain refund, and leaving those
   * clickable cost a real pair of sessions whose refund then failed.
   */
  selectable: boolean
  /** The short text in the eligibility column. */
  badge: string
  tone: 'success' | 'warning' | 'danger' | 'muted'
  /** The full explanation, for the row's `title`. */
  title: string
}

export function chainRowState(
  node: SentNode,
  grade: ChainEligibility | undefined,
  role: ChainRole,
): ChainRowState {
  if (!isCheckable(node)) {
    // Never probed, so say what is actually known: its version. "unknown" made a
    // knowable fact look like a failure.
    return {
      selectable: false,
      badge: `v${node.version || '8.x'}`,
      tone: 'muted',
      title: `This node runs ${node.version || 'a pre-9.0.0 version'}, which does not publish its inbound list, so it cannot be checked before you pay. Almost none of them offer TLS, so this will very likely be refused at the handshake and refunded.`,
    }
  }

  if (grade === undefined) {
    return {
      selectable: false,
      badge: 'checking…',
      tone: 'muted',
      title: 'Asking this node which inbounds it serves.',
    }
  }

  if (!grade.reachable) {
    return {
      selectable: false,
      badge: 'unknown',
      tone: 'warning',
      title: grade.error ?? 'No inbound listing',
    }
  }

  const ok = role === 'exit' ? grade.exit : grade.entry
  const security = role === 'exit' ? grade.exitSecurity : grade.entrySecurity
  const served = grade.transports.join(', ')

  if (ok) {
    const wrapping = security === 'reality' ? 'Reality' : 'TLS'
    return {
      selectable: true,
      badge: `${role === 'exit' ? 'TCP + ' : ''}${wrapping}`,
      tone: 'success',
      title: `Serves ${served}. This hop would be wrapped in ${wrapping}.`,
    }
  }

  return {
    selectable: false,
    badge: role === 'exit' ? 'no TLS/TCP' : 'no TLS',
    tone: 'danger',
    title: role === 'exit'
      ? `Serves ${served || 'nothing usable'}. A chain exit needs a plain-TCP inbound wrapped in TLS or Reality.`
      : `Serves ${served || 'nothing usable'}, but none of it is wrapped in TLS or Reality. Still fine for an ordinary single-hop connection.`,
  }
}

/**
 * Sort rank for the eligibility column: most useful to this hop first.
 *
 * Ascending is "best first", so a plain ascending sort puts every node you can
 * actually pick at the top. The two that are merely unproven sit above the two that
 * are known to fail, and pre-9.0.0 sorts last because it is the one that cannot be
 * checked at any price.
 *
 * Rank 0 is exactly `chainRowState().selectable`, and the test holds the two together.
 */
export function chainRowRank(
  node: SentNode,
  grade: ChainEligibility | undefined,
  role: ChainRole,
): number {
  if (!isCheckable(node)) return 4
  if (grade === undefined) return 1
  if (!grade.reachable) return 2
  return (role === 'exit' ? grade.exit : grade.entry) ? 0 : 3
}

/** Whether `grade` confirms this node can serve `role`. Drives "Verified only". */
export function isVerifiedFor(grade: ChainEligibility | undefined, role: ChainRole): boolean {
  if (!grade?.reachable) return false
  return role === 'exit' ? grade.exit : grade.entry
}
