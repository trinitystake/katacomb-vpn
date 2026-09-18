import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAmneziaWgConfig, nodeOffersAwgVersion3, type AwgMetadataEntry } from './amneziawg-config.ts'

// Field names/shapes follow sentinel-go-sdk amneziawg/metadata.go: the node sends
// port + public_key (like plain WireGuard) plus the obfuscation params s1..s4 /
// h1..h4 / optional i1..i5. Jc/Jmin/Jmax are generated client-side.
const META: AwgMetadataEntry = {
  port: 51820,
  public_key: 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qga2V5ISE=',
  s1: 15,
  s2: 40,
  s3: 20,
  s4: 10,
  h1: 1234567891,
  h2: 987654321,
  h3: 246813579,
  h4: 1357924680,
  i1: '<b 0xf6ab3267fd><r 16><t>',
}
const ADDRS = ['203.0.113.10']
const ASSIGNED = ['10.8.0.5/32', 'fd00::5/128']
const PRIVKEY = 'cHJpdmF0ZSBrZXkgcHJpdmF0ZSBrZXkgcHJpdmF0ZSE='

/** Parse the emitted INI into { interface: {...}, peer: {...} } key maps. */
function parseIni(config: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = ''
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      section = sec[1].toLowerCase()
      out[section] = {}
      continue
    }
    const eq = line.indexOf('=')
    out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

test('buildAmneziaWgConfig emits the WG base config plus the obfuscation keys', () => {
  const cfg = parseIni(buildAmneziaWgConfig([META], ADDRS, ASSIGNED, PRIVKEY))

  assert.equal(cfg.interface.Address, '10.8.0.5/32,fd00::5/128')
  assert.equal(cfg.interface.PrivateKey, PRIVKEY)
  assert.equal(cfg.interface.DNS, '10.8.0.1,1.0.0.1,1.1.1.1') // parity with the SDK WG config
  assert.equal(cfg.interface.S1, '15')
  assert.equal(cfg.interface.S2, '40')
  assert.equal(cfg.interface.S3, '20')
  assert.equal(cfg.interface.S4, '10')
  assert.equal(cfg.interface.H1, '1234567891')
  assert.equal(cfg.interface.H2, '987654321')
  assert.equal(cfg.interface.H3, '246813579')
  assert.equal(cfg.interface.H4, '1357924680')
  assert.equal(cfg.interface.I1, '<b 0xf6ab3267fd><r 16><t>')
  assert.equal(cfg.interface.I2, undefined) // absent metadata fields are not emitted

  assert.equal(cfg.peer.PublicKey, META.public_key)
  assert.equal(cfg.peer.AllowedIPs, '0.0.0.0/0,::/0')
  assert.equal(cfg.peer.Endpoint, '203.0.113.10:51820')
  assert.equal(cfg.peer.PersistentKeepalive, '15')
})

test('buildAmneziaWgConfig generates Jc/Jmin/Jmax locally in the upstream-default ranges', () => {
  // Random per build — check ranges across a few builds (nodes never send these).
  for (let i = 0; i < 20; i++) {
    const cfg = parseIni(buildAmneziaWgConfig([META], ADDRS, ASSIGNED, PRIVKEY))
    const jc = Number(cfg.interface.Jc)
    const jmin = Number(cfg.interface.Jmin)
    const jmax = Number(cfg.interface.Jmax)
    assert.ok(jc >= 3 && jc <= 10, `Jc ${jc} out of [3,10]`)
    assert.ok(jmin >= 64 && jmin <= 256, `Jmin ${jmin} out of [64,256]`)
    assert.ok(jmax >= 512 && jmax <= 1024, `Jmax ${jmax} out of [512,1024]`)
    assert.ok(jmin < jmax)
  }
})

test('buildAmneziaWgConfig accepts all-zero headers (plain-WireGuard compat mode)', () => {
  const zeroH: AwgMetadataEntry = { ...META, h1: 0, h2: 0, h3: 0, h4: 0, i1: undefined }
  const cfg = parseIni(buildAmneziaWgConfig([zeroH], ADDRS, ASSIGNED, PRIVKEY))
  assert.equal(cfg.interface.H1, '0')
  assert.equal(cfg.interface.I1, undefined)
})

test('buildAmneziaWgConfig rejects missing/invalid node basics', () => {
  assert.throws(() => buildAmneziaWgConfig([], ADDRS, ASSIGNED, PRIVKEY), /no service metadata/)
  assert.throws(
    () => buildAmneziaWgConfig([{ ...META, public_key: undefined as unknown as string }], ADDRS, ASSIGNED, PRIVKEY),
    /invalid public key/,
  )
  assert.throws(
    () => buildAmneziaWgConfig([{ ...META, public_key: 'not base64!!' }], ADDRS, ASSIGNED, PRIVKEY),
    /invalid public key/,
  )
  assert.throws(() => buildAmneziaWgConfig([{ ...META, port: 0 }], ADDRS, ASSIGNED, PRIVKEY), /invalid port/)
  assert.throws(() => buildAmneziaWgConfig([{ ...META, port: 70000 }], ADDRS, ASSIGNED, PRIVKEY), /invalid port/)
  assert.throws(() => buildAmneziaWgConfig([META], [], ASSIGNED, PRIVKEY), /no node address/)
  assert.throws(() => buildAmneziaWgConfig([META], ADDRS, [], PRIVKEY), /no assigned tunnel address/)
  assert.throws(
    () => buildAmneziaWgConfig([META], ADDRS, ['10.8.0.5; rm -rf /'], PRIVKEY),
    /malformed/,
  )
})

// A key that is valid base64 but not 32 bytes passes the alphabet check and is then
// rejected by the device at bring-up — after the session is paid for and past the
// refund window. It must throw here instead.
test('buildAmneziaWgConfig rejects a public key that is not 32 bytes', () => {
  const short = Buffer.alloc(31).toString('base64')
  const long = Buffer.alloc(33).toString('base64')
  for (const key of [short, long]) {
    assert.throws(
      () => buildAmneziaWgConfig([{ ...META, public_key: key }], ADDRS, ASSIGNED, PRIVKEY),
      /invalid public key/,
    )
  }
  // and the 32-byte one still builds
  assert.ok(buildAmneziaWgConfig([META], ADDRS, ASSIGNED, PRIVKEY).includes('PublicKey'))
})

test('buildAmneziaWgConfig rejects out-of-range or inconsistent obfuscation params', () => {
  assert.throws(() => buildAmneziaWgConfig([{ ...META, s1: 70000 }], ADDRS, ASSIGNED, PRIVKEY), /out of range/)
  assert.throws(() => buildAmneziaWgConfig([{ ...META, s1: 1.5 }], ADDRS, ASSIGNED, PRIVKEY), /out of range/)
  // S1 + 56 == S2 makes handshake init and response packets indistinguishable.
  assert.throws(() => buildAmneziaWgConfig([{ ...META, s1: 10, s2: 66 }], ADDRS, ASSIGNED, PRIVKEY), /S1 \+ 56/)
  assert.throws(() => buildAmneziaWgConfig([{ ...META, h1: 4294967296 }], ADDRS, ASSIGNED, PRIVKEY), /out of range/)
  // Non-distinct, <= 4, and mixed zero/nonzero header sets are all invalid.
  assert.throws(
    () => buildAmneziaWgConfig([{ ...META, h2: META.h1 }], ADDRS, ASSIGNED, PRIVKEY),
    /all zero or all distinct/,
  )
  assert.throws(() => buildAmneziaWgConfig([{ ...META, h3: 3 }], ADDRS, ASSIGNED, PRIVKEY), /all zero or all distinct/)
  assert.throws(() => buildAmneziaWgConfig([{ ...META, h4: 0 }], ADDRS, ASSIGNED, PRIVKEY), /all zero or all distinct/)
})

test('buildAmneziaWgConfig rejects signature packets outside the tag grammar', () => {
  assert.throws(
    () => buildAmneziaWgConfig([{ ...META, i1: '$(rm -rf /)' }], ADDRS, ASSIGNED, PRIVKEY),
    /signature packet/,
  )
  assert.throws(
    () => buildAmneziaWgConfig([{ ...META, i1: '<x 12>' }], ADDRS, ASSIGNED, PRIVKEY),
    /signature packet/,
  )
  assert.throws(
    () => buildAmneziaWgConfig([{ ...META, i2: '<b 0xff>\nPostUp = /bin/sh' }], ADDRS, ASSIGNED, PRIVKEY),
    /signature packet/,
  )
})

// The 3.1 tier entry a dvpnd node answers with when asked for awg_version 3: the
// default keys plus the header protection key, the trailers flag and the MTU.
const META3: AwgMetadataEntry = {
  ...META,
  port: 8443,
  s1: 45,
  s2: 70,
  s3: 24,
  s4: 16,
  awg_version: 3,
  header_protection_key: Buffer.from('header protection key header key').toString('base64'),
  random_trailers: true,
  mtu: 1280,
}

test('buildAmneziaWgConfig emits the 3.1 tier keys for an awg_version 3 entry', () => {
  const cfg = parseIni(buildAmneziaWgConfig([META3], ADDRS, ASSIGNED, PRIVKEY))
  assert.equal(cfg.interface.MTU, '1280')
  assert.equal(cfg.interface.HeaderProtectionKey, META3.header_protection_key)
  assert.equal(cfg.interface.RandomTrailers, 'on')
  assert.equal(cfg.interface.ContentPaddingAddition, '0-32')
  assert.equal(cfg.interface.S3, '24')
  assert.equal(cfg.peer.Endpoint, '203.0.113.10:8443')
})

test('buildAmneziaWgConfig leaves the default tier exactly as before', () => {
  for (const entry of [META, { ...META, awg_version: 2 }]) {
    const cfg = parseIni(buildAmneziaWgConfig([entry], ADDRS, ASSIGNED, PRIVKEY))
    for (const key of ['MTU', 'HeaderProtectionKey', 'RandomTrailers', 'ContentPaddingAddition']) {
      assert.equal(cfg.interface[key], undefined, `${key} must not appear on the default tier`)
    }
  }
})

test('buildAmneziaWgConfig rejects a malformed 3.1 tier entry', () => {
  const short = Buffer.alloc(31).toString('base64')
  const build = (entry: AwgMetadataEntry) => () => buildAmneziaWgConfig([entry], ADDRS, ASSIGNED, PRIVKEY)
  assert.throws(build({ ...META3, header_protection_key: short }), /header protection key/)
  assert.throws(build({ ...META3, header_protection_key: undefined }), /header protection key/)
  assert.throws(build({ ...META3, random_trailers: 'on' as unknown as boolean }), /random_trailers/)
  assert.throws(build({ ...META3, mtu: 9000 }), /invalid mtu/)
  assert.throws(build({ ...META3, mtu: undefined }), /invalid mtu/)
  assert.throws(build({ ...META3, s4: 8 }), /too small for header protection/)
  assert.throws(build({ ...META, awg_version: 4 }), /unknown awg_version/)
})

test('nodeOffersAwgVersion3 reads the root document inbound list', () => {
  const blank = { port: 0, public_key: null, s1: 0, s2: 0, s3: 0, s4: 0, h1: 0, h2: 0, h3: 0, h4: 0 }
  assert.equal(nodeOffersAwgVersion3([{ ...blank, awg_version: 2 }, { ...blank, awg_version: 3 }]), true)
  assert.equal(nodeOffersAwgVersion3([{ ...blank, awg_version: 2 }]), false)
  assert.equal(nodeOffersAwgVersion3([blank]), false)
  assert.equal(nodeOffersAwgVersion3([]), false)
  assert.equal(nodeOffersAwgVersion3(undefined), false)
  assert.equal(nodeOffersAwgVersion3('nope'), false)
})
