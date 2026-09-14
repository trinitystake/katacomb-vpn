// Contract between the user-space app (daemon-client.ts) and the root daemon,
// which is the Go helper in `daemon` mode (daemon/internal/protocol mirrors these
// shapes byte for byte). Pure constants/types — no Node or Electron imports.

export const DAEMON_DIR = '/run/katacomb-vpn'
export const DAEMON_SOCKET_PATH = `${DAEMON_DIR}/daemon.sock`

// Bump only on a breaking protocol change. Nothing calls protocol_version today:
// an old daemon left running after an upgrade is detected by its `unknown op`
// reply to a newer op (vpn-manager matches that string), not by this number.
export const DAEMON_PROTOCOL_VERSION = 1

export type DaemonOp =
  | 'protocol_version'
  | 'status'
  | 'wireguard_up'
  | 'wireguard_down'
  | 'amneziawg_up'
  | 'amneziawg_down'
  | 'openvpn_up'
  | 'openvpn_down'
  | 'tun_up'
  | 'tun_down'
  | 'killswitch_on'
  | 'killswitch_off'
  | 'dns_set'
  | 'dns_restore'

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
