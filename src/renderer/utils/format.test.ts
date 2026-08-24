import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatBytes,
  formatDuration,
  formatTimeAgo,
  formatDateUntil,
  planPriceDisplay,
  pricePerGb,
  pricePerDay,
  formatPerGb,
  UNLIMITED_BYTES_THRESHOLD,
} from './format.ts'

// --- formatBytes: decimal units, because chain plan bytes are decimal
// (provider-msgs.ts BYTES_PER_GB = 1e9; every live plan agrees: 250 GB is
// stored as 250000000000). The old 1024-based formatter labeled GiB as GB,
// reading ~7.4% low against the per-GB price math.

test('formatBytes: a chain 250 GB plan reads as exactly 250 GB', () => {
  assert.equal(formatBytes('250000000000'), '250 GB')
})

test('formatBytes: one decimal GB is 1 GB, not 0.93 GB', () => {
  assert.equal(formatBytes(1_000_000_000), '1 GB')
})

test('formatBytes: fractional values keep up to two decimals without trailing zeros', () => {
  assert.equal(formatBytes(1_500_000_000), '1.5 GB')
  assert.equal(formatBytes(1_250_000_000), '1.25 GB')
})

test('formatBytes: units climb decimally', () => {
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1_000), '1 KB')
  assert.equal(formatBytes(5_000_000), '5 MB')
  assert.equal(formatBytes(2_000_000_000_000), '2 TB')
})

test('formatBytes: at or past the unlimited threshold it says Unlimited', () => {
  assert.equal(formatBytes(UNLIMITED_BYTES_THRESHOLD), 'Unlimited')
})

test('formatBytes: zero, negatives and garbage read as 0 B', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes('not-a-number'), '0 B')
})

// --- formatDuration: two largest units, so a 36-hour plan no longer reads "1d"

test('formatDuration: a 36 hour plan is 1d 12h, not 1d', () => {
  assert.equal(formatDuration(36 * 3600), '1d 12h')
})

test('formatDuration: whole units stay single', () => {
  assert.equal(formatDuration(30 * 86400), '30d')
  assert.equal(formatDuration(2 * 3600), '2h')
})

test('formatDuration: sub-day and sub-hour combinations', () => {
  assert.equal(formatDuration(90 * 60), '1h 30m')
  assert.equal(formatDuration(90), '1m 30s')
  assert.equal(formatDuration(45), '45s')
})

test('formatDuration: null and non-positive have a placeholder with no em dash', () => {
  for (const v of [null, 0, -10]) {
    const out = formatDuration(v)
    assert.ok(out.length > 0)
    assert.ok(!out.includes('—'), `em dash in: ${out}`)
  }
})

// --- planPriceDisplay: a non-udvpn plan must never read (or sort) as free

test('planPriceDisplay: a udvpn price renders in P2P with the raw figure kept', () => {
  const out = planPriceDisplay([{ denom: 'udvpn', baseValue: '', quoteValue: '7400000' }])
  assert.equal(out.amount, '7.40')
  assert.equal(out.denomLabel, 'P2P')
  assert.equal(out.udvpn, 7400000)
})

test('planPriceDisplay: a foreign denom keeps its real figure and denom, udvpn is null not zero', () => {
  const out = planPriceDisplay([{ denom: 'uatom', baseValue: '', quoteValue: '1000000' }])
  assert.ok(out.amount.includes('1'))
  assert.equal(out.denomLabel, 'uatom')
  assert.equal(out.udvpn, null)
})

test('planPriceDisplay: udvpn wins when both denoms are quoted', () => {
  const out = planPriceDisplay([
    { denom: 'uatom', baseValue: '', quoteValue: '999' },
    { denom: 'udvpn', baseValue: '', quoteValue: '5000000' },
  ])
  assert.equal(out.denomLabel, 'P2P')
  assert.equal(out.udvpn, 5000000)
})

test('planPriceDisplay: no prices at all is an empty amount, never a zero', () => {
  const out = planPriceDisplay([])
  assert.equal(out.amount, '')
  assert.equal(out.udvpn, null)
})

// --- per-GB / per-day: null for anything that is not priced in udvpn

test('pricePerGb: udvpn price over decimal GB', () => {
  const plan = {
    prices: [{ denom: 'udvpn', baseValue: '', quoteValue: '7400000' }],
    bytes: '250000000000',
  }
  const perGb = pricePerGb(plan)
  assert.ok(perGb !== null)
  assert.ok(Math.abs(perGb - 7.4 / 250) < 1e-9)
})

test('pricePerGb: null for foreign denoms and unlimited plans', () => {
  assert.equal(pricePerGb({ prices: [{ denom: 'uatom', baseValue: '', quoteValue: '5' }], bytes: '1000000000' }), null)
  assert.equal(pricePerGb({ prices: [{ denom: 'udvpn', baseValue: '', quoteValue: '5' }], bytes: String(UNLIMITED_BYTES_THRESHOLD) }), null)
})

test('pricePerDay: udvpn price over days, null without a duration', () => {
  const prices = [{ denom: 'udvpn', baseValue: '', quoteValue: '7400000' }]
  const perDay = pricePerDay({ prices, durationSeconds: 30 * 86400 })
  assert.ok(perDay !== null)
  assert.ok(Math.abs(perDay - 7.4 / 30) < 1e-9)
  assert.equal(pricePerDay({ prices, durationSeconds: null }), null)
})

test('formatPerGb: tiny per-GB rates keep significant digits instead of rounding to 0.0000', () => {
  // A 100 TB plan at 1 P2P is 0.00001 P2P/GB; toFixed(4) showed it as 0.0000.
  assert.equal(formatPerGb(0.00001), '0.000010')
  assert.equal(formatPerGb(0.0296), '0.0296')
  assert.ok(!formatPerGb(0.00001).startsWith('0.0000 '))
})

// --- time formatting ---

test('formatTimeAgo: buckets and the never case', () => {
  const now = Date.now()
  assert.equal(formatTimeAgo(null), 'never')
  assert.equal(formatTimeAgo(now - 30_000), 'just now')
  assert.equal(formatTimeAgo(now - 14 * 60_000), '14m ago')
  assert.equal(formatTimeAgo(now - 3 * 3600_000), '3h ago')
  assert.equal(formatTimeAgo(now - 2 * 86400_000), '2d ago')
})

test('formatDateUntil: renders a readable date and survives null and garbage', () => {
  const out = formatDateUntil('2026-09-12T10:00:00Z')
  assert.ok(out.includes('2026'))
  assert.ok(out.includes('Sep'))
  assert.ok(!formatDateUntil(null).includes('—'))
  assert.ok(!formatDateUntil('garbage').includes('—'))
})
