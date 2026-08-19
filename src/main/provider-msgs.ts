// Pure message builders + registry for the PROVIDER side of the chain: registering
// a provider, publishing plans, and leasing/linking nodes into them.
//
// Two reasons this file exists instead of calling the SDK's convenience helpers:
//
// 1. `planCreate()` in the JS SDK (2.0.4, and still on master) is BROKEN — its
//    `PlanCreate` arg type is `{gigabytes: Long, hours: Long}` while the v3 wire
//    message is `{bytes: string, duration: Duration}`, and the builder passes args
//    through verbatim. Both fields are silently dropped at encode time, so a plan
//    created through it is unusable. We build the EncodeObject ourselves.
//
// 2. The whole `x/lease` module is ABSENT from the SDK: the protobufs ship under
//    dist/protobuf/sentinel/lease/v1/ but there is no `modules/lease`, and
//    `SentinelRegistry` omits the type URLs. A lease is not optional — the hub's
//    HandleMsgLinkNode rejects unless `HasAnyLeaseForNodeByProvider(...)` — so we
//    supply the encode objects and extend the registry (PROVIDER_REGISTRY).
//
// Field shapes and validation mirror sentinelhub v12 (x/plan/types/v3/msg.go,
// x/lease/types/v1/msg.go, types/v1/price.go) so an invalid input fails here
// rather than after paying gas for a guaranteed rejection.
//
// Electron-free + unit-tested under the native runner, like tx-utils.ts and
// connect-decisions.ts. NOTE: no relative imports — the native test runner can't
// resolve extensionless ones (same constraint that made tx-utils.ts inline its
// marker constant).

import { Registry, type EncodeObject, type GeneratedType } from '@cosmjs/proto-signing'
import { fromBech32, toBech32 } from '@cosmjs/encoding'
import Long from 'long'
import { SentinelRegistry, Status, RenewalPricePolicy } from '@sentinel-official/sentinel-js-sdk'
// Deep imports carry the `.js` extension: the package has no "exports" map, and
// Node's native test runner resolves these as ESM, where extensionless paths fail.
import {
  MsgCreatePlanTypeUrl,
  MsgLinkNodeTypeUrl,
  MsgUnlinkNodeTypeUrl,
  MsgUpdatePlanStatusTypeUrl,
} from '@sentinel-official/sentinel-js-sdk/dist/modules/plan/consts.js'
import {
  MsgRegisterProviderTypeUrl,
  MsgUpdateProviderDetailsTypeUrl,
  MsgUpdateProviderStatusTypeUrl,
} from '@sentinel-official/sentinel-js-sdk/dist/modules/provider/consts.js'
import {
  MsgStartLeaseRequest,
  MsgEndLeaseRequest,
} from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/lease/v1/msg.js'

/** The only denom this console prices in. Multi-denom/IBC plan pricing is out of scope. */
const PLAN_DENOM = 'udvpn'

/** 1 GB as the chain counts it — decimal, matching every live plan (250 GB = 250000000000). */
const BYTES_PER_GB = 1_000_000_000n
const SECONDS_PER_DAY = 86_400

// The SDK has no lease module, so its type URLs are declared here. These are
// stable protobuf identifiers (sentinel.lease.v1), not SDK API.
export const MsgStartLeaseTypeUrl = '/sentinel.lease.v1.MsgStartLeaseRequest'
const MsgEndLeaseTypeUrl = '/sentinel.lease.v1.MsgEndLeaseRequest'

/**
 * The SDK registry plus the missing lease types.
 *
 * MUST be passed to `connectWithSigner` for any lease tx: the SDK does
 * `Object.assign({ registry: default }, options)`, so a caller-supplied registry
 * REPLACES the default rather than merging with it — hence spreading
 * `SentinelRegistry` back in here.
 */
export const PROVIDER_REGISTRY = new Registry([
  ...SentinelRegistry,
  [MsgStartLeaseTypeUrl, MsgStartLeaseRequest as unknown as GeneratedType],
  [MsgEndLeaseTypeUrl, MsgEndLeaseRequest as unknown as GeneratedType],
])

// --- addresses ---

/**
 * Derive the provider address from the wallet's account address. The hub does
 * `base.ProvAddress(accAddr.Bytes())` — same 20 bytes, different bech32 prefix —
 * and `GetSigners()` converts back, so a tx carrying a `sentprov1…` `from` is
 * still signed by the plain `sent1…` account.
 */
export function toProviderAddress(accountAddress: string): string {
  const { prefix, data } = fromBech32(accountAddress)
  if (prefix !== 'sent') {
    throw new Error(`Expected a sent1… account address, got prefix "${prefix}"`)
  }
  return toBech32('sentprov', data)
}

// --- plan inputs ---

export interface PlanInput {
  gigabytes: number
  days: number
  /** Plan price in udvpn (the chain's Price.quoteValue). */
  priceUdvpn: number
  private: boolean
}

/**
 * Mirrors MsgCreatePlanRequest.ValidateBasic plus Prices.Validate: bytes and
 * duration must be positive, prices non-negative. (The denom-sort rule is
 * trivially satisfied by our single-denom price list, but see buildPrices.)
 */
export function assertValidPlanInput(input: PlanInput): void {
  if (!Number.isInteger(input.gigabytes) || input.gigabytes <= 0) {
    throw new Error('Plan size must be a whole number of GB greater than zero')
  }
  if (!Number.isInteger(input.days) || input.days <= 0) {
    throw new Error('Plan duration must be a whole number of days greater than zero')
  }
  if (!Number.isInteger(input.priceUdvpn) || input.priceUdvpn < 0) {
    throw new Error('Plan price must be a whole, non-negative number of udvpn')
  }
}

export function gigabytesToBytes(gigabytes: number): string {
  return (BigInt(gigabytes) * BYTES_PER_GB).toString()
}

export function daysToDuration(days: number): { seconds: Long; nanos: number } {
  // google.protobuf.Duration.seconds is int64 (signed).
  return { seconds: Long.fromNumber(days * SECONDS_PER_DAY, false), nanos: 0 }
}

/**
 * A single-denom price list. `baseValue` is the oracle base (a LegacyDec string)
 * and stays "0" — every live plan on chain uses that, with the real amount in
 * `quoteValue`. Sorted by denom because Prices.Validate() rejects an unsorted list.
 */
export function buildPrices(priceUdvpn: number): { denom: string; baseValue: string; quoteValue: string }[] {
  return [{ denom: PLAN_DENOM, baseValue: '0', quoteValue: String(priceUdvpn) }]
}

// --- provider messages ---

export interface ProviderDetails {
  name: string
  identity: string
  website: string
  description: string
}

export function buildRegisterProviderMsg(accountAddress: string, details: ProviderDetails): EncodeObject {
  // The ONLY provider-module message whose `from` is the account address: the hub
  // derives the provider address from it rather than reading it off the message.
  return { typeUrl: MsgRegisterProviderTypeUrl, value: { from: accountAddress, ...details } }
}

export function buildProviderDetailsMsg(provAddress: string, details: ProviderDetails): EncodeObject {
  return { typeUrl: MsgUpdateProviderDetailsTypeUrl, value: { from: provAddress, ...details } }
}

export function buildProviderStatusMsg(provAddress: string, active: boolean): EncodeObject {
  return {
    typeUrl: MsgUpdateProviderStatusTypeUrl,
    value: { from: provAddress, status: active ? Status.STATUS_ACTIVE : Status.STATUS_INACTIVE },
  }
}

// --- plan messages ---

export function buildCreatePlanMsg(provAddress: string, input: PlanInput): EncodeObject {
  assertValidPlanInput(input)
  return {
    typeUrl: MsgCreatePlanTypeUrl,
    value: {
      from: provAddress,
      bytes: gigabytesToBytes(input.gigabytes),
      duration: daysToDuration(input.days),
      prices: buildPrices(input.priceUdvpn),
      private: input.private,
    },
  }
}

export function buildPlanStatusMsg(provAddress: string, planId: string, active: boolean): EncodeObject {
  return {
    typeUrl: MsgUpdatePlanStatusTypeUrl,
    value: {
      from: provAddress,
      id: Long.fromString(planId, true),
      // ValidateBasic accepts only active/inactive here — never the pending states.
      status: active ? Status.STATUS_ACTIVE : Status.STATUS_INACTIVE,
    },
  }
}

export function buildLinkNodeMsg(provAddress: string, planId: string, nodeAddress: string): EncodeObject {
  return {
    typeUrl: MsgLinkNodeTypeUrl,
    value: { from: provAddress, id: Long.fromString(planId, true), nodeAddress },
  }
}

export function buildUnlinkNodeMsg(provAddress: string, planId: string, nodeAddress: string): EncodeObject {
  return {
    typeUrl: MsgUnlinkNodeTypeUrl,
    value: { from: provAddress, id: Long.fromString(planId, true), nodeAddress },
  }
}

// --- lease messages ---

/**
 * What a lease costs up front: the hub escrows `price.QuoteValue * MaxHours` from
 * the provider (Lease.DepositAmount()), then pays it out to the node hourly and
 * refunds the unused remainder on MsgEndLease. Returned as a string because the
 * chain works in integers; callers that need a JS number for a balance check
 * should go through `leaseDepositNumber`.
 */
export function leaseDepositUdvpn(hourlyQuoteValue: string, hours: number): string {
  if (!/^\d+$/.test(hourlyQuoteValue)) {
    throw new Error(`Node hourly price is not a whole number: "${hourlyQuoteValue}"`)
  }
  return (BigInt(hourlyQuoteValue) * BigInt(hours)).toString()
}

export function leaseDepositNumber(hourlyQuoteValue: string, hours: number): number {
  const total = Number(leaseDepositUdvpn(hourlyQuoteValue, hours))
  if (!Number.isSafeInteger(total)) throw new Error('Lease cost is too large to price')
  return total
}

/** Mirrors the hub's `IsValidHours` bound (live params: min 1, max 720). */
export function assertValidLeaseHours(hours: number, minHours: number, maxHours: number): void {
  if (!Number.isInteger(hours) || hours < minHours || hours > maxHours) {
    throw new Error(`Lease length must be a whole number of hours between ${minHours} and ${maxHours}`)
  }
}

export function buildStartLeaseMsg(params: {
  provAddress: string
  nodeAddress: string
  hours: number
  /** The node's own on-chain hourly price — sent as MaxPrice so the tx fails rather than overpaying if it moved. */
  hourlyQuoteValue: string
  renewalPricePolicy: number
}): EncodeObject {
  return {
    typeUrl: MsgStartLeaseTypeUrl,
    value: {
      from: params.provAddress,
      nodeAddress: params.nodeAddress,
      // int64 in the proto, and the encoder calls .equals() on it — must be a real Long.
      hours: Long.fromNumber(params.hours, false),
      maxPrice: { denom: PLAN_DENOM, baseValue: '0', quoteValue: params.hourlyQuoteValue },
      renewalPricePolicy: params.renewalPricePolicy as RenewalPricePolicy,
    },
  }
}

export function buildEndLeaseMsg(provAddress: string, leaseId: string): EncodeObject {
  return {
    typeUrl: MsgEndLeaseTypeUrl,
    value: { from: provAddress, id: Long.fromString(leaseId, true) },
  }
}
