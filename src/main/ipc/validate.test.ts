import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertString,
  assertOptionalString,
  assertNumber,
  assertSentAddress,
  assertIntRange,
} from './validate.ts'

// These run at the IPC door on values a compromised renderer can choose freely,
// so the cases that matter are the ones a typed bridge would let through: the
// wrong primitive, the empty string, and the number that is not a number.

describe('assertString', () => {
  test('accepts a non-empty string', () => {
    assert.doesNotThrow(() => assertString('x', 'field'))
  })
  test('rejects the empty string, not just the wrong type', () => {
    assert.throws(() => assertString('', 'field'), /Invalid field/)
  })
  test('rejects the non-strings a JSON payload can carry', () => {
    for (const v of [undefined, null, 0, 1, true, [], {}, ['x']]) {
      assert.throws(() => assertString(v, 'field'), /Invalid field/, `should reject ${JSON.stringify(v)}`)
    }
  })
})

describe('assertOptionalString', () => {
  test('absent is valid, and so is empty', () => {
    assert.doesNotThrow(() => assertOptionalString(undefined, 'f'))
    assert.doesNotThrow(() => assertOptionalString('', 'f'))
  })
  test('null is NOT the same as absent', () => {
    assert.throws(() => assertOptionalString(null, 'f'), /Invalid f/)
  })
  test('rejects a non-string that is present', () => {
    assert.throws(() => assertOptionalString(5, 'f'), /Invalid f/)
  })
})

describe('assertNumber', () => {
  test('accepts a finite number, bounds optional', () => {
    assert.doesNotThrow(() => assertNumber(5, 'n'))
    assert.doesNotThrow(() => assertNumber(5, 'n', 1, 10))
  })
  test('rejects NaN and Infinity, which are typeof number', () => {
    assert.throws(() => assertNumber(NaN, 'n'), /expected number/)
    assert.throws(() => assertNumber(Infinity, 'n'), /expected number/)
  })
  test('enforces each bound independently', () => {
    assert.throws(() => assertNumber(0, 'n', 1), /must be >= 1/)
    assert.throws(() => assertNumber(11, 'n', undefined, 10), /must be <= 10/)
  })
  test('a numeric string is not a number', () => {
    assert.throws(() => assertNumber('5', 'n'), /expected number/)
  })
})

describe('assertSentAddress', () => {
  test('accepts the three bech32 prefixes the app deals in', () => {
    assert.doesNotThrow(() => assertSentAddress('sent1' + 'a'.repeat(38), 'addr'))
    assert.doesNotThrow(() => assertSentAddress('sentnode1' + 'a'.repeat(38), 'addr'))
    assert.doesNotThrow(() => assertSentAddress('sentprov1' + 'a'.repeat(38), 'addr'))
  })
  test('rejects another chain, and a too-short body', () => {
    assert.throws(() => assertSentAddress('cosmos1' + 'a'.repeat(38), 'addr'), /not a valid wallet address/)
    assert.throws(() => assertSentAddress('sent1' + 'a'.repeat(10), 'addr'), /not a valid wallet address/)
  })
  test('rejects uppercase and the bech32 separator being absent', () => {
    assert.throws(() => assertSentAddress('SENT1' + 'a'.repeat(38), 'addr'), /not a valid wallet address/)
    assert.throws(() => assertSentAddress('sent' + 'a'.repeat(38), 'addr'), /not a valid wallet address/)
  })
  test('it is assertString first, so empty fails with that message', () => {
    assert.throws(() => assertSentAddress('', 'addr'), /expected non-empty string/)
  })
})

describe('assertIntRange', () => {
  test('accepts the inclusive bounds', () => {
    assert.doesNotThrow(() => assertIntRange(1, 'n', 1, 10))
    assert.doesNotThrow(() => assertIntRange(10, 'n', 1, 10))
  })
  test('rejects outside the range', () => {
    assert.throws(() => assertIntRange(0, 'n', 1, 10), /between 1 and 10/)
    assert.throws(() => assertIntRange(11, 'n', 1, 10), /between 1 and 10/)
  })
  test('rejects a non-integer inside the range', () => {
    assert.throws(() => assertIntRange(1.5, 'n', 1, 10), /expected integer/)
  })
  test('rejects NaN rather than letting the comparison decide', () => {
    assert.throws(() => assertIntRange(NaN, 'n', 1, 10), /expected integer/)
  })
})
