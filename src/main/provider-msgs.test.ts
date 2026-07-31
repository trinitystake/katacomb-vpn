import { test } from 'node:test'
import assert from 'node:assert/strict'
import Long from 'long'
import { planCreate } from '@sentinel-official/sentinel-js-sdk'
import {
  PROVIDER_REGISTRY,
  MsgStartLeaseTypeUrl,
  assertValidLeaseHours,
  assertValidPlanInput,
  buildCreatePlanMsg,
  buildEndLeaseMsg,
  buildLinkNodeMsg,
  buildPlanStatusMsg,
  buildPrices,
  buildProviderStatusMsg,
  buildRegisterProviderMsg,
  buildStartLeaseMsg,
  daysToDuration,
  gigabytesToBytes,
  leaseDepositNumber,
  leaseDepositUdvpn,
  toProviderAddress,
} from './provider-msgs.ts'

// PROV is plan #1's real provider on mainnet; ACC and NODE are the same 20 bytes
// re-encoded, which is exactly the relationship the hub's address types define.
const ACC = 'sent1aaaa4gxkfjntrerurznyhcm4saeegynrlhxeqw'
const PROV = 'sentprov1aaaa4gxkfjntrerurznyhcm4saeegynrhq6zmk'
const NODE = 'sentnode1aaaa4gxkfjntrerurznyhcm4saeegynrfp8q9c'

// --- address derivation ---

test('toProviderAddress re-encodes the account bytes under the sentprov prefix', () => {
  assert.equal(toProviderAddress(ACC), PROV)
})

test('toProviderAddress rejects an address that is not an account address', () => {
  assert.throws(() => toProviderAddress(PROV), /prefix "sentprov"/)
  assert.throws(() => toProviderAddress(NODE), /prefix "sentnode"/)
})

test('toProviderAddress rejects a malformed address', () => {
  assert.throws(() => toProviderAddress('not-bech32'))
})

// --- unit conversions ---

test('gigabytesToBytes counts decimal GB, matching live plans', () => {
  // Plan #1 on mainnet is 250 GB stored as "250000000000".
  assert.equal(gigabytesToBytes(250), '250000000000')
  assert.equal(gigabytesToBytes(1), '1000000000')
})

test('gigabytesToBytes stays exact past the float-safe range', () => {
  assert.equal(gigabytesToBytes(9_999_999), '9999999000000000')
})

test('daysToDuration converts to whole seconds', () => {
  const d = daysToDuration(30)
  assert.equal(d.seconds.toString(), '2592000')
  assert.equal(d.nanos, 0)
})

test('buildPrices pins baseValue to "0" and puts the amount in quoteValue', () => {
  assert.deepEqual(buildPrices(25_000_000), [
    { denom: 'udvpn', baseValue: '0', quoteValue: '25000000' },
  ])
})

// --- plan input validation (mirrors MsgCreatePlanRequest.ValidateBasic) ---

test('assertValidPlanInput rejects zero or fractional sizes and durations', () => {
  const ok = { gigabytes: 10, days: 30, priceUdvpn: 1, private: false }
  assert.doesNotThrow(() => assertValidPlanInput(ok))
  assert.throws(() => assertValidPlanInput({ ...ok, gigabytes: 0 }), /greater than zero/)
  assert.throws(() => assertValidPlanInput({ ...ok, gigabytes: 1.5 }), /whole number of GB/)
  assert.throws(() => assertValidPlanInput({ ...ok, days: 0 }), /greater than zero/)
  assert.throws(() => assertValidPlanInput({ ...ok, days: -1 }), /greater than zero/)
})

test('assertValidPlanInput allows a free plan but rejects a negative price', () => {
  const base = { gigabytes: 1, days: 1, private: false }
  assert.doesNotThrow(() => assertValidPlanInput({ ...base, priceUdvpn: 0 }))
  assert.throws(() => assertValidPlanInput({ ...base, priceUdvpn: -1 }), /non-negative/)
})

// --- the SDK-bug regression guard ---

test('buildCreatePlanMsg survives a registry encode/decode round-trip with bytes and duration intact', () => {
  const msg = buildCreatePlanMsg(PROV, { gigabytes: 250, days: 30, priceUdvpn: 25_000_000, private: false })
  const bin = PROVIDER_REGISTRY.encode(msg)
  const back = PROVIDER_REGISTRY.decode({ typeUrl: msg.typeUrl, value: bin })

  assert.equal(back.from, PROV)
  assert.equal(back.bytes, '250000000000')
  assert.equal(back.duration.seconds.toString(), '2592000')
  assert.deepEqual(back.prices, [{ denom: 'udvpn', baseValue: '0', quoteValue: '25000000' }])
  assert.equal(back.private, false)
})

test("the SDK's own planCreate() drops bytes and duration — this is why buildCreatePlanMsg exists", () => {
  // PlanCreate's arg type is {gigabytes, hours}; the v3 wire message is
  // {bytes, duration}. The builder passes args through verbatim, so the fields
  // the chain actually reads are never populated. If this test ever fails, the
  // SDK has been fixed and buildCreatePlanMsg can delegate to it.
  const broken = planCreate({
    from: PROV,
    gigabytes: Long.fromNumber(250, true),
    hours: Long.fromNumber(720, true),
    prices: buildPrices(25_000_000),
    private: false,
  })
  assert.equal((broken.value as Record<string, unknown>)['bytes'], undefined)
  assert.equal((broken.value as Record<string, unknown>)['duration'], undefined)
})

test('buildCreatePlanMsg validates before building, so a bad input never reaches the chain', () => {
  assert.throws(() => buildCreatePlanMsg(PROV, { gigabytes: 0, days: 30, priceUdvpn: 1, private: false }))
})

// --- lease messages (the registry extension) ---

test('the extended registry can encode a lease message the SDK registry does not know', () => {
  const msg = buildStartLeaseMsg({
    provAddress: PROV,
    nodeAddress: NODE,
    hours: 24,
    hourlyQuoteValue: '1000',
    renewalPricePolicy: 7,
  })
  assert.equal(msg.typeUrl, MsgStartLeaseTypeUrl)

  const back = PROVIDER_REGISTRY.decode({ typeUrl: msg.typeUrl, value: PROVIDER_REGISTRY.encode(msg) })
  assert.equal(back.from, PROV)
  assert.equal(back.nodeAddress, NODE)
  assert.equal(back.hours.toString(), '24')
  assert.deepEqual(back.maxPrice, { denom: 'udvpn', baseValue: '0', quoteValue: '1000' })
  assert.equal(back.renewalPricePolicy, 7)
})

test('buildEndLeaseMsg round-trips its uint64 id', () => {
  const msg = buildEndLeaseMsg(PROV, '18446744073709551615')
  const back = PROVIDER_REGISTRY.decode({ typeUrl: msg.typeUrl, value: PROVIDER_REGISTRY.encode(msg) })
  assert.equal(back.id.toString(), '18446744073709551615')
})

// --- lease cost ---

test('leaseDepositUdvpn is hourly price x hours, exactly (Lease.DepositAmount)', () => {
  assert.equal(leaseDepositUdvpn('1000', 24), '24000')
  assert.equal(leaseDepositUdvpn('0', 720), '0')
  // Stays exact well past Number.MAX_SAFE_INTEGER.
  assert.equal(leaseDepositUdvpn('99999999999999999', 720), '71999999999999999280')
})

test('leaseDepositUdvpn rejects a non-integer price rather than silently truncating', () => {
  assert.throws(() => leaseDepositUdvpn('1.5', 24), /whole number/)
  assert.throws(() => leaseDepositUdvpn('', 24), /whole number/)
})

test('leaseDepositNumber refuses to return a lossy balance-check figure', () => {
  assert.equal(leaseDepositNumber('1000', 24), 24000)
  assert.throws(() => leaseDepositNumber('99999999999999999', 720), /too large/)
})

test('assertValidLeaseHours enforces the chain bounds', () => {
  assert.doesNotThrow(() => assertValidLeaseHours(1, 1, 720))
  assert.doesNotThrow(() => assertValidLeaseHours(720, 1, 720))
  assert.throws(() => assertValidLeaseHours(0, 1, 720), /between 1 and 720/)
  assert.throws(() => assertValidLeaseHours(721, 1, 720), /between 1 and 720/)
  assert.throws(() => assertValidLeaseHours(1.5, 1, 720), /between 1 and 720/)
})

// --- status / link messages ---

test('status messages use active=1 / inactive=3, the only two ValidateBasic accepts', () => {
  assert.equal((buildProviderStatusMsg(PROV, true).value as { status: number }).status, 1)
  assert.equal((buildProviderStatusMsg(PROV, false).value as { status: number }).status, 3)
  assert.equal((buildPlanStatusMsg(PROV, '1', true).value as { status: number }).status, 1)
  assert.equal((buildPlanStatusMsg(PROV, '1', false).value as { status: number }).status, 3)
})

test('provider registration is the one message signed as the account, not the provider', () => {
  const msg = buildRegisterProviderMsg(ACC, { name: 'n', identity: '', website: '', description: '' })
  assert.equal((msg.value as { from: string }).from, ACC)

  const back = PROVIDER_REGISTRY.decode({ typeUrl: msg.typeUrl, value: PROVIDER_REGISTRY.encode(msg) })
  assert.equal(back.from, ACC)
  assert.equal(back.name, 'n')
})

test('link/unlink carry the plan id as uint64 and the node address verbatim', () => {
  const msg = buildLinkNodeMsg(PROV, '42', NODE)
  const back = PROVIDER_REGISTRY.decode({ typeUrl: msg.typeUrl, value: PROVIDER_REGISTRY.encode(msg) })
  assert.equal(back.id.toString(), '42')
  assert.equal(back.nodeAddress, NODE)
  assert.equal(back.from, PROV)
})
