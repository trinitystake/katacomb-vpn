// Pure builder for a Hysteria2 CLIENT config from a dVPN node's handshake
// metadata. The bundled JS SDK (2.0.4) knows only WireGuard/V2Ray —
// it has no Hysteria2 class at all — so for hysteria2 nodes (node.type === 6) we
// build the client config ourselves from the node's handshake metadata.
//
// Unlike WireGuard/V2Ray (where the node hands us a whole config), a hysteria2 node
// returns only a few scalars, so we SYNTHESIZE the entire config here — a much
// smaller untrusted surface. The config-guard re-check (assertSafeHysteria2Config)
// still runs before spawn as the trust boundary.
//
// Field names + the client shape are taken verbatim from the Sentinel go-sdk
// (github.com/sentinel-official/sentinel-go-sdk, hysteria2/metadata.go +
// client.yaml.tmpl):
//   handshake request  = { uuid }          (same peer material as V2Ray/XRAY)
//   handshake response  = { metadata: [ { port, tls_pin, obfs_password } ] }
//   client config       = server / auth(=uuid) / tls{ insecure, pinSHA256 } / obfs
// The go-sdk's own client runs its config in TUN mode; we instead expose a loopback
// SOCKS5 listener and route it through tun2socks — the same path v2ray/xray use — so
// the only structural deviation from the reference is `socks5` (+ `lazy`) in place of
// the reference's `tun` block.
//
// SECURITY: hysteria2 nodes present self-signed certs, so the connection is only safe
// when the exact cert is pinned via tls.pinSHA256 (with insecure:true skipping CA
// validation). A node that advertises no pin can only be reached over an unpinned,
// MITM-able channel — the hysteria2 analogue of V2Ray's VLess-none cleartext case —
// so we refuse to build a config for it (selectHysteria2Entry returns null → throw →
// the caller refunds the session). The go-sdk client likewise refuses to run without
// a pin.
//
// Electron-free + unit-tested (native runner), like xray-config.ts / vpn-parse.ts.

export interface HysteriaMetadataEntry {
  port: string | number
  tls_pin?: string
  obfs_password?: string
}

const SOCKS_LISTEN = '127.0.0.1'
const SOCKS_PORT = 1080

/**
 * True if `pin` is a well-formed SHA-256 certificate fingerprint: 64 hex chars,
 * optionally colon-separated (the format hysteria2's pinSHA256 accepts and the
 * go-sdk emits). Mirrors the go-sdk's isValidTLSPin.
 */
export function isValidTlsPin(pin: string): boolean {
  const stripped = pin.replace(/:/g, '')
  return /^[0-9a-fA-F]{64}$/.test(stripped)
}

/**
 * Pick the metadata entry to build from: the first one carrying a well-formed
 * TLS pin. Returns null when none does — a hysteria2 node with no pin can only be
 * reached unpinned (MITM-able), so the caller throws rather than building an
 * unsafe tunnel (the analogue of the V2Ray VLess-none rejection).
 */
export function selectHysteria2Entry(
  metadata: HysteriaMetadataEntry[],
): HysteriaMetadataEntry | null {
  return metadata.find((m) => typeof m.tls_pin === 'string' && isValidTlsPin(m.tls_pin)) ?? null
}

/**
 * Build the full hysteria2 client config: a loopback SOCKS5 inbound (which
 * tun2socks dials) plus the server/auth/tls(+obfs) derived from the node's
 * handshake metadata. `lazy` binds the SOCKS listener immediately so tun2socks can
 * route before the QUIC connection is established (the connection is made on first
 * request). Throws if the node returned no metadata, no pinned entry, no address,
 * or an out-of-range port.
 */
export function buildHysteria2Config(
  metadata: HysteriaMetadataEntry[],
  nodeAddrs: string[],
  uuid: string,
): Record<string, unknown> {
  if (!Array.isArray(metadata) || metadata.length === 0) {
    throw new Error('Hysteria2 node returned no service metadata')
  }
  const entry = selectHysteria2Entry(metadata)
  if (!entry) {
    throw new Error('Hysteria2 node offers no TLS-pinned config (an unpinned tunnel would be MITM-able)')
  }
  const address = Array.isArray(nodeAddrs)
    ? nodeAddrs.find((a) => typeof a === 'string' && a.length > 0)
    : undefined
  if (!address) throw new Error('Hysteria2 handshake returned no node address')

  const port = typeof entry.port === 'string' ? parseInt(entry.port, 10) : entry.port
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Hysteria2 node returned an invalid port')
  }

  const config: Record<string, unknown> = {
    server: `${address}:${port}`,
    auth: uuid,
    tls: { insecure: true, pinSHA256: entry.tls_pin },
    socks5: { listen: `${SOCKS_LISTEN}:${SOCKS_PORT}` },
    lazy: true,
  }

  // Salamander obfuscation is optional — include the block only when the node
  // advertises a password (empty means obfs disabled, matching the go-sdk).
  if (typeof entry.obfs_password === 'string' && entry.obfs_password.length > 0) {
    config.obfs = { type: 'salamander', salamander: { password: entry.obfs_password } }
  }

  return config
}
