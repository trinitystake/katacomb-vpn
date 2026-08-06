import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRpc,
  degradedReason,
  isChainUnreachable,
  isRpcConnectivityError,
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
  assert.equal(rpcHealthLabel(health('unknown')), 'RPC checking')
})

test('isChainUnreachable flags only down — a degraded endpoint still answered', () => {
  assert.equal(isChainUnreachable('down'), true)
  assert.equal(isChainUnreachable('degraded'), false)
  assert.equal(isChainUnreachable('suspended'), false)
  assert.equal(isChainUnreachable('ok'), false)
  assert.equal(isChainUnreachable('unknown'), false)
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
      'The transaction timed out before confirmation. It may still be processing — check ' +
        'the Session tab shortly and cancel any unexpected session to reclaim your funds.',
    ),
    false,
  )
})

test('isRpcConnectivityError does not swallow chain-level rejections', () => {
  assert.equal(isRpcConnectivityError('Transaction failed with code 32: account sequence mismatch'), false)
  assert.equal(isRpcConnectivityError('node handshake timed out after 20000ms'), false)
})
