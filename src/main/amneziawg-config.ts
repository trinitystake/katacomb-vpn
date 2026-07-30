// Pure builder for an AmneziaWG CLIENT config (awg-quick INI) from a dVPN
// node's handshake metadata. The bundled JS SDK (2.0.4) knows only
// WireGuard/V2Ray — its Wireguard.buildConfigString() cannot emit the AmneziaWG
// obfuscation keys — so for amneziawg nodes (node.type === 5) we build the INI
// ourselves. The SDK Wireguard class is still used by the caller for KEYGEN only
// (the handshake payload is the same base64 Curve25519 public key as WireGuard).
//
// Field names are taken verbatim from the Sentinel go-sdk
// (github.com/sentinel-official/sentinel-go-sdk, amneziawg/metadata.go):
//   handshake request  = { public_key }
//   handshake response = { addrs: [tunnel IPs], metadata: [ { port, public_key,
//                          s1..s4, h1..h4, i1..i5? } ] }
// The node does NOT send Jc/Jmin/Jmax — junk-packet behavior is per-sender, so we
// generate them locally in the same ranges the go-sdk server's Obfs.Generate()
// uses (Jc [3,10], Jmin [64,256], Jmax [512,1024]). The S-paddings and H-headers
// must match the server exactly (they change the wire framing), and I1..I5 are
// signature packets the server expects the client to send before the handshake —
// when present they MUST be forwarded, validated against the awg tag grammar.
//
// Constraint re-checks mirror the go-sdk server's Obfs.Validate() — the node is
// adversarial, so violations throw and the caller refunds the session. The
// config-guard re-check (assertSafeAmneziaWgConfig) still runs at the root sinks
// as the trust boundary.
//
// Electron-free + unit-tested (native runner), like xray-config.ts / hysteria-config.ts.

export interface AwgMetadataEntry {
  port: string | number
  public_key: string
  s1: number
  s2: number
  s3: number
  s4: number
  h1: number
  h2: number
  h3: number
  h4: number
  i1?: string
  i2?: string
  i3?: string
  i4?: string
  i5?: string
}

// Local copies (pure modules never runtime-import each other; see config-guard.ts).
const BASE64_KEY = /^[A-Za-z0-9+/]+={0,2}$/
const HOST_OR_CIDR = /^\[?[A-Za-z0-9.:_-]+\]?(\/\d{1,3})?$/
// awg signature-packet tag grammar: <b 0xHEX> static bytes, <r N>/<rd N>/<rc N>
// random bytes/digits/chars, <t> unix timestamp (amneziawg-go README).
const I_TAGS = /^(<b 0x[0-9a-fA-F]+>|<r \d{1,5}>|<rd \d{1,5}>|<rc \d{1,5}>|<t>)+$/
const I_MAX_LENGTH = 4096

// Client-generated junk-packet ranges — the go-sdk server's own defaults.
const JC_RANGE = [3, 10] as const
const JMIN_RANGE = [64, 256] as const
const JMAX_RANGE = [512, 1024] as const

function randInt([min, max]: readonly [number, number]): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function assertUintInRange(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`AmneziaWG obfuscation param ${name} out of range`)
  }
}

/**
 * Build the full awg-quick INI: the SDK WireGuard config shape (Address /
 * PrivateKey / DNS + full-tunnel peer, no MTU/ListenPort) plus the obfuscation
 * keys. Throws on missing/inconsistent node data so the caller refunds.
 */
export function buildAmneziaWgConfig(
  metadata: AwgMetadataEntry[],
  nodeAddrs: string[],
  assignedAddrs: string[],
  privateKey: string,
): string {
  if (!Array.isArray(metadata) || metadata.length === 0) {
    throw new Error('AmneziaWG node returned no service metadata')
  }
  const entry = metadata[0]

  if (typeof entry.public_key !== 'string' || !BASE64_KEY.test(entry.public_key)) {
    throw new Error('AmneziaWG node returned an invalid public key')
  }
  const port = typeof entry.port === 'string' ? parseInt(entry.port, 10) : entry.port
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('AmneziaWG node returned an invalid port')
  }
  const endpointHost = Array.isArray(nodeAddrs)
    ? nodeAddrs.find((a) => typeof a === 'string' && a.length > 0)
    : undefined
  if (!endpointHost) throw new Error('AmneziaWG handshake returned no node address')
  if (!Array.isArray(assignedAddrs) || assignedAddrs.length === 0) {
    throw new Error('AmneziaWG handshake returned no assigned tunnel address')
  }
  for (const addr of assignedAddrs) {
    if (typeof addr !== 'string' || !HOST_OR_CIDR.test(addr)) {
      throw new Error(`AmneziaWG assigned address "${addr}" is malformed`)
    }
  }

  // S-paddings (uint16) and H-headers (uint32) come from the node and must match
  // its wire framing. Mirror the go-sdk server's Obfs.Validate().
  for (const name of ['s1', 's2', 's3', 's4'] as const) assertUintInRange(name, entry[name], 65535)
  if (entry.s1 + 56 === entry.s2) {
    throw new Error('AmneziaWG obfuscation params violate S1 + 56 != S2')
  }
  const headers = [entry.h1, entry.h2, entry.h3, entry.h4]
  for (const name of ['h1', 'h2', 'h3', 'h4'] as const) assertUintInRange(name, entry[name], 4294967295)
  const allZero = headers.every((h) => h === 0) // plain-WireGuard compat mode
  const allDistinctAboveWg = new Set(headers).size === 4 && headers.every((h) => h > 4)
  if (!allZero && !allDistinctAboveWg) {
    throw new Error('AmneziaWG headers H1-H4 must be all zero or all distinct and > 4')
  }
  for (const name of ['i1', 'i2', 'i3', 'i4', 'i5'] as const) {
    const value = entry[name]
    if (value === undefined || value === '') continue
    if (typeof value !== 'string' || value.length > I_MAX_LENGTH || !I_TAGS.test(value)) {
      throw new Error(`AmneziaWG signature packet ${name} is malformed`)
    }
  }

  const jmin = randInt(JMIN_RANGE)
  const jmax = randInt(JMAX_RANGE) // ranges are disjoint, so Jmin < Jmax always holds

  const lines = [
    '[Interface]',
    `Address = ${assignedAddrs.join(',')}`,
    `PrivateKey = ${privateKey}`,
    'DNS = 10.8.0.1,1.0.0.1,1.1.1.1', // parity with the SDK's WireGuard config
    `Jc = ${randInt(JC_RANGE)}`,
    `Jmin = ${jmin}`,
    `Jmax = ${jmax}`,
    `S1 = ${entry.s1}`,
    `S2 = ${entry.s2}`,
    `S3 = ${entry.s3}`,
    `S4 = ${entry.s4}`,
    `H1 = ${entry.h1}`,
    `H2 = ${entry.h2}`,
    `H3 = ${entry.h3}`,
    `H4 = ${entry.h4}`,
  ]
  for (const name of ['i1', 'i2', 'i3', 'i4', 'i5'] as const) {
    const value = entry[name]
    if (value) lines.push(`${name.toUpperCase()} = ${value}`)
  }
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${entry.public_key}`,
    'AllowedIPs = 0.0.0.0/0,::/0',
    `Endpoint = ${endpointHost}:${port}`,
    'PersistentKeepalive = 15',
    '',
  )
  return lines.join('\n')
}
