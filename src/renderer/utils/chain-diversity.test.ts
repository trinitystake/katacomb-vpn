import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chainDiversityIssues,
  endpointHost,
  ipv4Slash24,
  sharedDomain,
  hasOperatorOverlap,
} from './chain-diversity.ts'
import type { SentNode } from '../types'

// Endpoints below are the real shapes the node list carries: bare `host:port`,
// IPv4 literals, and operator fleets under one domain (all observed 2026-08-14).
const node = (over: Partial<SentNode>): SentNode => ({
  address: 'sentnode1aaa', moniker: 'n', version: '9.0.0', type: 2, connection: null,
  api: '1.2.3.4:8080', asn: '12345', country: 'Germany', city: '', isResidential: false,
  isActive: true, isHealthy: true, isDuplicate: false, isWhitelisted: false,
  gigabytePrices: [], hourlyPrices: [], leases: 0, sessions: 0, peers: 0,
  errorMessage: null, fetchedAt: '', ...over,
})

test('endpointHost strips the port, the scheme and any path', () => {
  assert.equal(endpointHost('190.15.196.193:18407'), '190.15.196.193')
  assert.equal(endpointHost('https://nlv2.pytonode.my.id:23457/'), 'nlv2.pytonode.my.id')
  assert.equal(endpointHost('[2001:db8::1]:443'), '2001:db8::1')
  assert.equal(endpointHost(''), null)
  assert.equal(endpointHost(null), null)
})

test('ipv4Slash24 only answers for real IPv4 literals', () => {
  assert.equal(ipv4Slash24('190.15.196.193'), '190.15.196.0/24')
  assert.equal(ipv4Slash24('nlv2.pytonode.my.id'), null)
  assert.equal(ipv4Slash24('999.1.1.1'), null)
})

test('sharedDomain catches an operator fleet under one domain', () => {
  assert.equal(sharedDomain('nlv2.pytonode.my.id', 'hk2.pytonode.my.id'), 'pytonode.my.id')
  assert.equal(sharedDomain('a.example.com', 'b.example.com'), 'example.com')
})

test('sharedDomain needs both hosts to sit UNDER the shared part', () => {
  // Not "one is the domain the other is under" — that is one host, not two peers.
  assert.equal(sharedDomain('example.com', 'b.example.com'), null)
  // A single shared label is not a domain.
  assert.equal(sharedDomain('a.example.com', 'b.example.net'), null)
  assert.equal(sharedDomain('1.2.3.4', '1.2.9.9'), null, 'IPv4 is the subnet check, not this one')
})

test('two hops on one operator report ASN, subnet and country', () => {
  const issues = chainDiversityIssues(
    node({ api: '190.15.196.10:1', asn: '271898', country: 'Argentina' }),
    node({ api: '190.15.196.200:1', asn: '271898', country: 'Argentina' }),
  )
  assert.deepEqual(issues.map((i) => i.key), ['asn', 'subnet', 'country'])
  assert.equal(hasOperatorOverlap(issues), true)
})

test('two independent hops raise nothing', () => {
  const issues = chainDiversityIssues(
    node({ api: '91.149.243.171:9966', asn: '211252', country: 'Spain' }),
    node({ api: '45.87.173.26:4876', asn: '208556', country: 'Turkey' }),
  )
  assert.deepEqual(issues, [])
  assert.equal(hasOperatorOverlap(issues), false)
})

test('a shared country alone is a jurisdiction note, not an operator overlap', () => {
  const issues = chainDiversityIssues(
    node({ api: '1.1.1.1:1', asn: '111', country: 'Germany' }),
    node({ api: '2.2.2.2:1', asn: '222', country: 'Germany' }),
  )
  assert.deepEqual(issues.map((i) => i.key), ['country'])
  assert.equal(hasOperatorOverlap(issues), false, 'two German operators are still two operators')
})

test('a blank ASN or country is not treated as a match', () => {
  // The aggregator sends null for unknown text fields; normalizeNodes turns those
  // into '' (see node-normalize.ts), and '' === '' must not read as "same ASN".
  const issues = chainDiversityIssues(
    node({ api: '1.1.1.1:1', asn: '', country: '' }),
    node({ api: '2.2.2.2:1', asn: '', country: '' }),
  )
  assert.deepEqual(issues, [])
})
