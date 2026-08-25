import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRpc,
  degradedReason,
  isChainUnreachable,
  isRpcConnectivityError,
  needsConfirmation,
  pickAutoRpc,
  pickBestRpc,
  rpcHealthLabel,
  rpcHostLabel,
  type RpcCandidate,
  type RpcHealth,
  type RpcProbe,
} from './rpc-health.ts'

function probe(over: Partial<RpcProbe> = {}): RpcProbe {
  return {
    reachable: true,
    latencyMs: 100,
    chainId: 'sentinelhub-2',
    height: 20_000_000,
    blockAgeSec: 5,
    error: null,
    ...over,
  }
}

test('classifyRpc: a fresh, fast, right-chain endpoint is ok', () => {
  assert.equal(classifyRpc(probe()), 'ok')
})

test('classifyRpc: unreachable is down', () => {
  assert.equal(
    classifyRpc(probe({ reachable: false, latencyMs: null, chainId: null, blockAgeSec: null, error: 'fetch failed' })),
    'down',
  )
})

test('classifyRpc: a different chain is down, not degraded', () => {
  assert.equal(classifyRpc(probe({ chainId: 'osmosis-1' })), 'down')
})

test('classifyRpc: latency boundary — 2499ms is ok, 2500ms is degraded', () => {
  assert.equal(classifyRpc(probe({ latencyMs: 2499 })), 'ok')
  assert.equal(classifyRpc(probe({ latencyMs: 2500 })), 'degraded')
})

test('classifyRpc: block-age boundary — 120s is ok, 121s is degraded', () => {
  assert.equal(classifyRpc(probe({ blockAgeSec: 120 })), 'ok')
  assert.equal(classifyRpc(probe({ blockAgeSec: 121 })), 'degraded')
})

test('classifyRpc: an unknown chain id (endpoint did not report one) does not fail the check', () => {
  assert.equal(classifyRpc(probe({ chainId: null })), 'ok')
})

test('degradedReason: lagging wins over slow when both apply', () => {
  assert.equal(degradedReason(probe({ blockAgeSec: 600, latencyMs: 4000 })), 'lagging')
  assert.equal(degradedReason(probe({ latencyMs: 4000 })), 'slow')
  assert.equal(degradedReason(probe()), null)
})

function health(state: RpcHealth['state'], over: Partial<RpcProbe> = {}): RpcHealth {
  return { state, endpoint: 'https://rpc.sentinel.co:443', checkedAt: 1, ...probe(over) }
}

test('rpcHealthLabel covers every state', () => {
  assert.equal(rpcHealthLabel(health('ok', { latencyMs: 142 })), 'RPC 142ms')
  assert.equal(rpcHealthLabel(health('degraded', { blockAgeSec: 900 })), 'RPC lagging')
  assert.equal(rpcHealthLabel(health('degraded', { latencyMs: 3000 })), 'RPC slow')
  assert.equal(rpcHealthLabel(health('down', { reachable: false })), 'RPC unreachable')
  // The reason is in the label, not only the tooltip: a bare grey "RPC paused"
  // is indistinguishable from a fault, and the user's first move was to blame
  // the endpoint and switch it.
  assert.equal(rpcHealthLabel(health('suspended')), 'RPC paused (VPN)')
  // Same reasoning as the pause: our own firewall is the cause, so name it.
  // Presented as a fault, the user's move is to switch endpoints, which cannot help.
  assert.equal(rpcHealthLabel(health('blocked')), 'RPC blocked (kill switch)')
  assert.equal(rpcHealthLabel(health('unknown')), 'RPC checking')
})

test('isChainUnreachable flags the states where the chain was not reached', () => {
  assert.equal(isChainUnreachable('down'), true)
  // Blocked queries DO fail — main returns empty lists, and "you have no
  // subscriptions" must not be how that reads. Unlike suspended, the handlers
  // do not short-circuit to the cache here: no tunnel is up.
  assert.equal(isChainUnreachable('blocked'), true)
  assert.equal(isChainUnreachable('degraded'), false)
  assert.equal(isChainUnreachable('suspended'), false)
  assert.equal(isChainUnreachable('ok'), false)
  assert.equal(isChainUnreachable('unknown'), false)
})

test('needsConfirmation holds a NEW fault, publishes a healthy reading immediately', () => {
  // The reading that started this: the probe fired the instant the tunnel came
  // down measured the local path being restored, and "RPC slow" was published
  // about an endpoint that answers in ~400ms.
  assert.equal(needsConfirmation('degraded', 'suspended'), true)
  assert.equal(needsConfirmation('down', 'suspended'), true)
  assert.equal(needsConfirmation('degraded', 'ok'), true)
  assert.equal(needsConfirmation('down', 'unknown'), true)
  // Good news is never delayed — there is nothing to be wrong about.
  assert.equal(needsConfirmation('ok', 'suspended'), false)
  assert.equal(needsConfirmation('ok', 'down'), false)
})

test('needsConfirmation does not re-confirm an endpoint already published as faulty', () => {
  // Already accused: further bad readings just refresh the figures, and holding
  // them would strand the pill on a stale latency.
  assert.equal(needsConfirmation('down', 'down'), false)
  assert.equal(needsConfirmation('degraded', 'degraded'), false)
  assert.equal(needsConfirmation('down', 'degraded'), false)
  assert.equal(needsConfirmation('degraded', 'down'), false)
})

test('rpcHostLabel strips scheme, default port and trailing slash', () => {
  assert.equal(rpcHostLabel('https://rpc.sentinel.co:443'), 'rpc.sentinel.co')
  assert.equal(rpcHostLabel('https://rpc.example.org/'), 'rpc.example.org')
  assert.equal(rpcHostLabel('http://10.0.0.1:26657'), '10.0.0.1:26657')
})

function candidate(endpoint: string, over: Partial<RpcProbe> = {}, aggregatorHealthy?: boolean): RpcCandidate {
  return { endpoint, probe: probe(over), aggregatorHealthy }
}

test('pickBestRpc prefers a healthy endpoint over a faster degraded one', () => {
  const best = pickBestRpc(
    [candidate('https://lagging', { latencyMs: 10, blockAgeSec: 900 }), candidate('https://good', { latencyMs: 300 })],
    'https://current',
  )
  assert.equal(best?.endpoint, 'https://good')
})

test('pickBestRpc falls back to the fastest degraded endpoint when none are healthy', () => {
  const best = pickBestRpc(
    [
      candidate('https://slow', { latencyMs: 4000 }),
      candidate('https://slower', { latencyMs: 9000 }),
      candidate('https://dead', { reachable: false }),
    ],
    'https://current',
  )
  assert.equal(best?.endpoint, 'https://slow')
})

test('pickBestRpc never returns the endpoint already in use', () => {
  const best = pickBestRpc(
    [candidate('https://current', { latencyMs: 1 }), candidate('https://other', { latencyMs: 500 })],
    'https://current',
  )
  assert.equal(best?.endpoint, 'https://other')
})

test('pickBestRpc skips endpoints the aggregator already reports as failing', () => {
  const best = pickBestRpc(
    [candidate('https://flagged', { latencyMs: 1 }, false), candidate('https://ok', { latencyMs: 500 }, true)],
    'https://current',
  )
  assert.equal(best?.endpoint, 'https://ok')
})

test('pickBestRpc returns null when nothing usable is left', () => {
  assert.equal(pickBestRpc([candidate('https://dead', { reachable: false })], 'https://current'), null)
  assert.equal(pickBestRpc([], 'https://current'), null)
})

// ---- pickAutoRpc (Smart RPC's selection rule) ----
// The probe() factory's height is 20_000_000, so that is the consensus height
// unless a test says otherwise.

test('pickAutoRpc keeps a healthy current endpoint within the margin', () => {
  const target = pickAutoRpc(
    [candidate('https://current', { latencyMs: 400 }), candidate('https://faster', { latencyMs: 200 })],
    'https://current',
  )
  assert.equal(target, null)
})

test('pickAutoRpc margin boundary: a win of exactly the margin keeps, one more switches', () => {
  const keep = pickAutoRpc(
    [candidate('https://current', { latencyMs: 450 }), candidate('https://faster', { latencyMs: 200 })],
    'https://current',
  )
  assert.equal(keep, null)
  const switched = pickAutoRpc(
    [candidate('https://current', { latencyMs: 451 }), candidate('https://faster', { latencyMs: 200 })],
    'https://current',
  )
  assert.equal(switched, 'https://faster')
})

test('pickAutoRpc switches away from an unreachable current to the fastest healthy candidate', () => {
  const target = pickAutoRpc(
    [
      candidate('https://current', { reachable: false, latencyMs: null, chainId: null, height: null, blockAgeSec: null }),
      candidate('https://slower', { latencyMs: 700 }),
      candidate('https://fast', { latencyMs: 150 }),
    ],
    'https://current',
  )
  assert.equal(target, 'https://fast')
})

test('pickAutoRpc height consensus outranks speed: a fast current far behind the pack loses', () => {
  const target = pickAutoRpc(
    [
      candidate('https://current', { latencyMs: 50, height: 20_000_000 - 20 }),
      candidate('https://intime', { latencyMs: 300, height: 20_000_000 }),
    ],
    'https://current',
  )
  assert.equal(target, 'https://intime')
})

test('pickAutoRpc height boundary: tolerance blocks behind is selectable, one more is not', () => {
  const within = pickAutoRpc(
    [
      candidate('https://current', { reachable: false, latencyMs: null, height: null }),
      candidate('https://near', { latencyMs: 50, height: 20_000_000 - 10 }),
      candidate('https://tall', { latencyMs: 500, height: 20_000_000 }),
    ],
    'https://current',
  )
  assert.equal(within, 'https://near')
  const beyond = pickAutoRpc(
    [
      candidate('https://current', { reachable: false, latencyMs: null, height: null }),
      candidate('https://near', { latencyMs: 50, height: 20_000_000 - 11 }),
      candidate('https://tall', { latencyMs: 500, height: 20_000_000 }),
    ],
    'https://current',
  )
  assert.equal(beyond, 'https://tall')
})

test('pickAutoRpc never selects a wrong-chain or unidentified candidate, even the fastest', () => {
  const target = pickAutoRpc(
    [
      candidate('https://current', { reachable: false, latencyMs: null, height: null }),
      candidate('https://wrongchain', { latencyMs: 10, chainId: 'osmosis-1' }),
      candidate('https://nochain', { latencyMs: 20, chainId: null }),
      candidate('https://good', { latencyMs: 900 }),
    ],
    'https://current',
  )
  assert.equal(target, 'https://good')
})

test('pickAutoRpc never selects an aggregator-flagged or heightless candidate', () => {
  const target = pickAutoRpc(
    [
      candidate('https://current', { reachable: false, latencyMs: null, height: null }),
      candidate('https://flagged', { latencyMs: 10 }, false),
      candidate('https://noheight', { latencyMs: 20, height: null }),
      candidate('https://good', { latencyMs: 900 }),
    ],
    'https://current',
  )
  assert.equal(target, 'https://good')
})

test('pickAutoRpc falls back to a slow qualifying candidate when current is down and nothing is healthy', () => {
  const target = pickAutoRpc(
    [
      candidate('https://current', { reachable: false, latencyMs: null, height: null }),
      candidate('https://slow', { latencyMs: 3000 }),
    ],
    'https://current',
  )
  assert.equal(target, 'https://slow')
})

test('pickAutoRpc: a degraded current does not hop to another degraded candidate', () => {
  // Covers the chain-halted case too: when every endpoint lags together the
  // consensus is relative, everything qualifies, and hopping buys nothing.
  const target = pickAutoRpc(
    [
      candidate('https://current', { blockAgeSec: 600 }),
      candidate('https://alsolagging', { latencyMs: 10, blockAgeSec: 600 }),
    ],
    'https://current',
  )
  assert.equal(target, null)
})

test('pickAutoRpc: a degraded current does switch to a healthy candidate', () => {
  const target = pickAutoRpc(
    [candidate('https://current', { latencyMs: 2600 }), candidate('https://good', { latencyMs: 300 })],
    'https://current',
  )
  assert.equal(target, 'https://good')
})

test('pickAutoRpc returns null on an empty list, when nothing else qualifies, and when no height is known', () => {
  assert.equal(pickAutoRpc([], 'https://current'), null)
  assert.equal(
    pickAutoRpc(
      [candidate('https://current'), candidate('https://dead', { reachable: false, latencyMs: null, height: null })],
      'https://current',
    ),
    null,
  )
  // No probed height at all: consensus is impossible, so nothing qualifies.
  assert.equal(
    pickAutoRpc(
      [candidate('https://current', { height: null }), candidate('https://other', { height: null })],
      'https://current',
    ),
    null,
  )
})

test('pickAutoRpc switches when the current endpoint is absent from the candidate list', () => {
  const target = pickAutoRpc([candidate('https://other', { latencyMs: 200 })], 'https://current')
  assert.equal(target, 'https://other')
})

test('pickAutoRpc never returns the current endpoint itself', () => {
  assert.equal(pickAutoRpc([candidate('https://current', { latencyMs: 1 })], 'https://current'), null)
})

test('isRpcConnectivityError matches the shapes these calls actually produce', () => {
  assert.ok(isRpcConnectivityError('RPC connect timed out after 10000ms'))
  assert.ok(isRpcConnectivityError('fetch failed'))
  assert.ok(isRpcConnectivityError('connect ECONNREFUSED 127.0.0.1:443'))
  assert.ok(isRpcConnectivityError('getaddrinfo ENOTFOUND rpc.example.org'))
  assert.ok(isRpcConnectivityError('socket hang up'))
  assert.ok(isRpcConnectivityError('RPC returned 502'))
})

// The shape @cosmjs/tendermint-rpc actually throws (filterBadStatus). Missing it
// meant a rate-limited endpoint surfaced raw in the connect modal.
test('isRpcConnectivityError matches cosmjs bad-status errors, but only the "endpoint refused us" codes', () => {
  assert.ok(isRpcConnectivityError('Bad status on response: 429'))
  assert.ok(isRpcConnectivityError('Bad status on response: 503'))
  // 400 is the chain rejecting the request, not an unreachable endpoint.
  assert.equal(isRpcConnectivityError('Bad status on response: 400'), false)
  assert.equal(isRpcConnectivityError('Bad status on response: 404'), false)
})

test('isRpcConnectivityError does NOT match a broadcast timeout — that tx may have landed', () => {
  assert.equal(
    isRpcConnectivityError(
      'The transaction timed out before confirmation. It may still be processing. Check ' +
        'the Session tab shortly and cancel any unexpected session to reclaim your funds.',
    ),
    false,
  )
})

test('isRpcConnectivityError does not swallow chain-level rejections', () => {
  assert.equal(isRpcConnectivityError('Transaction failed with code 32: account sequence mismatch'), false)
  assert.equal(isRpcConnectivityError('node handshake timed out after 20000ms'), false)
})
