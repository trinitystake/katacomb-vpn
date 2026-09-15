// Contract between the user-space app (daemon-client.ts) and the root daemon,
// which is the Go helper in `daemon` mode (daemon/internal/protocol mirrors these
// shapes byte for byte). Pure constants/types — no Node or Electron imports.

export const DAEMON_DIR = '/run/katacomb-vpn'
export const DAEMON_SOCKET_PATH = `${DAEMON_DIR}/daemon.sock`

// Bump only on a breaking protocol change. `protocol_version` is asked once per
// daemon connection attempt (daemon-client's cached probe) so an upgraded app
// can name a stale daemon before it sends it an op it cannot serve; the older
// `unknown op` string match in vpn-manager stays as the fallback for a daemon
// too old to answer this op at all.
export const DAEMON_PROTOCOL_VERSION = 1

// The op list as a VALUE, not just a union: both this file and the Go side are
// pinned to daemon/internal/protocol/testdata/corpus/protocol.json, and a union
// type cannot be enumerated at runtime to check against it. Adding an op here
// without a Go dispatch case (or vice versa) fails both suites.
export const DAEMON_OPS = [
  'protocol_version',
  'status',
  'xfrm_policies',
  'wireguard_up',
  'wireguard_down',
  'amneziawg_up',
  'amneziawg_down',
  'openvpn_up',
  'openvpn_down',
  'tun_up',
  'tun_down',
  'killswitch_on',
  'killswitch_off',
  'dns_set',
  'dns_restore',
] as const

export type DaemonOp = (typeof DAEMON_OPS)[number]

export interface DaemonRequest {
  id: number
  op: DaemonOp
  args?: Record<string, unknown>
}

export interface DaemonResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}
