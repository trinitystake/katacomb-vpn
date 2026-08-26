import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_LIMITS, byteLength, providerDetailsProblem } from './provider-details.ts'

/** The throwing form the main process uses, expressed over the pure checker. */
function assertValid(details: Parameters<typeof providerDetailsProblem>[0], options: { requireName: boolean }): void {
  const problem = providerDetailsProblem(details, options)
  if (problem) throw new Error(problem)
}

// --- provider details validation (mirrors x/provider/types/v3/msg.go ValidateBasic) ---

const OK_DETAILS = { name: 'n', identity: '', website: '', description: '' }

test('provider details: name is required to register and optional to update', () => {
  // The hub keeps the stored name when MsgUpdateProviderDetails carries an empty
  // one, so an update may legitimately omit it. Registration may not.
  assert.throws(() => assertValid({ ...OK_DETAILS, name: '' }, { requireName: true }), /name/i)
  assert.throws(() => assertValid({ ...OK_DETAILS, name: '   ' }, { requireName: true }), /name/i)
  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, name: '' }, { requireName: false }))
})

test('provider details: the hub length caps are 64/64/64/256', () => {
  const at = (n: number) => 'x'.repeat(n)
  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, name: at(64) }, { requireName: true }))
  assert.throws(() => assertValid({ ...OK_DETAILS, name: at(65) }, { requireName: true }), /64/)

  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, identity: at(64) }, { requireName: true }))
  assert.throws(() => assertValid({ ...OK_DETAILS, identity: at(65) }, { requireName: true }), /64/)

  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, description: at(256) }, { requireName: true }))
  assert.throws(() => assertValid({ ...OK_DETAILS, description: at(257) }, { requireName: true }), /256/)
})

test('provider details: the cap counts BYTES, because the hub measures a Go string', () => {
  // len() in Go is bytes, so 33 emoji (4 bytes each) blow a 64-char-looking cap.
  const emoji = '\u{1F600}'.repeat(17) // 68 bytes, 17 code points
  assert.throws(() => assertValid({ ...OK_DETAILS, name: emoji }, { requireName: true }), /64/)
})

test('provider details: website must parse the way url.ParseRequestURI does', () => {
  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, website: 'https://example.com' }, { requireName: true }))
  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, website: 'http://example.com/x' }, { requireName: true }))
  // Go accepts a bare absolute path here; mirroring it keeps us from rejecting
  // something the chain would have taken.
  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, website: '/about' }, { requireName: true }))
  // Optional: an empty website is never validated.
  assert.doesNotThrow(() => assertValid({ ...OK_DETAILS, website: '' }, { requireName: true }))

  assert.throws(() => assertValid({ ...OK_DETAILS, website: 'example.com' }, { requireName: true }), /scheme/i)
  assert.throws(() => assertValid({ ...OK_DETAILS, website: 'https://' }, { requireName: true }), /website/i)
})

test('byteLength counts UTF-8 bytes, matching Go len()', () => {
  assert.equal(byteLength('abc'), 3)
  assert.equal(byteLength('\u{1F600}'), 4)
  assert.equal(byteLength('e\u0301'), 3)
})

test('providerDetailsProblem returns null exactly when the chain would accept', () => {
  assert.equal(providerDetailsProblem(OK_DETAILS, { requireName: true }), null)
  assert.notEqual(providerDetailsProblem({ ...OK_DETAILS, name: '' }, { requireName: true }), null)
})

test('the caps match the hub constants', () => {
  assert.deepEqual({ ...PROVIDER_LIMITS }, { name: 64, identity: 64, website: 64, description: 256 })
})
