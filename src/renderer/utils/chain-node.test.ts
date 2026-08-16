import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chainRowRank,
  chainRowState,
  isChainable,
  isCheckable,
  isVerifiedFor,
  majorVersion,
  udvpnPrice,
} from './chain-node.ts'
import type { ChainEligibility, SentNode } from '../types'

const node = (over: Partial<SentNode>): SentNode => ({
  address: 'sentnode1aaa', moniker: 'n', version: '9.0.0', type: 2, connection: null,
  api: '1.2.3.4:8080', asn: '12345', country: 'Germany', city: '', isResidential: false,
  isActive: true, isHealthy: true, isDuplicate: false, isWhitelisted: false,
  gigabytePrices: [], hourlyPrices: [], leases: 0, sessions: 0, peers: 0,
  errorMessage: null, fetchedAt: '', ...over,
})

const grade = (over: Partial<ChainEligibility>): ChainEligibility => ({
  nodeAddress: 'sentnode1aaa', checkedAt: 0, reachable: true, transports: ['tcp'],
  entry: true, exit: true, entrySecurity: 'tls', exitSecurity: 'tls', ...over,
})

test('isChainable takes only healthy, active v2ray and xray nodes', () => {
  assert.equal(isChainable(node({ type: 2 })), true)
  assert.equal(isChainable(node({ type: 4 })), true)
  // Every other protocol: proxySettings.tag has no equivalent, so they cannot chain.
  for (const type of [0, 1, 3, 5, 6]) {
    assert.equal(isChainable(node({ type })), false)
  }
  assert.equal(isChainable(node({ isActive: false })), false)
  assert.equal(isChainable(node({ isHealthy: false })), false)
})

test('majorVersion reads the leading number and gives up quietly', () => {
  assert.equal(majorVersion(node({ version: '9.0.0' })), 9)
  assert.equal(majorVersion(node({ version: '10.1.2' })), 10)
  assert.equal(majorVersion(node({ version: '8.3.1' })), 8)
  assert.equal(majorVersion(node({ version: '' })), 0)
  assert.equal(majorVersion(node({ version: 'unstable' })), 0)
  assert.equal(isCheckable(node({ version: '8.3.1' })), false)
  assert.equal(isCheckable(node({ version: '9.0.0' })), true)
})

test('udvpnPrice reads the udvpn quote for the billing type, or null', () => {
  const priced = node({
    gigabytePrices: [{ denom: 'udvpn', value: '40150000' }],
    hourlyPrices: [{ denom: 'other', value: '5' }],
  })
  assert.equal(udvpnPrice(priced, 'gigabytes'), 40150000)
  assert.equal(udvpnPrice(priced, 'hours'), null)
  assert.equal(udvpnPrice(node({}), 'gigabytes'), null)
})

// The three that must never be clickable. Each is a node the chain rule cannot
// confirm, and under that rule an unconfirmed node is a near-certain double refund
// rather than a maybe. Getting this wrong once cost a real pair of sessions.

test('a pre-9.0.0 node is listed but never selectable', () => {
  const state = chainRowState(node({ version: '8.3.1' }), undefined, 'entry')
  assert.equal(state.selectable, false)
  assert.equal(state.badge, 'v8.3.1')
  assert.equal(state.tone, 'muted')
})

test('a v9 node with no grade yet is never selectable', () => {
  for (const role of ['entry', 'exit'] as const) {
    const state = chainRowState(node({ version: '9.0.0' }), undefined, role)
    assert.equal(state.selectable, false)
    assert.equal(state.badge, 'checking…')
  }
})

test('a node that could not be reached is never selectable', () => {
  const state = chainRowState(node({}), grade({ reachable: false, transports: [], error: 'timeout' }), 'exit')
  assert.equal(state.selectable, false)
  assert.equal(state.badge, 'unknown')
  assert.equal(state.tone, 'warning')
  assert.equal(state.title, 'timeout')
})

test('a graded node that fails the rule is refused, per role', () => {
  const noTls = grade({ entry: false, exit: false, entrySecurity: null, exitSecurity: null, transports: ['grpc'] })
  assert.deepEqual(
    { ...chainRowState(node({}), noTls, 'entry') },
    {
      selectable: false,
      badge: 'no TLS',
      tone: 'danger',
      title: 'Serves grpc, but none of it is wrapped in TLS or Reality. Still fine for an ordinary single-hop connection.',
    },
  )
  assert.equal(chainRowState(node({}), noTls, 'exit').badge, 'no TLS/TCP')
})

test('an entry-only node is selectable as an entry and refused as an exit', () => {
  // Measured: grpc and websocket work as a direct hop but not when carried inside
  // another one, so a node without plain TCP is an entry and never an exit.
  const entryOnly = grade({ exit: false, exitSecurity: null, transports: ['grpc'] })
  assert.equal(chainRowState(node({}), entryOnly, 'entry').selectable, true)
  assert.equal(chainRowState(node({}), entryOnly, 'exit').selectable, false)
})

test('a verified row names the wrapping it would get', () => {
  const reality = grade({ entrySecurity: 'reality', exitSecurity: 'reality', transports: ['tcp', 'grpc'] })
  assert.deepEqual(
    { ...chainRowState(node({}), reality, 'exit') },
    {
      selectable: true,
      badge: 'TCP + Reality',
      tone: 'success',
      title: 'Serves tcp, grpc. This hop would be wrapped in Reality.',
    },
  )
  assert.equal(chainRowState(node({}), grade({}), 'entry').badge, 'TLS')
})

test('chainRowRank puts the pickable first and the uncheckable last', () => {
  const v9 = node({ version: '9.0.0' })
  assert.equal(chainRowRank(v9, grade({}), 'entry'), 0)                                  // verified
  assert.equal(chainRowRank(v9, undefined, 'entry'), 1)                                  // still checking
  assert.equal(chainRowRank(v9, grade({ reachable: false }), 'entry'), 2)                // did not answer
  assert.equal(chainRowRank(v9, grade({ entry: false, exit: false }), 'entry'), 3)       // refused
  assert.equal(chainRowRank(node({ version: '8.3.1' }), undefined, 'entry'), 4)          // too old
})

test('chainRowRank is scored per role, like the badge', () => {
  const entryOnly = grade({ exit: false, exitSecurity: null, transports: ['grpc'] })
  assert.equal(chainRowRank(node({}), entryOnly, 'entry'), 0)
  assert.equal(chainRowRank(node({}), entryOnly, 'exit'), 3)
})

test('rank 0 and selectable never disagree', () => {
  // The column sorts on the rank while the row is enabled on the state, so a split
  // between them would put unpickable rows at the top of a "best first" sort.
  const cases: [SentNode, ChainEligibility | undefined][] = [
    [node({ version: '8.3.1' }), undefined],
    [node({}), undefined],
    [node({}), grade({ reachable: false })],
    [node({}), grade({})],
    [node({}), grade({ entry: false, exit: false })],
    [node({}), grade({ exit: false })],
  ]
  for (const role of ['entry', 'exit'] as const) {
    for (const [n, g] of cases) {
      assert.equal(
        chainRowRank(n, g, role) === 0,
        chainRowState(n, g, role).selectable,
        `disagreed for ${role} on ${JSON.stringify(g)}`,
      )
    }
  }
})

test('isVerifiedFor answers only on a reachable grade for that end', () => {
  assert.equal(isVerifiedFor(undefined, 'entry'), false)
  assert.equal(isVerifiedFor(grade({ reachable: false }), 'entry'), false)
  assert.equal(isVerifiedFor(grade({ exit: false }), 'exit'), false)
  assert.equal(isVerifiedFor(grade({ exit: false }), 'entry'), true)
})
