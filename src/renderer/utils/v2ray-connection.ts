// Pure helpers for the node-list V2Ray connection badge.
//
// These derive a display badge + a cleartext flag from the node-list API's
// `connection` claim ({proxy, transport, security} strings). This is the
// COSMETIC, pre-connect counterpart to the security-critical numeric classifier
// in src/main/config-guard.ts (classifyV2RayInbound / v2raySecurityBadge), which
// runs on the SDK's post-handshake metadata. The two are deliberately separate:
// this one consumes UNTRUSTED API strings in the renderer and only hints the UI;
// config-guard consumes verified SDK enums in the main process and enforces. Keep
// the badge strings and the vless+none rule in sync between the two.

export interface NodeConnection {
  proxy: string
  transport: string
  security: string
}

/**
 * Narrow the untrusted/loosely-typed API value to a NodeConnection. Returns
 * false for null, primitives, `{}`, and odd shapes like `{proto:'udp'}` seen on
 * the stray type-0/3 nodes.
 */
export function isNodeConnection(conn: unknown): conn is NodeConnection {
  if (!conn || typeof conn !== 'object') return false
  const c = conn as Record<string, unknown>
  return typeof c.proxy === 'string' && typeof c.transport === 'string' && typeof c.security === 'string'
}

/**
 * Single source of truth for classifying a connection claim. Combos:
 * vmess→vmess(+tls), vless→vless-tls or vless-none (cleartext). null/odd→unknown.
 * The badge and cleartext flag below both derive from this so they can't drift,
 * and it's the key the node-list connection sub-filter toggles on.
 */
export type V2RayCategory = 'vmess' | 'vmess-tls' | 'vless-tls' | 'vless-none' | 'unknown'

export function v2rayConnectionCategory(conn: unknown): V2RayCategory {
  if (!isNodeConnection(conn)) return 'unknown'
  const proxy = conn.proxy.toLowerCase()
  const tls = conn.security.toLowerCase() === 'tls'
  if (proxy === 'vmess') return tls ? 'vmess-tls' : 'vmess'
  // VLess has no cipher of its own — without TLS the proxy hop is cleartext.
  return tls ? 'vless-tls' : 'vless-none'
}

// Compact node-list badge per category. 'unknown' has no badge (caller renders
// "unknown"). Strings match config-guard's v2raySecurityBadge output.
const CATEGORY_BADGE: Record<V2RayCategory, string | null> = {
  vmess: 'VMess',
  'vmess-tls': 'VMess+TLS',
  'vless-tls': 'VLess+TLS',
  'vless-none': 'VLess ⚠',
  unknown: null,
}

/**
 * True only for the known-bad VLess-none combo. null/unknown/odd shapes are NOT
 * flagged (we never whitelist). Mirrors config-guard's numeric rule.
 */
export function isCleartextConnection(conn: unknown): boolean {
  return v2rayConnectionCategory(conn) === 'vless-none'
}

/**
 * Compact human badge for the node list, e.g. "VMess", "VMess+TLS", "VLess+TLS",
 * or "VLess ⚠" for cleartext. Returns null when there is no usable connection
 * claim, so the caller can render "unknown".
 */
export function v2rayConnectionBadge(conn: unknown): string | null {
  return CATEGORY_BADGE[v2rayConnectionCategory(conn)]
}
