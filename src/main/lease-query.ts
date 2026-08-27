// Query client for `x/lease`, the one Sentinel module the JS SDK doesn't wrap.
//
// The protobufs ship inside the SDK (dist/protobuf/sentinel/lease/v1/) — including
// a generated QueryServiceClientImpl — but there is no `modules/lease`, so
// `SentinelClient.sentinelQuery` has no `.lease`.
//
// Leases are load-bearing here, not a nicety: the hub rejects MsgLinkNode unless
// an active lease exists between the provider and the node, so the provider
// console has to be able to read them back.

import Long from 'long'
import {
  QueryServiceClientImpl,
  QueryLeasesForProviderRequest,
  QueryParamsRequest,
} from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/lease/v1/querier.js'
import type { ProtobufRpcClient } from '@cosmjs/stargate'
import { withTimeout } from './async-utils'
import { withProtobufQuery, QUERY_TIMEOUT_MS } from './protobuf-query'

const PAGE_LIMIT = 200
const MAX_LEASES = 1000

/** A lease, flattened to plain JSON so it can cross the IPC bridge. */
export interface LeaseInfo {
  id: string
  provAddress: string
  nodeAddress: string
  /** udvpn per hour, as an integer string. */
  hourlyPrice: string
  /** Hours already consumed and paid out. */
  hours: number
  /** Hours bought up front — the deposit was hourlyPrice x maxHours. */
  maxHours: number
  renewalPricePolicy: number
  startAt: string | null
}

export interface LeaseParams {
  minHours: number
  maxHours: number
  /**
   * LegacyDec share (10^18-scaled integer string) of each hourly lease payment the
   * hub keeps for the community pool; the node gets the rest. Mainnet: 20%.
   *
   * Informational only — the provider is charged the full hourly price either way,
   * so no cost figure depends on it. Empty string when the chain omits it, which
   * only drops the explanatory line in the lease modal.
   */
  stakingShare: string
}

type RawLease = {
  id: Long
  provAddress: string
  nodeAddress: string
  price?: { denom: string; baseValue: string; quoteValue: string }
  hours: Long
  maxHours: Long
  renewalPricePolicy: number
  startAt?: Date
}

function toLeaseInfo(l: RawLease): LeaseInfo {
  return {
    id: l.id.toString(),
    provAddress: l.provAddress,
    nodeAddress: l.nodeAddress,
    hourlyPrice: l.price?.quoteValue ?? '0',
    hours: l.hours.toNumber(),
    maxHours: l.maxHours.toNumber(),
    renewalPricePolicy: l.renewalPricePolicy,
    startAt: l.startAt ? new Date(l.startAt).toISOString() : null,
  }
}

async function withLeaseQuery<T>(fn: (q: QueryServiceClientImpl) => Promise<T>, shared?: ProtobufRpcClient): Promise<T> {
  return withProtobufQuery((rpc) => fn(new QueryServiceClientImpl(rpc)), shared)
}

export async function listLeasesForProvider(provAddress: string, shared?: ProtobufRpcClient): Promise<LeaseInfo[]> {
  return withLeaseQuery(async (query) => {
    const results: LeaseInfo[] = []
    let nextKey: Uint8Array = new Uint8Array()
    let firstPage = true

    while (results.length < MAX_LEASES) {
      const req = QueryLeasesForProviderRequest.fromPartial({
        address: provAddress,
        pagination: {
          key: nextKey,
          offset: Long.fromNumber(0, true),
          limit: Long.fromNumber(PAGE_LIMIT, true),
          countTotal: firstPage,
          reverse: false,
        },
      })
      firstPage = false

      const resp = await withTimeout(
        query.QueryLeasesForProvider(req),
        QUERY_TIMEOUT_MS,
        'lease.leasesForProvider',
      )
      if (!resp.leases?.length) break

      for (const raw of resp.leases) results.push(toLeaseInfo(raw as unknown as RawLease))

      const nk = resp.pagination?.nextKey
      if (!nk || nk.length === 0) break
      nextKey = nk
    }

    return results
  }, shared)
}

/** Live bounds for MsgStartLease's `hours` (mainnet today: 1 and 720). */
export async function getLeaseParams(shared?: ProtobufRpcClient): Promise<LeaseParams> {
  return withLeaseQuery(async (query) => {
    const resp = await withTimeout(
      query.QueryParams(QueryParamsRequest.fromPartial({})),
      QUERY_TIMEOUT_MS,
      'lease.params',
    )
    return {
      minHours: resp.params?.minHours?.toNumber() ?? 1,
      maxHours: resp.params?.maxHours?.toNumber() ?? 720,
      stakingShare: resp.params?.stakingShare ?? '',
    }
  }, shared)
}
