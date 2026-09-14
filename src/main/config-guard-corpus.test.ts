import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  assertSafeWireguardConfig,
  assertSafeAmneziaWgConfig,
  assertSafeOpenVpnConfig,
  isIPv4,
  isValidInterfaceName,
  isValidSocksAddr,
  isAllowedBypassCidr,
  isAllowedDnsResolver,
} from './config-guard.ts'

// The root-side helper (daemon/internal/guard) re-implements these validators in
// Go, and the two must accept and reject exactly the same inputs. This corpus is
// the single fixture set both read — daemon/internal/guard/testdata/corpus/ — so a
// rule changed on one side fails the other side's test until it is mirrored. See
// the README there for the header format. The 76 inline tests in
// config-guard.test.ts are untouched; this is the cross-implementation pin.

const CORPUS = fileURLToPath(new URL('../../daemon/internal/guard/testdata/corpus/', import.meta.url))

// The Go messages contain the reason word literally; the TypeScript wording
// predates the corpus and is matched per reason instead.
const REASON_PATTERNS: Record<string, RegExp> = {
  'not allowed': /not allowed/,
  repeated: /repeated/,
  missing: /missing/,
  malformed: /malformed|must be|not a valid|non-PEM|no argument grammar/,
  unterminated: /unterminated/,
  'outside any section': /outside any section/,
}

interface CorpusCase { name: string; expect: string; reason: string; body: string }

function loadCorpus(proto: string): CorpusCase[] {
  const dir = join(CORPUS, proto)
  const cases: CorpusCase[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.conf')) continue
    const body = readFileSync(join(dir, name), 'utf-8')
    let expect = ''
    let reason = ''
    for (const line of body.split('\n')) {
      if (!line.startsWith('# ')) break
      if (line.startsWith('# expect: ')) expect = line.slice('# expect: '.length)
      if (line.startsWith('# reason: ')) reason = line.slice('# reason: '.length)
    }
    assert.ok(expect === 'accept' || expect === 'reject', `${proto}/${name}: bad header`)
    if (expect === 'reject') assert.ok(REASON_PATTERNS[reason], `${proto}/${name}: unknown reason "${reason}"`)
    cases.push({ name, expect, reason, body })
  }
  assert.ok(cases.length >= 5, `${proto} corpus looks empty`)
  return cases
}

function runCorpus(proto: string, validate: (config: string) => void): void {
  for (const c of loadCorpus(proto)) {
    test(`corpus ${proto}/${c.name} is ${c.expect}ed`, () => {
      if (c.expect === 'accept') {
        assert.doesNotThrow(() => validate(c.body))
      } else {
        assert.throws(() => validate(c.body), REASON_PATTERNS[c.reason])
      }
    })
  }
}

runCorpus('wireguard', assertSafeWireguardConfig)
runCorpus('amneziawg', assertSafeAmneziaWgConfig)
runCorpus('openvpn', assertSafeOpenVpnConfig)

test('corpus scalars.json agrees with the scalar validators', () => {
  const doc = JSON.parse(readFileSync(join(CORPUS, 'scalars.json'), 'utf-8')) as Record<string, unknown>
  const fns: Record<string, (s: string) => boolean> = {
    ipv4: isIPv4,
    iface: isValidInterfaceName,
    socksAddr: isValidSocksAddr,
    bypassCidr: isAllowedBypassCidr,
    dnsResolver: isAllowedDnsResolver,
  }
  for (const [name, fn] of Object.entries(fns)) {
    const lists = doc[name] as { accept: string[]; reject: string[] }
    assert.ok(lists.accept.length > 0 && lists.reject.length > 0, `${name}: both lists must be non-empty`)
    for (const v of lists.accept) assert.equal(fn(v), true, `${name}: expected accept ${JSON.stringify(v)}`)
    for (const v of lists.reject) assert.equal(fn(v), false, `${name}: expected reject ${JSON.stringify(v)}`)
  }
  for (const name of Object.keys(doc)) {
    if (name !== '_comment') assert.ok(fns[name], `scalars.json section "${name}" has no validator here`)
  }
})
