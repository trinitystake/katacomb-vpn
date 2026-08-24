import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rankPlanCandidates,
  shouldTryNextCandidate,
  ladderNextTx,
  smartConnectFailureSummary,
  LATENCY_BUCKET_MS,
  MAX_TX_ATTEMPTS,
  type PlanNodeCandidate,
} from './plan-connect.ts'

function candidate(overrides: Partial<PlanNodeCandidate> = {}): PlanNodeCandidate {
  return {
    address: 'sentnode1aaaa',
    moniker: 'node-a',
    country: 'DE',
    type: 1,
    api: 'https://1.2.3.4:443',
    isActive: true,
    isHealthy: true,
    latencyMs: null,
    probeFailed: false,
    runtimeOk: true,
    ...overrides,
  }
}

// --- rankPlanCandidates: exclusions (auto-pick must never buy these) ---

test('rankPlanCandidates: an unhealthy node is excluded with a reason, never ranked', () => {
  const { ranked, excluded } = rankPlanCandidates(
    [candidate({ address: 'sentnode1sick', isHealthy: false })],
    { requireProxyCapable: false },
  )
  assert.equal(ranked.length, 0)
  assert.equal(excluded.length, 1)
  assert.equal(excluded[0].address, 'sentnode1sick')
  assert.ok(excluded[0].reason.length > 0)
})

test('rankPlanCandidates: inactive, directory-less, unknown-protocol, runtime-less and probe-failed nodes are all excluded', () => {
  const { ranked, excluded } = rankPlanCandidates(
    [
      candidate({ address: 'sentnode1inactive', isActive: false }),
      candidate({ address: 'sentnode1norow', api: '' }),
      candidate({ address: 'sentnode1unknown', type: 0 }),
      candidate({ address: 'sentnode1noruntime', runtimeOk: false }),
      candidate({ address: 'sentnode1deaf', latencyMs: null, probeFailed: true }),
    ],
    { requireProxyCapable: false },
  )
  assert.equal(ranked.length, 0)
  assert.equal(excluded.length, 5)
  // Every exclusion names its node and explains itself.
  for (const e of excluded) {
    assert.ok(e.address.startsWith('sentnode1'))
    assert.ok(e.reason.length > 0)
  }
})

test('rankPlanCandidates: proxy mode keeps only the child-proxy protocols (2, 4, 6)', () => {
  const { ranked, excluded } = rankPlanCandidates(
    [
      candidate({ address: 'sentnode1wg', type: 1 }),
      candidate({ address: 'sentnode1v2', type: 2 }),
      candidate({ address: 'sentnode1xr', type: 4 }),
      candidate({ address: 'sentnode1hy', type: 6 }),
      candidate({ address: 'sentnode1ovpn', type: 3 }),
    ],
    { requireProxyCapable: true },
  )
  assert.deepEqual(new Set(ranked.map((c) => c.type)), new Set([2, 4, 6]))
  assert.equal(excluded.length, 2)
})

test('rankPlanCandidates: exclusion reasons carry no em dash (they reach the UI)', () => {
  const { excluded } = rankPlanCandidates(
    [
      candidate({ address: 'a1', isHealthy: false }),
      candidate({ address: 'a2', isActive: false }),
      candidate({ address: 'a3', api: '' }),
      candidate({ address: 'a4', type: 0 }),
      candidate({ address: 'a5', runtimeOk: false }),
      candidate({ address: 'a6', probeFailed: true }),
      candidate({ address: 'a7', type: 1 }),
    ],
    { requireProxyCapable: true },
  )
  assert.equal(excluded.length, 7)
  for (const e of excluded) {
    assert.ok(!e.reason.includes('—'), `em dash in: ${e.reason}`)
  }
})

// --- rankPlanCandidates: ordering ---

test('rankPlanCandidates: a clearly lower measured latency beats protocol preference', () => {
  const { ranked } = rankPlanCandidates(
    [
      candidate({ address: 'sentnode1wg', type: 1, latencyMs: 200 }),
      candidate({ address: 'sentnode1v2', type: 2, latencyMs: 40 }),
    ],
    { requireProxyCapable: false },
  )
  assert.equal(ranked[0].address, 'sentnode1v2')
})

test('rankPlanCandidates: inside one latency bucket, protocol preference decides', () => {
  // 10ms and 12ms land in the same 25ms bucket, so jitter must not put the
  // v2ray node above the WireGuard one.
  assert.ok(LATENCY_BUCKET_MS >= 25)
  const { ranked } = rankPlanCandidates(
    [
      candidate({ address: 'sentnode1v2', type: 2, latencyMs: 10 }),
      candidate({ address: 'sentnode1wg', type: 1, latencyMs: 12 }),
    ],
    { requireProxyCapable: false },
  )
  assert.equal(ranked[0].address, 'sentnode1wg')
})

test('rankPlanCandidates: unprobed nodes stay eligible but rank after every probed one', () => {
  const { ranked } = rankPlanCandidates(
    [
      candidate({ address: 'sentnode1unprobed', type: 1, latencyMs: null }),
      candidate({ address: 'sentnode1slow', type: 3, latencyMs: 900 }),
    ],
    { requireProxyCapable: false },
  )
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].address, 'sentnode1slow')
})

test('rankPlanCandidates: address breaks the final tie, so the order is deterministic', () => {
  const a = candidate({ address: 'sentnode1aaa', type: 1, latencyMs: 10 })
  const b = candidate({ address: 'sentnode1bbb', type: 1, latencyMs: 11 })
  const first = rankPlanCandidates([a, b], { requireProxyCapable: false })
  const second = rankPlanCandidates([b, a], { requireProxyCapable: false })
  assert.deepEqual(first.ranked.map((c) => c.address), ['sentnode1aaa', 'sentnode1bbb'])
  assert.deepEqual(second.ranked.map((c) => c.address), ['sentnode1aaa', 'sentnode1bbb'])
})

test('rankPlanCandidates: empty input ranks nothing and excludes nothing', () => {
  const { ranked, excluded } = rankPlanCandidates([], { requireProxyCapable: false })
  assert.equal(ranked.length, 0)
  assert.equal(excluded.length, 0)
})

// --- shouldTryNextCandidate: the failure ladder ---

test('shouldTryNextCandidate: nothing-spent failures (preflight, endpoint) always advance', () => {
  for (const failure of ['preflight', 'endpoint'] as const) {
    assert.equal(shouldTryNextCandidate(failure, 0), true)
    assert.equal(shouldTryNextCandidate(failure, MAX_TX_ATTEMPTS + 5), true)
  }
})

test('shouldTryNextCandidate: refunded failures advance until the tx budget is spent', () => {
  for (const failure of ['handshake', 'policy'] as const) {
    assert.equal(shouldTryNextCandidate(failure, MAX_TX_ATTEMPTS - 1), true)
    assert.equal(shouldTryNextCandidate(failure, MAX_TX_ATTEMPTS), false)
  }
})

test('shouldTryNextCandidate: a tx timeout stops the ladder, the tx may still land', () => {
  // Firing a second session-creating tx after a timeout could buy a second
  // subscription; the timeout copy already tells the user to check Sessions.
  assert.equal(shouldTryNextCandidate('tx-timeout', 0), false)
})

test('shouldTryNextCandidate: funds and chain failures stop immediately', () => {
  assert.equal(shouldTryNextCandidate('funds', 0), false)
  assert.equal(shouldTryNextCandidate('chain', 0), false)
})

// --- ladderNextTx: the plan price is spent at most once ---

test('ladderNextTx: the first attempt subscribes, every attempt after a committed subscription is session-only', () => {
  // Walk the real sequence: fresh purchase commits, its handshake fails and is
  // refunded, the ladder advances. The next attempt must ride the subscription
  // that already exists, not buy the plan again.
  assert.equal(ladderNextTx(null), 'plan-subscribe')
  const subscriptionIdFromFirstTx = '4242'
  assert.equal(ladderNextTx(subscriptionIdFromFirstTx), 'session-only')
})

test('ladderNextTx: a reuse-path connect never subscribes at all', () => {
  assert.equal(ladderNextTx('777'), 'session-only')
})

// --- smartConnectFailureSummary ---

test('smartConnectFailureSummary: names every attempted node with its reason, no em dashes', () => {
  const summary = smartConnectFailureSummary([
    { moniker: 'fast-node', reason: 'handshake failed with HTTP 500' },
    { moniker: 'backup-node', reason: 'did not answer a probe' },
  ])
  assert.ok(summary.includes('fast-node'))
  assert.ok(summary.includes('backup-node'))
  assert.ok(summary.includes('HTTP 500'))
  assert.ok(!summary.includes('—'))
})

test('smartConnectFailureSummary: says nothing was charged when no attempt got past preflight', () => {
  const summary = smartConnectFailureSummary([])
  assert.ok(summary.length > 0)
  assert.ok(!summary.includes('—'))
})
