import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerSetupSteps, setupComplete, type SetupInput } from './provider-setup.ts'

const base: SetupInput = {
  registered: false,
  active: false,
  planCount: 0,
  activePlanCount: 0,
  leaseCount: 0,
  confirmedLinkedNodes: 0,
}

function states(input: SetupInput): string[] {
  return providerSetupSteps(input).map((s) => s.state)
}

test('a fresh wallet is asked to register first, everything else later', () => {
  assert.deepEqual(states(base), ['next', 'later', 'later', 'later', 'later'])
})

test('registered but inactive: activation is the next step', () => {
  assert.deepEqual(states({ ...base, registered: true }), ['done', 'next', 'later', 'later', 'later'])
})

test('active with no plans: create a plan', () => {
  assert.deepEqual(states({ ...base, registered: true, active: true }), ['done', 'done', 'next', 'later', 'later'])
})

test('a plan with nothing leased: lease and link', () => {
  const input = { ...base, registered: true, active: true, planCount: 1 }
  assert.deepEqual(states(input), ['done', 'done', 'done', 'next', 'later'])
  const link = providerSetupSteps(input)[3]
  assert.match(link.detail, /Pay a node operator/)
})

test('leased but confirmed unlinked: linking is still the next step, with its own wording', () => {
  const input = { ...base, registered: true, active: true, planCount: 1, leaseCount: 1, confirmedLinkedNodes: 0 }
  assert.deepEqual(states(input), ['done', 'done', 'done', 'next', 'later'])
  assert.match(providerSetupSteps(input)[3].detail, /already pay for a node/)
})

test('an unreadable linked count reports unknown, never a false "no nodes"', () => {
  const input = { ...base, registered: true, active: true, planCount: 1, leaseCount: 1, confirmedLinkedNodes: null }
  assert.deepEqual(states(input), ['done', 'done', 'done', 'unknown', 'next'])
  assert.match(providerSetupSteps(input)[3].detail, /could not be read/)
})

test('no leases means the linked count is knowable without stats: null still reads as to-do', () => {
  const input = { ...base, registered: true, active: true, planCount: 1, leaseCount: 0, confirmedLinkedNodes: null }
  assert.deepEqual(states(input), ['done', 'done', 'done', 'next', 'later'])
})

test('a live plan with no nodes points back at linking, not at activation', () => {
  const input = { ...base, registered: true, active: true, planCount: 1, activePlanCount: 1, leaseCount: 1, confirmedLinkedNodes: 0 }
  assert.deepEqual(states(input), ['done', 'done', 'done', 'next', 'done'])
})

test('the finished path is complete and only then', () => {
  const finished = { ...base, registered: true, active: true, planCount: 1, activePlanCount: 1, leaseCount: 1, confirmedLinkedNodes: 1 }
  assert.equal(setupComplete(providerSetupSteps(finished)), true)
  assert.equal(setupComplete(providerSetupSteps({ ...finished, confirmedLinkedNodes: null })), false)
  assert.equal(setupComplete(providerSetupSteps({ ...finished, activePlanCount: 0 })), false)
})

test('deactivated provider with existing plans: activation is next again', () => {
  const input = { ...base, registered: true, active: false, planCount: 2, activePlanCount: 0, leaseCount: 0 }
  assert.deepEqual(states(input), ['done', 'next', 'done', 'later', 'later'])
})
