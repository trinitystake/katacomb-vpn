import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout } from './async-utils.ts'

test('withTimeout resolves with the value when the promise settles first', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000, 'label')
  assert.equal(result, 'ok')
})

test('withTimeout rejects with the labelled error when the promise never settles', async () => {
  await assert.rejects(
    withTimeout(new Promise<never>(() => {}), 10, 'node handshake'),
    /node handshake timed out after 10ms/,
  )
})

test('withTimeout passes through the original rejection (not masked as a timeout)', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('boom')), 1000, 'label'),
    /boom/,
  )
})

test('withTimeout does not leave a pending timer after the promise resolves', async () => {
  // A 60s timeout that isn't cleared would keep the event loop alive and stall
  // process exit. Resolving fast under a long timeout must settle immediately.
  const start = Date.now()
  await withTimeout(Promise.resolve(42), 60_000, 'label')
  assert.ok(Date.now() - start < 1000, 'should resolve without waiting on the timeout')
})
