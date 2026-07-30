import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAmneziaWgConfig, type AwgMetadataEntry } from './amneziawg-config.ts'

// Field names/shapes follow sentinel-go-sdk amneziawg/metadata.go: the node sends
// port + public_key (like plain WireGuard) plus the obfuscation params s1..s4 /
// h1..h4 / optional i1..i5. Jc/Jmin/Jmax are generated client-side.
const META: AwgMetadataEntry = {
  port: 51820,
  public_key: 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qga2V5IQ==',
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
