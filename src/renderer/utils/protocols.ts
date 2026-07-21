// Single source of truth for the node VPN protocol axis.
//
// The node-list API (api.sentnodes.com/v2) tags each node with a numeric `type`.
// As of Sentinel node v9.0.0 six protocol types exist across the network (each
// node still runs exactly ONE — the aggregator `type` is its single service_type,
// verified against dvpnx's /info handler; "six protocols" means six node types,
// not six per node). This table replaces the `type === 1 ? … : …` ternaries that
// used to be duplicated across every component and assumed a two-protocol world.
//
// `supported` marks whether THIS client can actually establish a tunnel. WireGuard,
// V2Ray and XRAY are connectable; OpenVPN/AmneziaWG/Hysteria2 are identify/filter-only
// (each would need its own bundled binary + config-guard validator, and the root ones
// a privileged daemon op). The connect UI disables unsupported types; the main-process
// IPC guards (nodeType not in {1,2,4} → throw) are the actual enforcement.

export type ProtocolType = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface ProtocolMeta {
  label: string      // full name for modals/details: "WireGuard", "AmneziaWG"
  short: string      // compact node-table badge: "WG", "AWG", "HY2"
  color: string      // existing semantic token class, grouped by family
  supported: boolean // can this client tunnel it today?
}

// Colors reuse only existing semantic tokens (no new palette): info=teal
// WireGuard family, warning=amber proxy family, accent=blue, success=green.
const PROTOCOLS: Record<number, ProtocolMeta> = {
  0: { label: 'Unknown', short: '—', color: 'text-text-tertiary', supported: false },
  1: { label: 'WireGuard', short: 'WG', color: 'text-info', supported: true },
  2: { label: 'V2Ray', short: 'V2Ray', color: 'text-warning', supported: true },
  3: { label: 'OpenVPN', short: 'OpenVPN', color: 'text-accent', supported: false },
  4: { label: 'XRAY', short: 'XRAY', color: 'text-warning', supported: true },
  5: { label: 'AmneziaWG', short: 'AWG', color: 'text-info', supported: false },
  6: { label: 'Hysteria2', short: 'HY2', color: 'text-success', supported: false },
}

const UNKNOWN: ProtocolMeta = { label: 'Unknown', short: '?', color: 'text-text-tertiary', supported: false }

export function protocolMeta(type: number | undefined): ProtocolMeta {
  return (type !== undefined && PROTOCOLS[type]) || UNKNOWN
}

export function isProtocolSupported(type: number): boolean {
  return protocolMeta(type).supported
}

// Ordered options for the protocol filter dropdown (skips type 0 / unknown).
export const PROTOCOL_FILTER_OPTIONS: { value: ProtocolType; label: string }[] = [
  { value: 1, label: 'WireGuard' },
  { value: 2, label: 'V2Ray' },
  { value: 3, label: 'OpenVPN' },
  { value: 4, label: 'XRAY' },
  { value: 5, label: 'AmneziaWG' },
  { value: 6, label: 'Hysteria2' },
]
