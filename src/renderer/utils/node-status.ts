import type { SentNode } from '../types'

/**
 * The node-list API reports two INDEPENDENT booleans, and they mean different
 * things:
 *
 * - `isActive`  — the node is registered and online on-chain.
 * - `isHealthy` — the aggregator's own probe managed to establish a real VPN
 *                 session with it. `errorMessage` says why it didn't.
 *
 * An active node that fails the session probe is the common case network-wide
 * ('VPN connect failed', 'Handshake failed', …), so `isActive && isHealthy`
 * must NOT be rendered as a single Active/Inactive label — that reports a live,
 * reachable node as "Inactive" and hides which check actually failed. Both
 * signals are also distinct from the Nodes tab's own latency probe, which only
 * does an HTTP GET against the node's API port (see node-tester.ts).
 */
export type NodeState = 'active' | 'unhealthy' | 'inactive'

type NodeStatusFields = Pick<SentNode, 'isActive' | 'isHealthy' | 'errorMessage'>

export interface NodeStatusMeta {
  state: NodeState
  label: string
  dotClass: string
  textClass: string
  /** One sentence naming which check failed — for a tooltip or a detail row. */
  detail: string
}

export function nodeStatusMeta(node: NodeStatusFields): NodeStatusMeta {
  if (!node.isActive) {
    return {
      state: 'inactive',
      label: 'Inactive',
      dotClass: 'status-dot-inactive',
      textClass: 'text-text-tertiary',
      // Every inactive node carries the redundant 'Inactive node' message, so
      // there is nothing to append here.
      detail: 'Not registered as active on-chain.',
    }
  }
  if (!node.isHealthy) {
    const reason = node.errorMessage?.trim()
    return {
      state: 'unhealthy',
      label: 'Unhealthy',
      dotClass: 'status-dot-warning',
      textClass: 'text-warning',
      detail: `Active on-chain, but the last network health check failed${reason ? `: ${reason}` : ''}.`,
    }
  }
  return {
    state: 'active',
    label: 'Active',
    dotClass: 'status-dot-active',
    textClass: 'text-success',
    detail: 'Active on-chain and passing the network health check.',
  }
}

/** Sort rank for the Status column: healthy first, then unhealthy, then inactive. */
export function nodeStatusRank(node: NodeStatusFields): number {
  if (!node.isActive) return 0
  return node.isHealthy ? 2 : 1
}

/**
 * Whether a connect may be attempted. Both aggregator checks must pass: a
 * session against an unhealthy node would most likely fail after the on-chain
 * payment (it is refunded, but it still costs a wait).
 */
export function isNodeConnectable(node: NodeStatusFields): boolean {
  return node.isActive && node.isHealthy
}
