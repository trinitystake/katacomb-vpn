import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDecShare,
  isActiveLease,
  computeBurn,
  computeCommitted,
  netOfStakingShare,
  computeBreakEven,
  computeEstimatedRevenue,
  type LeaseCost,
} from './provider-economics.ts'

/** The value both sentinel.subscription.v3 and sentinel.lease.v1 return on mainnet. */
const MAINNET_SHARE = '200000000000000000'

function lease(hourlyPrice: string, hours: number, maxHours: number): LeaseCost {
  return { hourlyPrice, hours, maxHours }
}

// --- parseDecShare ---

test('parseDecShare: the live mainnet wire value is 20%, not 2e17%', () => {
  const share = parseDecShare(MAINNET_SHARE)
  // 20% of 1000 is 200 — the check that catches a 10^18 misparse.
  assert.equal(netOfStakingShare('1000', share), '800')
})

test('parseDecShare: rejects a decimal-point encoding rather than misreading it', () => {
  // "0.2" would parse to a share of 0 under a naive BigInt cast, silently
  // reporting 100% of the plan price as income.
  assert.throws(() => parseDecShare('0.200000000000000000'), /LegacyDec integer/)
})

test('parseDecShare: rejects a share above 100%', () => {
  assert.throws(() => parseDecShare('1000000000000000001'), /exceeds 100%/)
})

test('parseDecShare: accepts the zero and whole bounds', () => {
  assert.equal(netOfStakingShare('1000', parseDecShare('0')), '1000')
  assert.equal(netOfStakingShare('1000', parseDecShare('1000000000000000000')), '0')
})

// --- isActiveLease / computeBurn ---

test('isActiveLease: an exhausted lease is not billing any more', () => {
  assert.equal(isActiveLease(lease('100', 10, 24)), true)
  assert.equal(isActiveLease(lease('100', 24, 24)), false)
})

test('computeBurn: sums only active leases, and days are 24 hours of them', () => {
  const burn = computeBurn([
    lease('1000', 5, 24),
    lease('2000', 0, 720),
    lease('9999', 24, 24), // exhausted — must not count
  ])
  assert.equal(burn.hourlyUdvpn, '3000')
  assert.equal(burn.dailyUdvpn, '72000')
  assert.equal(burn.activeLeases, 2)
})

test('computeBurn: no leases means no burn, not a crash', () => {
  const burn = computeBurn([])
  assert.equal(burn.hourlyUdvpn, '0')
  assert.equal(burn.dailyUdvpn, '0')
  assert.equal(burn.activeLeases, 0)
})

test('computeBurn: rejects a non-integer hourly price from the chain', () => {
  assert.throws(() => computeBurn([lease('12.5', 0, 24)]), /whole number of udvpn/)
})

test('computeBurn: stays exact past the float-safe range', () => {
  // 9007199254740993 is MAX_SAFE_INTEGER + 2; Number arithmetic would round it.
  const burn = computeBurn([lease('9007199254740993', 0, 1)])
  assert.equal(burn.hourlyUdvpn, '9007199254740993')
  assert.equal(burn.dailyUdvpn, '216172782113783832')
})

// --- computeCommitted ---

test('computeCommitted: escrow left is the unused hours, exhausted leases excluded', () => {
  assert.equal(
    computeCommitted([
      lease('1000', 4, 24), // 20 hours left -> 20000
      lease('500', 0, 10), //  10 hours left ->  5000
      lease('9999', 24, 24), // nothing left
    ]),
    '25000',
  )
})

// --- netOfStakingShare ---

test('netOfStakingShare: the hub keeps its cut, so sticker price is not income', () => {
  assert.equal(netOfStakingShare('10000000', parseDecShare(MAINNET_SHARE)), '8000000')
})

test('netOfStakingShare: rounds down so the estimate never overstates income', () => {
  // 9 * 0.8 = 7.2
  assert.equal(netOfStakingShare('9', parseDecShare(MAINNET_SHARE)), '7')
})

// --- computeBreakEven ---

test('computeBreakEven: the worked case from the design', () => {
  // 480 P2P/day of burn, a 30-day plan netting 8 P2P per subscriber.
  const result = computeBreakEven({
    dailyBurnUdvpn: '480000000',
    netPricePerSubUdvpn: '8000000',
    durationDays: 30,
  })
  assert.deepEqual(result, { kind: 'subscribers', count: 1800 })
})

test('computeBreakEven: rounds up, because a fractional subscriber pays nothing', () => {
  const result = computeBreakEven({
    dailyBurnUdvpn: '100',
    netPricePerSubUdvpn: '30',
    durationDays: 1,
  })
  // 100/30 = 3.33 -> 4
  assert.deepEqual(result, { kind: 'subscribers', count: 4 })
})

test('computeBreakEven: an exact division does not round up a spurious extra', () => {
  const result = computeBreakEven({
    dailyBurnUdvpn: '90',
    netPricePerSubUdvpn: '30',
    durationDays: 1,
  })
  assert.deepEqual(result, { kind: 'subscribers', count: 3 })
})

test('computeBreakEven: no leases reports no-burn rather than zero subscribers', () => {
  const result = computeBreakEven({
    dailyBurnUdvpn: '0',
    netPricePerSubUdvpn: '8000000',
    durationDays: 30,
  })
  assert.deepEqual(result, { kind: 'no-burn' })
})

test('computeBreakEven: a plan netting nothing can never cover its nodes', () => {
  const result = computeBreakEven({
    dailyBurnUdvpn: '480000000',
    netPricePerSubUdvpn: '0',
    durationDays: 30,
  })
  // Never Infinity or NaN — the UI needs a word, not a number.
  assert.deepEqual(result, { kind: 'never' })
})

test('computeBreakEven: no-burn wins over never when both hold', () => {
  const result = computeBreakEven({
    dailyBurnUdvpn: '0',
    netPricePerSubUdvpn: '0',
    durationDays: 30,
  })
  assert.deepEqual(result, { kind: 'no-burn' })
})

test('computeBreakEven: rejects a non-positive duration', () => {
  assert.throws(
    () => computeBreakEven({ dailyBurnUdvpn: '100', netPricePerSubUdvpn: '10', durationDays: 0 }),
    /whole number of days/,
  )
})

// --- computeEstimatedRevenue ---

test('computeEstimatedRevenue: subscriptions times the net price', () => {
  assert.equal(computeEstimatedRevenue(43, '8000000'), '344000000')
})

test('computeEstimatedRevenue: no subscribers is zero, not a crash', () => {
  assert.equal(computeEstimatedRevenue(0, '8000000'), '0')
})
