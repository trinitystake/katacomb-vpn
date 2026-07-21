import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildXRayConfig, selectXRayEntry, type XRayMetadataEntry } from './xray-config.ts'

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

test('selectXRayEntry falls back to TLS when no Reality entry exists', () => {
  const md: XRayMetadataEntry[] = [
    { port: '9000', proxy_protocol: 1, transport_protocol: 1, transport_security: 2, flow: 1,
      reality_server_name: 'example.com', reality_fingerprint: 'chrome' },
  ]
  const entry = selectXRayEntry(md)
  assert.equal(entry?.transport_security, 2)
  const cfg = buildXRayConfig(md, ADDRS, UUID) as any
  assert.equal(cfg.outbounds[0].streamSettings.security, 'tls')
  assert.equal(cfg.outbounds[0].streamSettings.tlsSettings.serverName, 'example.com')
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
