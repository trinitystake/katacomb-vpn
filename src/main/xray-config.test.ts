import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildXRayConfig, selectXRayEntry, buildXRayOutbound, normalizeXRayTlsPin, type XRayMetadataEntry } from './xray-config.ts'
import { normalizeTlsPin } from './multihop-config.ts'

// Real service_metadata captured from live xray node I3W0H0R2 (103.181.227.155),
// version 9.0.0. Entry 0 is the flagship VLESS+Reality+TCP; the rest are other
// proxy/transport combos the pilot doesn't build.
const I3W0H0R2_METADATA: XRayMetadataEntry[] = [
  {
    port: '37545', proxy_protocol: 1, transport_protocol: 1, transport_security: 3, flow: 2,
    reality_server_name: 'www.apple.com', reality_short_id: '252f43c7d3719ef6',
    reality_public_key: 'xVP4a6JqZL3tG9Cc3m6Ytn8xtdNnHyyEcCBxFpDFhzg', reality_fingerprint: 'chrome',
  },
  { port: '43595', proxy_protocol: 1, transport_protocol: 5, transport_security: 3, flow: 1,
    reality_server_name: 'www.apple.com', reality_short_id: '3c80f507ffd3f850',
    reality_public_key: 'CAhLnR0kqRSmcA0XZ3A24xBJJ8RX0e1H_BertJyotkk', reality_fingerprint: 'chrome' },
  { port: '57459', proxy_protocol: 3, transport_protocol: 2, transport_security: 2, flow: 1 },
  { port: '7384', proxy_protocol: 2, transport_protocol: 4, transport_security: 2, flow: 1 },
]

const UUID = '11111111-2222-3333-4444-555555555555'
const ADDRS = ['103.181.227.155']

test('buildXRayConfig builds a VLESS+Reality+TCP outbound from live metadata', () => {
  const cfg = buildXRayConfig(I3W0H0R2_METADATA, ADDRS, UUID) as any

  // loopback SOCKS inbound that tun2socks dials
  assert.equal(cfg.inbounds[0].protocol, 'socks')
  assert.equal(cfg.inbounds[0].listen, '127.0.0.1')
  assert.equal(cfg.inbounds[0].port, 1080)

  const ob = cfg.outbounds[0]
  assert.equal(ob.protocol, 'vless')
  const vnext = ob.settings.vnext[0]
  assert.equal(vnext.address, '103.181.227.155')
  assert.equal(vnext.port, 37545) // parsed from the string port
  assert.equal(vnext.users[0].id, UUID)
  assert.equal(vnext.users[0].encryption, 'none')
  assert.equal(vnext.users[0].flow, 'xtls-rprx-vision') // flow=2

  assert.equal(ob.streamSettings.network, 'tcp') // transport_protocol=1
  assert.equal(ob.streamSettings.security, 'reality') // transport_security=3
  assert.deepEqual(ob.streamSettings.realitySettings, {
    serverName: 'www.apple.com',
    fingerprint: 'chrome',
    publicKey: 'xVP4a6JqZL3tG9Cc3m6Ytn8xtdNnHyyEcCBxFpDFhzg',
    shortId: '252f43c7d3719ef6',
    spiderX: '',
  })
})

test('selectXRayEntry prefers a Reality entry and skips non-VLESS/unknown transports', () => {
  const entry = selectXRayEntry(I3W0H0R2_METADATA)
  assert.equal(entry?.port, '37545') // the reality+tcp vless entry, not the proxy=2/3 ones
})

test('selectXRayEntry falls back to a PINNED TLS entry when no Reality entry exists', () => {
  // This test used to assert the unpinned shape (serverName + allowInsecure, no
  // pin), which is what the defect looked like: it builds, and then cannot verify
  // the node's self-signed certificate at runtime.
  const md: XRayMetadataEntry[] = [
    { port: '9000', proxy_protocol: 1, transport_protocol: 1, transport_security: 2, flow: 1,
      tls_pin: 'c'.repeat(64), reality_server_name: 'example.com', reality_fingerprint: 'chrome' },
  ]
  const entry = selectXRayEntry(md)
  assert.equal(entry?.transport_security, 2)
  const cfg = buildXRayConfig(md, ADDRS, UUID) as any
  const tls = cfg.outbounds[0].streamSettings.tlsSettings
  assert.equal(cfg.outbounds[0].streamSettings.security, 'tls')
  assert.equal(tls.pinnedPeerCertSha256, 'c'.repeat(64))
  assert.ok(!('serverName' in tls))
})

test('a node offering only an unpinnable TLS entry is refused, not built', () => {
  // Same failure class as cleartext-only: nothing usable, so fail into the refund
  // path rather than connect to a node we cannot authenticate.
  const md: XRayMetadataEntry[] = [
    { port: '9000', proxy_protocol: 1, transport_protocol: 1, transport_security: 2 },
  ]
  assert.throws(() => buildXRayConfig(md, ADDRS, UUID))
})

test('buildXRayConfig rejects cleartext-only (VLESS+none) nodes', () => {
  const md: XRayMetadataEntry[] = [
    { port: '9000', proxy_protocol: 1, transport_protocol: 1, transport_security: 1, flow: 1 },
  ]
  assert.equal(selectXRayEntry(md), null)
  assert.throws(() => buildXRayConfig(md, ADDRS, UUID), /no supported VLESS/)
})

test('buildXRayConfig throws on empty metadata and on missing address', () => {
  assert.throws(() => buildXRayConfig([], ADDRS, UUID), /no service metadata/)
  assert.throws(() => buildXRayConfig(I3W0H0R2_METADATA, [], UUID), /no node address/)
})

// --- TLS entries must be PINNED --------------------------------------------
//
// Sentinel nodes serve self-signed certificates, so a TLS outbound with no pin has
// nothing to verify the node against. This branch used to emit `allowInsecure:false`
// and a serverName and no pin at all: it builds, and then fails verification at
// runtime. Reality nodes were never affected (they take the other branch).

const TLS_PIN_HEX = 'a'.repeat(64)

const tlsEntry = (over: Partial<XRayMetadataEntry> = {}): XRayMetadataEntry => ({
  port: '4876', proxy_protocol: 1, transport_protocol: 1, transport_security: 2,
  tls_pin: TLS_PIN_HEX, ...over,
})

test('a TLS outbound pins the node certificate and never sends allowInsecure', () => {
  const ob = buildXRayOutbound(tlsEntry(), '203.0.113.9', 'uuid-1')
  const tls = (ob.streamSettings as Record<string, unknown>).tlsSettings as Record<string, unknown>
  assert.equal(tls.pinnedPeerCertSha256, TLS_PIN_HEX)
  assert.ok(!('allowInsecure' in tls), 'removed in xray 26.x — a hard config error')
  assert.ok(!('serverName' in tls), 'redundant once the exact certificate is pinned')
})

test('a TLS entry with no usable pin is not selectable', () => {
  // Preferring it would build a config that cannot verify the node.
  assert.equal(selectXRayEntry([tlsEntry({ tls_pin: undefined })]), null)
  assert.equal(selectXRayEntry([tlsEntry({ tls_pin: 'not-a-digest' })]), null)
})

test('Reality still wins over TLS, and needs no pin of its own', () => {
  const reality: XRayMetadataEntry = {
    port: '37545', proxy_protocol: 1, transport_protocol: 1, transport_security: 3,
    reality_public_key: 'xVP4a6JqZ', reality_short_id: '252f43c7d3719ef6',
  }
  assert.equal(selectXRayEntry([tlsEntry(), reality]), reality)
  assert.equal(selectXRayEntry([reality]), reality)
})

test('normalizeXRayTlsPin agrees with the multihop builder byte for byte', () => {
  // Duplicated on purpose (both modules stay import-free for the native runner), so
  // the copies have to be pinned together or they will drift apart silently.
  const cases = [
    'b'.repeat(64), 'B'.repeat(64), Buffer.alloc(32, 7).toString('base64'),
    '', 'short', 'z'.repeat(64), Buffer.alloc(31, 7).toString('base64'), undefined,
  ]
  for (const c of cases) {
    assert.equal(normalizeXRayTlsPin(c), normalizeTlsPin(c), `disagreed on ${JSON.stringify(c)}`)
  }
})
