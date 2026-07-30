// Pure builder for an OpenVPN CLIENT config (.ovpn) from a dVPN node's handshake
// metadata. The bundled JS SDK (2.0.4) has no OpenVPN class at all, so for
// openvpn nodes (node.type === 3) we build the whole config ourselves.
//
// Field names are taken verbatim from the Sentinel go-sdk
// (github.com/sentinel-official/sentinel-go-sdk, openvpn/{metadata,responses}.go).
// Verified identical at go-sdk master AND at the commit node v8.3.1 pins
// (21beb4dcafa5), so one shape covers every node on the network:
//   handshake request  = { uuid }            // 16 raw bytes, NOT a string —
//                                            // the node field is v2fly uuid.UUID ([16]byte)
//   handshake response = { metadata: [ { port, protocol: "tcp"|"udp",
//                                        ca: b64(DER cert), tls: b64(256-byte
//                                        tls-crypt static key) } ],
//                          cert: b64(DER client cert),
//                          key:  b64(DER PKCS#8 private key) }
// There is no `addrs` in the body: OpenVPN has no client-assigned tunnel IP (the
// server pushes it), so the endpoint host comes from the SDK response's top-level
// `result.addrs`.
//
// Unlike the go-sdk client (and the JS SDK 2.1.0 OpenVPN class), this emits ONE
// self-contained config with inline <ca>/<cert>/<key>/<tls-crypt> blocks instead
// of a config plus four PKI files in a temp directory. That is what lets the
// config live in SavedSessionConfig.configString (so reconnect works) and be
// shipped to the privileged daemon as CONTENT — no user-controlled path ever
// reaches root.
//
// Injection safety: every node-supplied blob is base64-DECODED and re-armored by
// us, so no node byte can become a config directive. `protocol` must be exactly
// tcp/udp, the port an integer, the host a strict regex. Certificates and the
// private key are additionally parsed with node:crypto — a node that returns
// garbage throws here, inside performHandshake, which means
// establishSessionOrRefund refunds the session. A failure at bring-up would not
// be refunded, so validating hard here is worth real money.
//
// Deliberately omitted from the go-sdk template: `management 127.0.0.1 2323`
// (a local control socket we never use). Deliberately absent everywhere: any
// --up/--down script, which is the privilege-escalation vector — so pushed DNS
// is never applied and DNS is provisioned by the app's own dns-set helper verb.
//
// Electron-free + unit-tested (native runner), like amneziawg-config.ts.

import { X509Certificate, createPrivateKey } from 'crypto'
import { isIP } from 'net'

export interface OpenVpnMetadataEntry {
  port: string | number
  protocol: string
  ca: string
  tls: string
}

export interface OpenVpnHandshakeData {
  metadata: OpenVpnMetadataEntry[]
  cert: string
  key: string
}

// The tunnel interface. Distinct from WireGuard/AmneziaWG's sntl0 on purpose: a
// userspace AmneziaWG sntl0 is already `type tun`, so a third tun on that name
// would make adoption and teardown ambiguous (awg-down and ovpn-down are not
// interchangeable). Local copy — pure modules never runtime-import each other.
const OVPN_IFACE = 'sntl-ovpn'

// A tls-crypt / tls-auth static key is OpenVPN Static key V1: 2048 bits.
const TLS_CRYPT_KEY_BYTES = 256

const HOST = /^\[?[A-Za-z0-9.:_-]+\]?$/
const STD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Decode a Go []byte field (standard base64). Rejects anything non-canonical so a
 * node can't smuggle whitespace or padding tricks past us before we re-armor.
 */
function decodeGoBytes(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`OpenVPN node returned an empty ${field}`)
  }
  if (!STD_BASE64.test(value) || value.length % 4 !== 0) {
    throw new Error(`OpenVPN node returned a malformed ${field}`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error(`OpenVPN node returned a malformed ${field}`)
  }
  return decoded
}

/** Reject anything that isn't a real X.509 certificate. */
function assertCertificate(der: Buffer, field: string): void {
  try {
    new X509Certificate(der)
  } catch {
    throw new Error(`OpenVPN node returned an invalid ${field}`)
  }
}

/**
 * Parse the client private key and report the PEM label to armor it with. The
 * go-sdk marshals PKCS#8, but accept SEC1/PKCS#1 too rather than fail a node over
 * an encoding choice — garbage still throws.
 */
function privateKeyLabel(der: Buffer): string {
  const candidates = [
    { type: 'pkcs8', label: 'PRIVATE KEY' },
    { type: 'sec1', label: 'EC PRIVATE KEY' },
    { type: 'pkcs1', label: 'RSA PRIVATE KEY' },
  ] as const
  for (const candidate of candidates) {
    try {
      createPrivateKey({ key: der, format: 'der', type: candidate.type })
      return candidate.label
    } catch {
      // try the next encoding
    }
  }
  throw new Error('OpenVPN node returned an invalid client key')
}

function pemBase64(data: Buffer, label: string): string {
  const body = data.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
}

function pemHex(data: Buffer, label: string): string {
  const body = data.toString('hex').match(/.{1,32}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
}

/**
 * Build the full client .ovpn. Throws on missing/invalid node data so the caller
 * refunds the session. The config-guard re-check (assertSafeOpenVpnConfig) still
 * runs at the root sinks as the trust boundary.
 */
export function buildOpenVpnConfig(data: OpenVpnHandshakeData, nodeAddrs: string[]): string {
  if (!data || !Array.isArray(data.metadata) || data.metadata.length === 0) {
    throw new Error('OpenVPN node returned no service metadata')
  }
  const entry = data.metadata[0]

  const port = typeof entry.port === 'string' ? parseInt(entry.port, 10) : entry.port
  if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) {
    throw new Error('OpenVPN node returned an invalid port')
  }
  if (entry.protocol !== 'tcp' && entry.protocol !== 'udp') {
    throw new Error('OpenVPN node returned an unsupported transport protocol')
  }

  // Prefer IPv4: `remote <hostname>` would have to be resolved at bring-up, and on
  // an auto-reconnect the kill switch is still armed (DNS blocked) — the same
  // deadlock the V2Ray path pins addresses to avoid.
  const usable = Array.isArray(nodeAddrs)
    ? nodeAddrs.filter((a): a is string => typeof a === 'string' && a.length > 0)
    : []
  const host = usable.find((a) => isIP(a) === 4) ?? usable[0]
  if (!host) throw new Error('OpenVPN handshake returned no node address')
  if (!HOST.test(host)) throw new Error(`OpenVPN node address "${host}" is malformed`)

  const ca = decodeGoBytes(entry.ca, 'CA certificate')
  const cert = decodeGoBytes(data.cert, 'client certificate')
  const key = decodeGoBytes(data.key, 'client key')
  const tls = decodeGoBytes(entry.tls, 'tls-crypt key')

  assertCertificate(ca, 'CA certificate')
  assertCertificate(cert, 'client certificate')
  const keyLabel = privateKeyLabel(key)
  if (tls.length !== TLS_CRYPT_KEY_BYTES) {
    throw new Error('OpenVPN node returned a tls-crypt key of the wrong length')
  }

  const lines = [
    'client',
    `dev ${OVPN_IFACE}`,
    'dev-type tun',
    `proto ${entry.protocol}`,
    `remote ${host} ${port}`,
    'nobind',
    'auth-nocache',
    'auth SHA256',
    'data-ciphers AES-256-GCM:AES-128-GCM',
    'data-ciphers-fallback AES-256-GCM',
    'tls-cipher TLS-ECDHE-ECDSA-WITH-AES-256-GCM-SHA384',
    'tls-client',
    'tls-version-min 1.2',
    'remote-cert-tls server',
    'redirect-gateway def1 ipv6 bypass-dhcp',
    'topology subnet',
  ]
  if (entry.protocol === 'udp') lines.push('explicit-exit-notify 1')
  lines.push(
    'persist-key',
    'persist-tun',
    '',
    '<ca>',
    pemBase64(ca, 'CERTIFICATE'),
    '</ca>',
    '<cert>',
    pemBase64(cert, 'CERTIFICATE'),
    '</cert>',
    '<key>',
    pemBase64(key, keyLabel),
    '</key>',
    '<tls-crypt>',
    pemHex(tls, 'OpenVPN Static key V1'),
    '</tls-crypt>',
    '',
  )
  return lines.join('\n')
}
