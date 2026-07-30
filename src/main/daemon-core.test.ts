import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// daemon-core uses extensionless relative imports (for tsc/bundler), which Node's
// native ESM test loader can't resolve. Bundle it the same way the real daemon is
// built (esbuild → self-contained CJS, no auto-start) and load handleRequest from
// the bundle.
let handleRequest: (req: unknown, deps: unknown) => { ok: boolean; result?: unknown }

before(() => {
  const out = join(mkdtempSync(join(tmpdir(), 'daemon-test-')), 'daemon-core.cjs')
  buildSync({
    entryPoints: ['src/main/daemon-core.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    outfile: out,
    logLevel: 'silent',
  })
  handleRequest = createRequire(import.meta.url)(out).handleRequest
})

function makeDeps() {
  const helperCalls: string[][] = []
  const deps = {
    runHelper: (args: string[]) => { helperCalls.push(args); return '' },
    writeWgConfig: () => '/run/katacomb-vpn/sntl0.conf',
    resolveTun2Socks: () => '/pinned/tun2socks',
    resolveAmneziaWgBinDir: () => '/pinned/awg-bin',
    checkStatus: () => ({ wgUp: true, tunUp: false }),
  }
  return { deps, helperCalls }
}

const req = (op: string, args?: Record<string, unknown>) => ({ id: 1, op, args })

const CLEAN_WG = `[Interface]
PrivateKey = aGVsbG8=
Address = 10.8.0.2/32

[Peer]
PublicKey = cHVia2V5
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.7:51820
`

test('wireguard_up accepts a clean config and calls the helper up verb', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('wireguard_up', { configString: CLEAN_WG }), deps)
  assert.equal(res.ok, true)
  assert.deepEqual(helperCalls, [['up', '/run/katacomb-vpn/sntl0.conf']])
})

test('wireguard_up REJECTS a PostUp config and never calls the helper', () => {
  const { deps, helperCalls } = makeDeps()
  const evil = CLEAN_WG.replace('Address = 10.8.0.2/32', 'PostUp = touch /tmp/pwned')
  const res = handleRequest(req('wireguard_up', { configString: evil }), deps)
  assert.equal(res.ok, false)
  assert.equal(helperCalls.length, 0)
})

test('tun_up drops a 0.0.0.0/0 bypass route and uses the PINNED tun2socks', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('tun_up', {
    socksAddr: '127.0.0.1:1080',
    remoteHost: '203.0.113.7',
    gateway: '192.168.1.1',
    iface: 'eth0',
    tun2socksBin: '/tmp/evil', // client-supplied path must be IGNORED
    bypassRoutes: ['10.0.0.0/8', '0.0.0.0/0'],
  }), deps)
  assert.equal(res.ok, true)
  const call = helperCalls[0]
  assert.equal(call[0], 'tun-up')
  assert.equal(call[1], '/pinned/tun2socks') // pinned, not the client's /tmp/evil
  assert.equal(call[call.length - 1], '10.0.0.0/8') // 0.0.0.0/0 filtered out
})

test('tun_up rejects a non-IPv4 remoteHost', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('tun_up', {
    socksAddr: '127.0.0.1:1080', remoteHost: 'evil.example.com', gateway: '192.168.1.1', iface: 'eth0',
  }), deps)
  assert.equal(res.ok, false)
  assert.equal(helperCalls.length, 0)
})

test('dns_set rejects a non-allowlisted resolver', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('dns_set', { dnsIp: '8.8.4.4' }), deps)
  assert.equal(res.ok, false)
  assert.equal(helperCalls.length, 0)
})

test('dns_set accepts an allow-listed resolver', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('dns_set', { dnsIp: '1.1.1.1' }), deps)
  assert.equal(res.ok, true)
  assert.deepEqual(helperCalls, [['dns-set', '1.1.1.1']])
})

test('status returns kernel interface state from deps', () => {
  const { deps } = makeDeps()
  const res = handleRequest(req('status'), deps)
  assert.equal(res.ok, true)
  assert.deepEqual(res.result, { wgUp: true, tunUp: false })
})

test('an unknown op is rejected', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('frobnicate'), deps)
  assert.equal(res.ok, false)
  assert.equal(helperCalls.length, 0)
})

const CLEAN_AWG = `[Interface]
PrivateKey = aGVsbG8=
Address = 10.8.0.5/32
Jc = 4
Jmin = 128
Jmax = 800
S1 = 15
S2 = 40
H1 = 1234567891
H2 = 987654321
H3 = 246813579
H4 = 1357924680

[Peer]
PublicKey = cHVia2V5
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.10:51820
`

test('amneziawg_up accepts a clean config and passes the daemon-resolved bin dir', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('amneziawg_up', { configString: CLEAN_AWG }), deps)
  assert.equal(res.ok, true)
  assert.deepEqual(helperCalls, [['awg-up', '/run/katacomb-vpn/sntl0.conf', '/pinned/awg-bin']])
})

test('amneziawg_up REJECTS a PostUp config and never calls the helper', () => {
  const { deps, helperCalls } = makeDeps()
  const evil = CLEAN_AWG.replace('Jc = 4', 'PostUp = touch /tmp/pwned')
  const res = handleRequest(req('amneziawg_up', { configString: evil }), deps)
  assert.equal(res.ok, false)
  assert.equal(helperCalls.length, 0)
})

test('amneziawg_up fails CLOSED when the bundled binaries fail integrity', () => {
  const { deps, helperCalls } = makeDeps()
  deps.resolveAmneziaWgBinDir = () => { throw new Error('awg failed SHA-256 integrity check') }
  const res = handleRequest(req('amneziawg_up', { configString: CLEAN_AWG }), deps)
  assert.equal(res.ok, false)
  assert.equal(helperCalls.length, 0)
})

test('amneziawg_down calls the awg-down verb', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('amneziawg_down'), deps)
  assert.equal(res.ok, true)
  assert.deepEqual(helperCalls, [['awg-down']])
})
