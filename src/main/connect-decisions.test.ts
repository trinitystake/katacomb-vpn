import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFailureMessage, decideReconnect, backoffDelayMs, serviceTypeToNodeType } from './connect-decisions.ts'

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

// --- serviceTypeToNodeType ---

test('serviceTypeToNodeType: canonical names', () => {
  assert.equal(serviceTypeToNodeType('wireguard'), 1)
  assert.equal(serviceTypeToNodeType('v2ray'), 2)
  assert.equal(serviceTypeToNodeType('openvpn'), 3)
  assert.equal(serviceTypeToNodeType('xray'), 4)
  assert.equal(serviceTypeToNodeType('amneziawg'), 5)
  assert.equal(serviceTypeToNodeType('hysteria2'), 6)
})

test('serviceTypeToNodeType: separator and case variants nodes actually report', () => {
  assert.equal(serviceTypeToNodeType('WireGuard'), 1)
  assert.equal(serviceTypeToNodeType('wire_guard'), 1)
  assert.equal(serviceTypeToNodeType('V2Ray'), 2)
  assert.equal(serviceTypeToNodeType('open-vpn'), 3)
  assert.equal(serviceTypeToNodeType('amnezia_wg'), 5)
  assert.equal(serviceTypeToNodeType('Amnezia WG'), 5)
  assert.equal(serviceTypeToNodeType('awg'), 5)
  assert.equal(serviceTypeToNodeType('HYSTERIA2'), 6)
  assert.equal(serviceTypeToNodeType('hysteria_2'), 6)
  assert.equal(serviceTypeToNodeType('hy2'), 6)
})

test('serviceTypeToNodeType: numeric passthrough only inside 1-6', () => {
  assert.equal(serviceTypeToNodeType(1), 1)
  assert.equal(serviceTypeToNodeType(6), 6)
  assert.equal(serviceTypeToNodeType('4'), 4)
  assert.equal(serviceTypeToNodeType(0), null)
  assert.equal(serviceTypeToNodeType(7), null)
  assert.equal(serviceTypeToNodeType(1.5), null)
})

test('serviceTypeToNodeType: unknown or malformed input is null', () => {
  assert.equal(serviceTypeToNodeType('shadowsocks'), null)
  assert.equal(serviceTypeToNodeType(''), null)
  assert.equal(serviceTypeToNodeType(undefined), null)
  assert.equal(serviceTypeToNodeType(null), null)
  assert.equal(serviceTypeToNodeType({}), null)
  assert.equal(serviceTypeToNodeType(['wireguard']), null)
})
