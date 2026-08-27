import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RENEWAL_POLICY_OPTIONS,
  renewalPolicyAllows,
  renewalPolicyLabel,
  renewalPolicyRefusal,
} from './renewal-policy.ts'

test('renewalPolicyAllows refuses UNSPECIFIED unconditionally', () => {
  // This is the trap: policy 0 blocks the BeginBlocker's auto-renew AND a manual
  // MsgRenewLease, so MsgUpdateLease is the only way out of it.
  for (const [cur, old] of [['100', '100'], ['50', '100'], ['200', '100']]) {
    assert.equal(renewalPolicyAllows(0, cur, old), false)
  }
})

test('renewalPolicyAllows mirrors the hub comparison for every policy', () => {
  const cases: [number, string, string, boolean][] = [
    // IF_LESSER (1): only when the node's price dropped
    [1, '50', '100', true], [1, '100', '100', false], [1, '200', '100', false],
    // IF_LESSER_OR_EQUAL (2)
    [2, '50', '100', true], [2, '100', '100', true], [2, '200', '100', false],
    // IF_EQUAL (3)
    [3, '100', '100', true], [3, '50', '100', false], [3, '200', '100', false],
    // IF_NOT_EQUAL (4)
    [4, '50', '100', true], [4, '200', '100', true], [4, '100', '100', false],
    // IF_GREATER (5)
    [5, '200', '100', true], [5, '100', '100', false], [5, '50', '100', false],
    // IF_GREATER_OR_EQUAL (6)
    [6, '200', '100', true], [6, '100', '100', true], [6, '50', '100', false],
    // ALWAYS (7)
    [7, '50', '100', true], [7, '100', '100', true], [7, '200', '100', true],
  ]
  for (const [policy, cur, old, want] of cases) {
    assert.equal(renewalPolicyAllows(policy, cur, old), want, `policy ${policy}: ${cur} vs ${old}`)
  }
})

test('renewalPolicyAllows compares past the float-safe range and refuses junk', () => {
  assert.equal(renewalPolicyAllows(1, '9007199254740993', '9007199254740992'), false)
  assert.equal(renewalPolicyAllows(5, '9007199254740993', '9007199254740992'), true)
  assert.equal(renewalPolicyAllows(7, 'nonsense', '100'), false)
  assert.equal(renewalPolicyAllows(99, '100', '100'), false)
})

test('renewalPolicyRefusal explains policy 0 as a dead end, not a price problem', () => {
  const why = renewalPolicyRefusal(0, '100', '100')
  assert.match(String(why), /never renew/)
  assert.match(String(why), /renewal policy/)
})

test('renewalPolicyRefusal names both prices, in P2P rather than raw udvpn', () => {
  const why = renewalPolicyRefusal(1, '2000000', '1000000')
  assert.match(String(why), /2 P2P/)
  assert.match(String(why), /1 P2P/)
  assert.doesNotMatch(String(why), /udvpn/)
})

test('renewalPolicyRefusal is null exactly when the chain would accept', () => {
  assert.equal(renewalPolicyRefusal(7, '200', '100'), null)
  assert.equal(renewalPolicyRefusal(2, '100', '100'), null)
  assert.notEqual(renewalPolicyRefusal(1, '100', '100'), null)
})

test('the offered options exclude the policies that only renew on a price rise', () => {
  // IF_GREATER (5), IF_GREATER_OR_EQUAL (6), IF_NOT_EQUAL (4) and IF_EQUAL (3)
  // are all valid on chain but nonsense to opt into, so they are not offered.
  const values = RENEWAL_POLICY_OPTIONS.map((o) => o.value)
  assert.deepEqual(values, [7, 2, 1, 0])
})

test('renewalPolicyLabel falls back rather than throwing on an unoffered policy', () => {
  assert.equal(renewalPolicyLabel(7), 'Renew automatically')
  assert.equal(renewalPolicyLabel(5), 'Policy 5')
})
