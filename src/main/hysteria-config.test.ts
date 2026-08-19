import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHysteria2Config,
  selectHysteria2Entry,
  isValidTlsPin,
  type HysteriaMetadataEntry,
} from './hysteria-config.ts'
import { SOCKS_PORT } from '../shared/socks.ts'

// A well-formed SHA-256 cert fingerprint in the colon-separated hex format the
// go-sdk emits (hysteria2/metadata.go: tls_pin) and pinSHA256 accepts.
const PIN = 'b3:7a:2f:9c:1d:44:e8:05:6a:cc:91:0f:23:5e:88:d1:47:b0:9a:3c:6e:12:fd:84:55:aa:e1:38:7c:90:2b:6f'
const UUID = '11111111-2222-3333-4444-555555555555'
const ADDRS = ['203.0.113.10']

const METADATA: HysteriaMetadataEntry[] = [
  { port: '34567', tls_pin: PIN, obfs_password: 'salt-pepper' },
]

test('buildHysteria2Config builds a pinned client config with a loopback SOCKS5 listener', () => {
  const cfg = buildHysteria2Config(METADATA, ADDRS, UUID) as any

  assert.equal(cfg.server, '203.0.113.10:34567') // addr from addrs + port from metadata
  assert.equal(cfg.auth, UUID) // UUID doubles as the hysteria2 auth credential
  assert.deepEqual(cfg.tls, { insecure: true, pinSHA256: PIN })
  // the SOCKS_ADDR tun2socks dials; cross-checked against shared/socks.ts
  assert.equal(cfg.socks5.listen, `127.0.0.1:${SOCKS_PORT}`)
  assert.equal(cfg.lazy, true) // bind SOCKS immediately; connect on first request
  assert.deepEqual(cfg.obfs, { type: 'salamander', salamander: { password: 'salt-pepper' } })
})

test('buildHysteria2Config omits the obfs block when no password is advertised', () => {
  const cfg = buildHysteria2Config([{ port: 443, tls_pin: PIN }], ADDRS, UUID) as any
  assert.equal(cfg.obfs, undefined)
  assert.equal(cfg.server, '203.0.113.10:443') // numeric port also accepted
})

test('selectHysteria2Entry picks the first entry carrying a valid pin', () => {
  const md: HysteriaMetadataEntry[] = [
    { port: 1, tls_pin: '' },
    { port: 2, tls_pin: PIN, obfs_password: 'x' },
  ]
  assert.equal(selectHysteria2Entry(md)?.port, 2)
})

test('buildHysteria2Config rejects an unpinned (MITM-able) node', () => {
  const noPin: HysteriaMetadataEntry[] = [{ port: '34567', obfs_password: 'x' }]
  assert.equal(selectHysteria2Entry(noPin), null)
  assert.throws(() => buildHysteria2Config(noPin, ADDRS, UUID), /MITM-able/)
})

test('buildHysteria2Config rejects a malformed pin', () => {
  const badPin: HysteriaMetadataEntry[] = [{ port: '34567', tls_pin: 'not-a-real-pin' }]
  assert.equal(selectHysteria2Entry(badPin), null)
  assert.throws(() => buildHysteria2Config(badPin, ADDRS, UUID), /no TLS-pinned config/)
})

test('buildHysteria2Config throws on empty metadata, missing address, and bad port', () => {
  assert.throws(() => buildHysteria2Config([], ADDRS, UUID), /no service metadata/)
  assert.throws(() => buildHysteria2Config(METADATA, [], UUID), /no node address/)
  assert.throws(() => buildHysteria2Config([{ port: '0', tls_pin: PIN }], ADDRS, UUID), /invalid port/)
  assert.throws(() => buildHysteria2Config([{ port: '70000', tls_pin: PIN }], ADDRS, UUID), /invalid port/)
})

test('isValidTlsPin accepts colon-separated and bare 64-hex, rejects others', () => {
  assert.equal(isValidTlsPin(PIN), true)
  assert.equal(isValidTlsPin(PIN.replace(/:/g, '')), true) // bare hex
  assert.equal(isValidTlsPin('deadbeef'), false) // too short
  assert.equal(isValidTlsPin(''), false)
})
