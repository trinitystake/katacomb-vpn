import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEE_RESERVE_UDVPN,
  checkFunds,
  formatP2p,
  formatP2pCeil,
  insufficientFundsMessage,
  registrationDepositCost,
  udvpnOf,
} from './funds.ts'

test('udvpnOf picks the udvpn denom and ignores the rest', () => {
  assert.equal(udvpnOf([{ denom: 'ibc/ABC', amount: '999' }, { denom: 'udvpn', amount: '1200000' }]), 1200000)
})

test('udvpnOf returns 0 for an empty list or a missing udvpn entry', () => {
  assert.equal(udvpnOf([]), 0)
  assert.equal(udvpnOf([{ denom: 'ibc/ABC', amount: '999' }]), 0)
})

test('udvpnOf returns 0 for an unparseable or negative amount', () => {
  assert.equal(udvpnOf([{ denom: 'udvpn', amount: '' }]), 0)
  assert.equal(udvpnOf([{ denom: 'udvpn', amount: 'nope' }]), 0)
  assert.equal(udvpnOf([{ denom: 'udvpn', amount: '-5' }]), 0)
})

test('formatP2p converts udvpn to 2 decimals', () => {
  assert.equal(formatP2p(0), '0.00')
  assert.equal(formatP2p(1200000), '1.20')
  assert.equal(formatP2p(FEE_RESERVE_UDVPN), '0.05')
})

test('formatP2pCeil never rounds a non-zero shortfall down to 0.00', () => {
  assert.equal(formatP2pCeil(0), '0.00')
  assert.equal(formatP2pCeil(1), '0.01')
  assert.equal(formatP2pCeil(10000), '0.01')
  assert.equal(formatP2pCeil(10001), '0.02')
  assert.equal(formatP2pCeil(1200000), '1.20')
})

test('checkFunds is ok when the balance exactly covers cost + fee reserve', () => {
  const c = checkFunds(5_000_000 + FEE_RESERVE_UDVPN, 5_000_000)
  assert.equal(c.ok, true)
  assert.equal(c.shortfall, 0)
  assert.equal(c.required, 5_000_000 + FEE_RESERVE_UDVPN)
})

test('checkFunds fails one udvpn short and reports the shortfall', () => {
  const c = checkFunds(5_000_000 + FEE_RESERVE_UDVPN - 1, 5_000_000)
  assert.equal(c.ok, false)
  assert.equal(c.shortfall, 1)
})

test('checkFunds with cost 0 still requires the fee reserve', () => {
  assert.equal(checkFunds(FEE_RESERVE_UDVPN, 0).ok, true)
  const c = checkFunds(FEE_RESERVE_UDVPN - 1, 0)
  assert.equal(c.ok, false)
  assert.equal(c.cost, 0)
  assert.equal(c.shortfall, 1)
})

test('insufficientFundsMessage names cost, fee, total, balance and top-up', () => {
  const msg = insufficientFundsMessage(checkFunds(1_200_000, 5_000_000))
  assert.match(msg, /costs 5\.00/)
  assert.match(msg, /~0\.05 in network fees/)
  assert.match(msg, /5\.05 total/)
  assert.match(msg, /wallet has 1\.20/)
  assert.match(msg, /Add 3\.85 P2P/)
})

test('insufficientFundsMessage uses the gas-only wording when cost is 0', () => {
  const msg = insufficientFundsMessage(checkFunds(10_000, 0))
  assert.match(msg, /network fee/)
  assert.match(msg, /needs ~0\.05 P2P/)
  assert.match(msg, /wallet has 0\.01/)
  assert.doesNotMatch(msg, /costs/)
})

test('registrationDepositCost prices a udvpn deposit', () => {
  assert.equal(registrationDepositCost({ denom: 'udvpn', amount: '25000000' }), 25_000_000)
})

test('registrationDepositCost accepts a zero deposit whatever the denom (mainnet today)', () => {
  assert.equal(registrationDepositCost({ denom: 'udvpn', amount: '0' }), 0)
  assert.equal(registrationDepositCost({ denom: 'ibc/ABC', amount: '0' }), 0)
})

test('registrationDepositCost fails closed on a non-udvpn deposit it cannot verify', () => {
  assert.throws(() => registrationDepositCost({ denom: 'ibc/ABC', amount: '5' }), /cannot verify funds/)
})

test('registrationDepositCost fails closed on an unparseable amount, never pricing it as free', () => {
  assert.throws(() => registrationDepositCost({ denom: 'udvpn', amount: '' }), /could not be read/)
  assert.throws(() => registrationDepositCost({ denom: 'udvpn', amount: 'nope' }), /could not be read/)
  assert.throws(() => registrationDepositCost({ denom: 'udvpn', amount: '-5' }), /could not be read/)
  assert.throws(() => registrationDepositCost({ denom: 'udvpn', amount: '12.5' }), /could not be read/)
  assert.throws(() => registrationDepositCost({ denom: 'udvpn', amount: '999999999999999999999' }), /could not be read/)
})
