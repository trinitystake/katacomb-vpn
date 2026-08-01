import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNodes, parseNodesPage } from './node-normalize.ts'

// A real entry from api.sentnodes.com — one of the ~10 leasable nodes whose
// moniker and country are null. Searching the provider console's node picker
// used to call .toLowerCase() on those and crash the renderer.
const NULL_HEAVY = {
  address: 'sentnode1846yvvugfh8358vr3yxtf5p437m8un4rv6zp6a',
  moniker: null,
  version: null,
  type: 0,
  connection: null,
  api: null,
  asn: null,
  country: null,
  city: null,
  isResidential: null,
  isActive: true,
  hourlyPrices: [{ denom: 'udvpn', value: '1000000' }],
  errorMessage: null,
}

test('null text fields become empty strings', () => {
  const [node] = normalizeNodes([NULL_HEAVY]) as Record<string, unknown>[]
  for (const field of ['moniker', 'version', 'api', 'asn', 'country', 'city']) {
    assert.equal(node[field], '', `${field} should be ''`)
  }
  // Every one of them is now safe to treat as the string the type promises.
  assert.doesNotThrow(() => (node.country as string).toLowerCase())
})

test('non-text fields are left exactly as they are', () => {
  const [node] = normalizeNodes([NULL_HEAVY]) as Record<string, unknown>[]
  assert.equal(node.connection, null)
  assert.equal(node.errorMessage, null)
  assert.equal(node.isResidential, null)
  assert.equal(node.isActive, true)
  assert.equal(node.type, 0)
  assert.deepEqual(node.hourlyPrices, [{ denom: 'udvpn', value: '1000000' }])
})

test('present values are not touched, and the input is not mutated', () => {
  const original = { address: 'sentnode1abc', moniker: 'ONION-GB-03', country: 'United Kingdom', city: 'Worcester' }
  const [node] = normalizeNodes([original]) as Record<string, unknown>[]
  assert.equal(node.moniker, 'ONION-GB-03')
  assert.equal(node.country, 'United Kingdom')
  assert.equal(node.city, 'Worcester')
  assert.deepEqual(original, { address: 'sentnode1abc', moniker: 'ONION-GB-03', country: 'United Kingdom', city: 'Worcester' })
})

test('a missing field is filled in too, not just an explicit null', () => {
  const [node] = normalizeNodes([{ address: 'sentnode1abc' }]) as Record<string, unknown>[]
  assert.equal(node.moniker, '')
  assert.equal(node.country, '')
})

// --- parseNodesPage: the /v2/nodes envelope ------------------------------
// Verbatim shapes captured from api.sentnodes.com on 2026-08-01, the day the
// endpoint started paginating.

test('reads the paginated envelope and asks for more pages', () => {
  const page = parseNodesPage({
    success: true,
    data: {
      nodes: [{ address: 'sentnode1abc' }],
      pagination: { total: 1833, perPage: 200, currentPage: 1, lastPage: 10, hasMorePages: true },
    },
    errors: null,
  })
  assert.deepEqual(page.nodes, [{ address: 'sentnode1abc' }])
  assert.equal(page.lastPage, 10)
})

test('the last page reports no further pages', () => {
  const page = parseNodesPage({
    success: true,
    data: {
      nodes: [],
      pagination: { total: 1833, perPage: 200, currentPage: 10, lastPage: 10, hasMorePages: false },
    },
  })
  assert.equal(page.lastPage, 10)
})

test('the pre-pagination flat array still parses, as a single page', () => {
  const page = parseNodesPage({ success: true, data: [{ address: 'sentnode1abc' }] })
  assert.deepEqual(page.nodes, [{ address: 'sentnode1abc' }])
  assert.equal(page.lastPage, 1)
})

test('a page count that is missing or nonsense means "just this page"', () => {
  for (const pagination of [undefined, {}, { lastPage: 0 }, { lastPage: -3 }, { lastPage: 'ten' }]) {
    const page = parseNodesPage({ success: true, data: { nodes: [], pagination } })
    assert.equal(page.lastPage, 1, `pagination ${JSON.stringify(pagination)}`)
  }
})

test('a failed or unrecognised body throws', () => {
  for (const body of [
    { success: false, data: null, errors: { code: 404, message: 'No route found with those values' } },
    { success: true, data: null },
    { success: true, data: { pagination: { lastPage: 1 } } },
    { success: true },
    {},
    null,
    'not json',
  ]) {
    assert.throws(() => parseNodesPage(body), /Invalid response from node API/, `body ${JSON.stringify(body)}`)
  }
})
