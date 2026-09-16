import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wireguard } from '@sentinel-official/sentinel-js-sdk'
import { buildWireguardConfig, DEFAULT_WIREGUARD_DNS } from './wireguard-config.ts'
import { assertSafeWireguardConfig } from '../config-guard.ts'

// The SDK stays a devDependency so this oracle keeps working: our builder must
// emit exactly what its Wireguard class emitted, or an existing session's tunnel
// changes behaviour under a refactor that was only supposed to drop a dependency.

const CASES = [
  {
    name: 'single v4 address',
    handshake: { addrs: ['10.8.0.5/32'], metadata: [{ port: 51820, public_key: 'K1J8hK7VJ9cQe1qC5Vv2Wn3sT4uY6iO8pA0sD2fG4h0=' }] },
    nodeAddrs: ['203.0.113.10'],
  },
  {
    name: 'dual stack',
    handshake: { addrs: ['10.8.0.5/32', 'fd00::5/128'], metadata: [{ port: 63115, public_key: 'aB3dEf6gHi9jKl2mNo5pQr8sTu1vWx4yZa7bCd0eFg8=' }] },
    nodeAddrs: ['198.51.100.7'],
  },
  {
    name: 'string port, as the wire sometimes carries it',
    handshake: { addrs: ['10.8.0.9/32'], metadata: [{ port: '8443', public_key: 'zZ9yY8xX7wW6vV5uU4tT3sS2rR1qQ0pP9oO8nN7mM6l=' }] },
    nodeAddrs: ['203.0.113.44'],
  },
]

for (const c of CASES) {
  test(`byte-identical to the SDK: ${c.name}`, async () => {
    const sdk = new Wireguard()
    await sdk.parseConfig(c.handshake as never, c.nodeAddrs)
    const theirs = sdk.buildConfigString()
    const ours = buildWireguardConfig(c.handshake, c.nodeAddrs, sdk.privateKey)
    assert.equal(ours, theirs)
  })
}

test('the default DNS list is the SDK\'s, unchanged', async () => {
  const sdk = new Wireguard()
  await sdk.parseConfig(CASES[0].handshake as never, CASES[0].nodeAddrs)
  // Read it back off the SDK's own output rather than trusting our constant.
  const line = (sdk.buildConfigString() ?? '').split('\n').find((l) => l.startsWith('DNS = '))
  assert.equal(line, `DNS = ${DEFAULT_WIREGUARD_DNS.join(',')}`)
})

test('a caller-chosen resolver list replaces the default', () => {
  const out = buildWireguardConfig(CASES[0].handshake, CASES[0].nodeAddrs, 'cHJpdmF0ZUtleUJhc2U2NEVuY29kZWRTdHJpbmdIZXJlPQ==', ['9.9.9.9'])
  assert.match(out, /^DNS = 9\.9\.9\.9$/m)
})

test('the output passes the config guard that gates the real bring-up', () => {
  const out = buildWireguardConfig(CASES[1].handshake, CASES[1].nodeAddrs, 'cHJpdmF0ZUtleUJhc2U2NEVuY29kZWRTdHJpbmdIZXJlPQ==')
  assert.doesNotThrow(() => assertSafeWireguardConfig(out))
})

test('refuses incomplete node data rather than emitting a half-built config', () => {
  const priv = 'cHJpdmF0ZUtleUJhc2U2NEVuY29kZWRTdHJpbmdIZXJlPQ=='
  assert.throws(() => buildWireguardConfig({ addrs: [], metadata: [] }, ['1.2.3.4'], priv), /no metadata/)
  assert.throws(() => buildWireguardConfig({ addrs: [], metadata: [{ port: 1, public_key: '' }] }, ['1.2.3.4'], priv), /public key/)
  assert.throws(() => buildWireguardConfig(CASES[0].handshake, [], priv), /node address/)
  assert.throws(() => buildWireguardConfig(CASES[0].handshake, ['1.2.3.4'], ''), /private key/)
})
