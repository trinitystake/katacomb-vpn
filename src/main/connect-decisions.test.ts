import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFailureMessage, decideReconnect, backoffDelayMs } from './connect-decisions.ts'

// --- sessionFailureMessage ---

test('sessionFailureMessage: not refunded surfaces the session id and manual-cancel steps', () => {
  const msg = sessionFailureMessage({
    refunded: false, isDeposit: true, sessionId: '4242', nodeMoniker: 'nodeA',
    reason: 'boom', policyRejected: false,
  })
  assert.match(msg, /#4242/)
  assert.match(msg, /cancel .*manually/i)
  assert.doesNotMatch(msg, /refunded/i)
})

test('sessionFailureMessage: refunded deposit says deposit refunded, no session id', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: true, sessionId: '4242', nodeMoniker: 'nodeA',
    reason: 'boom', policyRejected: false,
  })
  assert.match(msg, /deposit refunded/i)
  assert.doesNotMatch(msg, /#4242/)
})

test('sessionFailureMessage: refunded plan (non-deposit) omits deposit wording and session id', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: false, sessionId: '4242', nodeMoniker: 'nodeA',
    reason: 'boom', policyRejected: false,
  })
  assert.match(msg, /cancelled/i)
  assert.doesNotMatch(msg, /deposit/i)
  assert.doesNotMatch(msg, /#4242/)
})

test('sessionFailureMessage: policy rejection uses the VLess-none preamble', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: true, sessionId: '1', nodeMoniker: 'nodeA',
    reason: 'ignored', policyRejected: true,
  })
  assert.match(msg, /VLess-none/i)
  assert.match(msg, /nodeA/)
})

test('sessionFailureMessage: generic failure includes the underlying reason', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: true, sessionId: '1', nodeMoniker: 'nodeA',
    reason: 'connection refused', policyRejected: false,
  })
  assert.match(msg, /connection refused/)
  assert.doesNotMatch(msg, /VLess-none/i)
})

// --- decideReconnect ---

const base = { attempt: 0, maxAttempts: 5, autoReconnect: true, intentional: false, hasSession: true }

test('decideReconnect: aborts when there is no active session', () => {
  assert.deepEqual(decideReconnect({ ...base, hasSession: false }), { action: 'abort' })
})

test('decideReconnect: aborts on an intentional disconnect', () => {
  assert.deepEqual(decideReconnect({ ...base, intentional: true }), { action: 'abort' })
})

test('decideReconnect: aborts when auto-reconnect is off', () => {
  assert.deepEqual(decideReconnect({ ...base, autoReconnect: false }), { action: 'abort' })
})

test('decideReconnect: gives up once the next attempt would exceed the max', () => {
  assert.deepEqual(decideReconnect({ ...base, attempt: 5, maxAttempts: 5 }), { action: 'give-up' })
})

test('decideReconnect: retries with the incremented attempt and its backoff', () => {
  assert.deepEqual(decideReconnect({ ...base, attempt: 0 }), { action: 'retry', attempt: 1, delayMs: 2000 })
})

test('decideReconnect: abort takes precedence over give-up', () => {
  assert.deepEqual(
    decideReconnect({ ...base, attempt: 5, maxAttempts: 5, intentional: true }),
    { action: 'abort' },
  )
})

// --- backoffDelayMs ---

test('backoffDelayMs: exponential growth', () => {
  assert.equal(backoffDelayMs(1), 2000)
  assert.equal(backoffDelayMs(2), 4000)
  assert.equal(backoffDelayMs(5), 32000)
})

test('backoffDelayMs: capped at 60000', () => {
  assert.equal(backoffDelayMs(6), 60000)
  assert.equal(backoffDelayMs(10), 60000)
})
