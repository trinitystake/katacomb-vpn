import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TimeoutError } from '@cosmjs/stargate'
import { INSUFFICIENT_FUNDS } from '../shared/error-markers.ts'
import { FUNDS_MESSAGE, assertTxSucceeded, broadcastOrTimeout, isChainNotFound, isInsufficientFundsFailure, isSessionNotActive } from './tx-utils.ts'

test('the inlined marker prefix has not drifted from the shared one', () => {
  assert.ok(FUNDS_MESSAGE.startsWith(`${INSUFFICIENT_FUNDS}: `))
})

test('broadcastOrTimeout resolves with the value on success', async () => {
  assert.equal(await broadcastOrTimeout(Promise.resolve('ok'), 'msg'), 'ok')
})

test('broadcastOrTimeout rethrows a non-timeout error unchanged (same instance)', async () => {
  const boom = new Error('boom')
  await assert.rejects(broadcastOrTimeout(Promise.reject(boom), 'msg'), (e) => e === boom)
})

test('broadcastOrTimeout converts a CosmJS TimeoutError to the given message', async () => {
  await assert.rejects(
    broadcastOrTimeout(Promise.reject(new TimeoutError('timed out', 'ABC123')), 'check the Session tab'),
    /check the Session tab/,
  )
})

test('broadcastOrTimeout marks a simulate-time insufficient-funds rejection', async () => {
  // gas: 'auto' simulates first, so an unaffordable tx throws before any tx.code exists
  const err = new Error('Query failed with (18): insufficient funds: insufficient funds')
  await assert.rejects(broadcastOrTimeout(Promise.reject(err), 'timeout msg'), (e: Error) => {
    assert.ok(e.message.startsWith(INSUFFICIENT_FUNDS))
    return true
  })
})

test('isInsufficientFundsFailure matches the funds codes and the log text', () => {
  assert.equal(isInsufficientFundsFailure(5, ''), true)
  assert.equal(isInsufficientFundsFailure(11, ''), true)
  assert.equal(isInsufficientFundsFailure(13, ''), true)
  assert.equal(isInsufficientFundsFailure(undefined, 'out of gas in location: ReadFlat'), true)
  assert.equal(isInsufficientFundsFailure(32, 'account sequence mismatch'), false)
  assert.equal(isInsufficientFundsFailure(undefined, ''), false)
})

test('assertTxSucceeded passes a code-0 tx through', () => {
  assert.doesNotThrow(() => assertTxSucceeded({ code: 0, rawLog: '' }, 'Transaction'))
})

test('assertTxSucceeded marks an insufficient-funds rejection and hides the raw log', () => {
  assert.throws(
    () => assertTxSucceeded({ code: 5, rawLog: 'insufficient funds: 1udvpn < 5000000udvpn' }, 'Transaction'),
    (e: Error) => {
      assert.ok(e.message.startsWith(INSUFFICIENT_FUNDS))
      assert.doesNotMatch(e.message, /1udvpn/)
      return true
    },
  )
})

test('assertTxSucceeded keeps the raw code/log for any other failure', () => {
  assert.throws(
    () => assertTxSucceeded({ code: 32, rawLog: 'account sequence mismatch' }, 'End session'),
    (e: Error) => e.message === 'End session failed with code 32: account sequence mismatch',
  )
})

// The hub answers a missing single-record lookup by THROWING gRPC NotFound rather
// than returning nothing, so "I haven't registered a provider yet" — the normal
// case for almost every wallet — arrives as an error and has to be recognised.
test('isChainNotFound matches the real not-registered error the hub returns', () => {
  assert.ok(isChainNotFound(
    'Query failed with (22): rpc error: code = NotFound desc = provider ' +
    'sentprov1xpqgazzucgx29htzvqpc8cfga06z09yw9sd8nq does not exist: key not found',
  ))
  assert.ok(isChainNotFound('rpc error: code = NotFound desc = node does not exist: key not found'))
})

test('isChainNotFound does not swallow an unreachable RPC or any other failure', () => {
  // Mistaking either of these for "not registered" would tell the user they have
  // no provider when the truth is we could not ask.
  assert.equal(isChainNotFound('fetch failed'), false)
  assert.equal(isChainNotFound('Query failed with (6): rpc error: code = Unimplemented desc = : unknown request'), false)
  assert.equal(isChainNotFound('Query failed with (18): invalid request'), false)
  assert.equal(isChainNotFound('RPC connect timed out'), false)
})

// A session that exhausts its paid quota flips to inactive_pending on its own, and
// x/session refuses a cancel in any status but active — so "End" on a session that
// just ran out fails with this, verbatim from the bug report.
test('isSessionNotActive matches the status guard x/session rejects a late cancel with', () => {
  assert.ok(isSessionNotActive(
    'failed to execute message; message index: 0: invalid status inactive_pending ' +
    'for session 53089875: invalid session status ' +
    '[sentinel-official/sentinelhub/v12/x/session/types/errors.go:52]',
  ))
  assert.ok(isSessionNotActive('invalid status inactive for session 1: invalid session status'))
})

test('isSessionNotActive does not swallow an unrelated tx or query failure', () => {
  assert.equal(isSessionNotActive('account sequence mismatch'), false)
  assert.equal(isSessionNotActive('out of gas in location: ReadFlat'), false)
  assert.equal(isSessionNotActive('rpc error: code = NotFound desc = session does not exist'), false)
  assert.equal(isSessionNotActive('RPC connect timed out'), false)
  assert.equal(isSessionNotActive(''), false)
})
