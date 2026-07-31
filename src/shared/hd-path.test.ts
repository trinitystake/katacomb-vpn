import test from 'node:test'
import assert from 'node:assert/strict'
import { formatHdPath, COSMOS_COIN_TYPE } from './hd-path.ts'

test('the default wallet path is the Cosmos one', () => {
  assert.equal(formatHdPath(0, 0), "m/44'/118'/0'/0/0")
  assert.equal(COSMOS_COIN_TYPE, 118)
})

test('only the account level is hardened, and change stays 0', () => {
  assert.equal(formatHdPath(3, 7), "m/44'/118'/3'/0/7")
})

test('large indices are rendered verbatim, not in exponent form', () => {
  assert.equal(formatHdPath(2147483647, 2147483647), "m/44'/118'/2147483647'/0/2147483647")
})
