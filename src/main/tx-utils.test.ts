import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TimeoutError } from '@cosmjs/stargate'
import { broadcastOrTimeout } from './tx-utils.ts'

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
