// Builds the wg(8) INI for a plain WireGuard session, replacing the SDK's
// `Wireguard` class (parseConfig + buildConfigString).
//
// Why replace it: the class is a connection manager, not a builder. Constructing
// one pulls in child_process, qrcode and find-free-ports; parseConfig awaited a
// free-port lookup for a ListenPort that buildConfigString does not even emit.
// This is the same shape as amneziawg-config.ts, xray-config.ts,
// hysteria-config.ts and openvpn-config.ts: pure, unit-tested, no imports.
//
// Output is byte-identical to the SDK's buildConfigString() — pinned by
// wireguard-config.test.ts, which diffs the two for real handshake shapes. The
// wire behaviour of an existing session must not change under this swap.

export interface WireguardHandshakeMetadata {
  port: number | string
  public_key: string
}

export interface WireguardHandshakeData {
  addrs: string[]
  metadata: WireguardHandshakeMetadata[]
}

/**
 * The resolver list written into the config when the caller names none.
 *
 * This is the SDK's hardcoded default, NOT something the node pushes — worth
 * stating because it reads like node-supplied data and is not. `10.8.0.1` is the
 * in-tunnel gateway, i.e. the node's own resolver, which is the entry that can
 * cost ~10s per uncached lookup when it does not answer (see the node-DNS
 * invariant in CLAUDE.md). `replaceDnsLines` is what swaps this list out when the
 * user has chosen a resolver.
 */
export const DEFAULT_WIREGUARD_DNS = ['10.8.0.1', '1.0.0.1', '1.1.1.1']

/**
 * Build the config string for a WireGuard session.
 *
 * `nodeAddrs[0]` is the endpoint host and `handshake.addrs` the tunnel addresses
 * the node assigned. Throws rather than emitting a half-built config: a node is
 * an adversary in this threat model and an empty endpoint or missing peer key
 * would otherwise reach wg-quick as a syntactically valid file.
 */
export function buildWireguardConfig(
  handshake: WireguardHandshakeData,
  nodeAddrs: string[],
  privateKey: string,
  dns: string[] = DEFAULT_WIREGUARD_DNS,
): string {
  const meta = handshake.metadata?.[0]
  if (!meta) throw new Error('WireGuard handshake returned no metadata')
  if (!meta.public_key) throw new Error('WireGuard handshake returned no peer public key')
  const host = nodeAddrs?.[0]
  if (!host) throw new Error('WireGuard handshake returned no node address')
  if (!privateKey) throw new Error('WireGuard config needs a private key')

  // Field order, spacing and the comma joins match the SDK exactly; config-guard
  // and the Go-side guard both parse this, and the corpus pins their agreement.
  let config = '[Interface]\n'
  config += 'Address = ' + (handshake.addrs ?? []).join(',') + '\n'
  config += 'PrivateKey = ' + privateKey + '\n'
  config += 'DNS = ' + dns.join(',') + '\n'
  config += '\n[Peer]\n'
  config += 'PublicKey = ' + meta.public_key + '\n'
  config += 'AllowedIPs = ' + ['0.0.0.0/0', '::/0'].join(',') + '\n'
  config += 'Endpoint = ' + host + ':' + meta.port + '\n'
  config += 'PersistentKeepalive = 15\n'
  return config
}
