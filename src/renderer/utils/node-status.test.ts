import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeStatusMeta, nodeStatusRank, isNodeConnectable } from './node-status.ts'

// The real shapes the node-list API returns, one per observed combination.
const HEALTHY = { isActive: true, isHealthy: true, errorMessage: null }
const UNHEALTHY = { isActive: true, isHealthy: false, errorMessage: 'VPN connect failed' }
const INACTIVE = { isActive: false, isHealthy: false, errorMessage: 'Inactive node' }

test('an active node failing the health check is NOT labelled Inactive', () => {
  const meta = nodeStatusMeta(UNHEALTHY)
  assert.equal(meta.state, 'unhealthy')
  assert.equal(meta.label, 'Unhealthy')
  assert.notEqual(meta.label, 'Inactive')
  // The reason the aggregator gave must reach the user.
  assert.match(meta.detail, /VPN connect failed/)
  assert.match(meta.detail, /Active on-chain/)
})

test('the three states get three distinct labels and dots', () => {
  const labels = [HEALTHY, UNHEALTHY, INACTIVE].map((n) => nodeStatusMeta(n).label)
  assert.deepEqual(labels, ['Active', 'Unhealthy', 'Inactive'])
  const dots = [HEALTHY, UNHEALTHY, INACTIVE].map((n) => nodeStatusMeta(n).dotClass)
  assert.deepEqual(new Set(dots).size, 3)
})

test('an inactive node does not repeat the redundant upstream message', () => {
  const meta = nodeStatusMeta(INACTIVE)
  assert.equal(meta.state, 'inactive')
  assert.doesNotMatch(meta.detail, /Inactive node/)
})

test('a missing health reason still yields a complete sentence', () => {
  const meta = nodeStatusMeta({ isActive: true, isHealthy: false, errorMessage: null })
  assert.equal(meta.state, 'unhealthy')
  assert.match(meta.detail, /health check failed\.$/)
  // An all-whitespace message is treated as absent, not interpolated raw.
  assert.match(nodeStatusMeta({ ...UNHEALTHY, errorMessage: '   ' }).detail, /health check failed\.$/)
})

test('rank orders healthy > unhealthy > inactive', () => {
  assert.ok(nodeStatusRank(HEALTHY) > nodeStatusRank(UNHEALTHY))
  assert.ok(nodeStatusRank(UNHEALTHY) > nodeStatusRank(INACTIVE))
})

test('only a node passing both checks is connectable', () => {
  assert.equal(isNodeConnectable(HEALTHY), true)
  assert.equal(isNodeConnectable(UNHEALTHY), false)
  assert.equal(isNodeConnectable(INACTIVE), false)
  // An unregistered node is never connectable, even if flagged healthy.
  assert.equal(isNodeConnectable({ isActive: false, isHealthy: true, errorMessage: null }), false)
})
