import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWalletExists } from './wallet-errors.ts'
import { WALLET_EXISTS } from './error-markers.ts'

test('the inlined marker has not drifted from the shared one', () => {
  assert.ok(parseWalletExists(`${WALLET_EXISTS}:abc: taken`))
})

test('parseWalletExists returns the id and the human message', () => {
  const parsed = parseWalletExists(
    'WALLET_EXISTS:0f8c1d2e-4a5b-6c7d-8e9f-001122334455: That seed is already stored as "Testing".',
  )
  assert.deepEqual(parsed, {
    id: '0f8c1d2e-4a5b-6c7d-8e9f-001122334455',
    message: 'That seed is already stored as "Testing".',
  })
})

test('parseWalletExists keeps colons that belong to the message', () => {
  const parsed = parseWalletExists('WALLET_EXISTS:abc: Stored as "A: B".')
  assert.equal(parsed?.id, 'abc')
  assert.equal(parsed?.message, 'Stored as "A: B".')
})

test('parseWalletExists ignores unrelated errors', () => {
  assert.equal(parseWalletExists('Wallet not found'), null)
  assert.equal(parseWalletExists(''), null)
})

test('parseWalletExists does not claim the other markers', () => {
  assert.equal(parseWalletExists('RPC_UNREACHABLE: Couldn\'t reach the blockchain at rpc.sentinel.co.'), null)
  assert.equal(parseWalletExists('INSUFFICIENT_FUNDS: Not enough P2P: this costs 5.00.'), null)
})

test('parseWalletExists rejects a malformed payload rather than inventing an id', () => {
  assert.equal(parseWalletExists('WALLET_EXISTS: no id here'), null)
  assert.equal(parseWalletExists('WALLET_EXISTS:abc-no-message'), null)
})
