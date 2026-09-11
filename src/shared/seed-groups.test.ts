import test from 'node:test'
import assert from 'node:assert/strict'
import { assignSeedGroups, groupWalletsBySeed } from './seed-groups.ts'

const PHRASES: Record<string, string> = {
  A: 'alpha beta gamma',
  B: 'alpha beta gamma',
  C: 'delta epsilon zeta',
}
const read = (id: string) => {
  const phrase = PHRASES[id]
  if (phrase === undefined) throw new Error('cannot decrypt')
  return phrase
}
const entries = [{ id: 'A', name: 'First' }, { id: 'B', name: 'Second' }, { id: 'C', name: 'Third' }]

test('wallets holding the same phrase share the first one\'s id as their group', () => {
  const result = assignSeedGroups(entries, read)
  assert.deepEqual(result.map((w) => w.id), ['A', 'B', 'C'])
  assert.deepEqual(result.map((w) => w.seedGroup), ['A', 'A', 'C'])
  assert.ok(result.every((w) => w.unlockable))
})

test('phrases are compared on normalized whitespace', () => {
  const messy = (id: string) => (id === 'B' ? '  alpha   beta\ngamma \n' : read(id))
  const result = assignSeedGroups(entries, messy)
  assert.deepEqual(result.map((w) => w.seedGroup), ['A', 'A', 'C'])
})

test('a phrase that cannot be read leaves that wallet locked and the others grouped', () => {
  const calls: string[] = []
  const failing = (id: string) => {
    calls.push(id)
    if (id === 'B') throw new Error('cannot decrypt')
    return read(id)
  }
  const result = assignSeedGroups(entries, failing)
  assert.deepEqual(result[1], { id: 'B', name: 'Second', unlockable: false, seedGroup: null })
  assert.equal(result[0].seedGroup, 'A')
  assert.equal(result[2].seedGroup, 'C')
  assert.deepEqual(calls, ['A', 'B', 'C'])
})

test('the result carries no key material, only the two membership fields', () => {
  const [first] = assignSeedGroups(entries, read)
  assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'seedGroup', 'unlockable'])
})

test('no entries, no groups', () => {
  assert.deepEqual(assignSeedGroups([], read), [])
  assert.deepEqual(groupWalletsBySeed([]), { groups: [], locked: [] })
})

test('groups follow first appearance, locked wallets go last and take no number', () => {
  const { groups, locked } = groupWalletsBySeed([
    { id: 'A', seedGroup: 'A' },
    { id: 'X', seedGroup: null },
    { id: 'C', seedGroup: 'C' },
    { id: 'B', seedGroup: 'A' },
  ])
  assert.deepEqual(groups.map((g) => [g.key, g.label, g.members.map((m) => m.id)]), [
    ['A', 'Seed 1', ['A', 'B']],
    ['C', 'Seed 2', ['C']],
  ])
  assert.deepEqual(locked.map((w) => w.id), ['X'])
})

test('a store where nothing unlocks has no groups', () => {
  const { groups, locked } = groupWalletsBySeed([{ id: 'X', seedGroup: null }, { id: 'Y', seedGroup: null }])
  assert.deepEqual(groups, [])
  assert.deepEqual(locked.map((w) => w.id), ['X', 'Y'])
})
