// Provider-side chain operations: register a provider, publish plans, and lease
// nodes into them. The consumer-side counterpart is plan-service.ts, whose
// conventions this file follows exactly — a fresh client per call wrapped in
// `withTimeout`, `disconnect()` in a `finally`, every broadcast through
// `broadcastOrTimeout` + `assertTxSucceeded`.
//
// Everything here is deliberately single-tx and stateless. The chain flows are
// multi-step (register → activate, create → activate, lease → link) and the
// intermediate state lives on chain, so a failed second step leaves a row the UI
// can resume from rather than a half-written local wizard.
//
// Message construction and the lease registry live in provider-msgs.ts (pure,
// unit-tested) — see the notes there on the SDK's broken planCreate() and its
// missing lease module.

import { GasPrice } from '@cosmjs/stargate'
import { DirectSecp256k1HdWallet, type EncodeObject } from '@cosmjs/proto-signing'
import Long from 'long'
import { SentinelClient, SigningSentinelClient, Status } from '@sentinel-official/sentinel-js-sdk'
import {
  QueryServiceClientImpl as ProviderQueryServiceClientImpl,
  QueryParamsRequest as ProviderQueryParamsRequest,
} from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/provider/v3/querier.js'
import {
  QueryServiceClientImpl as SubscriptionQueryServiceClientImpl,
  QueryParamsRequest as SubscriptionQueryParamsRequest,
} from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/subscription/v3/querier.js'
import { getRpcEndpoint } from './settings'
import { withTimeout } from './async-utils'
import { withProtobufQuery } from './protobuf-query'
import { listLeasesForProvider, getLeaseParams } from './lease-query'
import {
  computeBurn,
  computeCommitted,
  computeEstimatedRevenue,
  netOfStakingShare,
  parseDecShare,
} from '../shared/provider-economics'
import { assertTxSucceeded, broadcastOrTimeout, isChainNotFound } from './tx-utils'
import { GAS_PRICE_STR } from '../shared/chain-constants'
import {
  PROVIDER_REGISTRY,
  buildCreatePlanMsg,
  buildEndLeaseMsg,
  buildLinkNodeMsg,
  buildPlanStatusMsg,
  buildProviderDetailsMsg,
  buildProviderStatusMsg,
  buildRegisterProviderMsg,
  buildStartLeaseMsg,
  buildUnlinkNodeMsg,
  toProviderAddress,
  type PlanInput,
  type ProviderDetails,
} from './provider-msgs'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
const RPC_CONNECT_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 10_000
// Blocks of validity for a money tx (~6s/block → ~3 min), same bound the session
// path uses so a funds-spending tx can't confirm long after we stop polling.
const TX_TIMEOUT_HEIGHT_OFFSET = 30
const TX_TIMEOUT_MESSAGE =
  'The transaction timed out before confirmation. It may still be processing. Reopen the ' +
  'Provider tab in a moment to see the current on-chain state before retrying.'

export interface MyProviderInfo {
  /** Always present — it is derived from the wallet, whether or not it is registered. */
  address: string
  registered: boolean
  name: string
  identity: string
  website: string
  description: string
  /** sentinel.types.v1.Status: 1 active, 3 inactive. 0 when not registered. */
  status: number
}

export interface MyPlanInfo {
  id: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
}

export interface PlanSubscriberStats {
  /** Subscriptions ever created for the plan — the chain's own count, exact. */
  subscriptions: number
  /** Of the ones we could read, how many are STATUS_ACTIVE. */
  active: number
  /** True when the plan has more subscriptions than we scan — `active` is then a floor. */
  truncated: boolean
}

export interface NodePriceInfo {
  address: string
  /** udvpn per hour, integer string. '' when the node doesn't price in udvpn. */
  hourlyPrice: string
  status: number
}

// --- reads ---

async function withReadClient<T>(fn: (c: SentinelClient) => Promise<T>): Promise<T> {
  const client = await withTimeout(SentinelClient.connect(getRpcEndpoint()), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  try {
    return await fn(client)
  } finally {
    client.disconnect()
  }
}

function unregistered(address: string): MyProviderInfo {
  return { address, registered: false, name: '', identity: '', website: '', description: '', status: 0 }
}

/**
 * The wallet's own provider record, read by direct single-address lookup.
 *
 * Deliberately NOT provider-service.listProviders(): that is a 1-hour disk cache
 * built for browsing the whole network, and it would hide a provider registered
 * seconds ago — exactly the moment this is called.
 *
 * "Not registered" is the normal case for almost every wallet, and the chain
 * reports it by THROWING gRPC NotFound rather than returning an empty result, so
 * that one error is translated instead of propagated. Everything else still
 * throws — an unreachable RPC must not be mistaken for "you have no provider".
 */
export async function getMyProvider(accountAddress: string): Promise<MyProviderInfo> {
  const address = toProviderAddress(accountAddress)
  return withReadClient(async (client) => {
    const found = await withTimeout(
      Promise.resolve(client.sentinelQuery?.provider.provider(address)),
      QUERY_TIMEOUT_MS,
      'provider.provider',
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (isChainNotFound(message)) return undefined
      throw err
    })
    if (!found) {
      return unregistered(address)
    }
    // The SDK types this as the v1 Provider (no status), but the querier it calls
    // is v2 and does return one — read it through a cast rather than losing it.
    const p = found as unknown as MyProviderInfo & { status?: number }
    return {
      address,
      registered: true,
      name: p.name ?? '',
      identity: p.identity ?? '',
      website: p.website ?? '',
      description: p.description ?? '',
      status: p.status ?? 0,
    }
  })
}

/**
 * The registration deposit, in udvpn (0 on mainnet today, but it is a governance
 * param so it is read live rather than assumed).
 *
 * Goes through the v3 query service directly instead of the SDK's
 * `provider.params()`: that helper targets sentinel.provider.v2.QueryService,
 * which the chain does not implement — it answers "Unimplemented: unknown
 * request". Verified against mainnet, not inferred.
 */
export async function getProviderDeposit(): Promise<{ denom: string; amount: string }> {
  return withProtobufQuery(async (rpc) => {
    const query = new ProviderQueryServiceClientImpl(rpc)
    const resp = await withTimeout(
      query.QueryParams(ProviderQueryParamsRequest.fromPartial({})),
      QUERY_TIMEOUT_MS,
      'provider.params',
    )
    const deposit = resp.params?.deposit
    return { denom: deposit?.denom ?? 'udvpn', amount: deposit?.amount ?? '0' }
  })
}

/**
 * The share of every plan payment the hub keeps rather than passing to the provider
 * (LegacyDec, 10^18-scaled integer string — mainnet returns 20%).
 *
 * It lives on the provider side because the only thing that reads it is provider
 * economics: without it, plan revenue would be reported at the sticker price and
 * overstated by a fifth.
 *
 * Deliberately has NO fallback. Defaulting a missing share to zero would silently
 * inflate every earnings figure, so an absent value fails the whole economics read
 * and the UI shows "unavailable" instead of a flattering lie.
 */
export async function getSubscriptionStakingShare(): Promise<string> {
  return withProtobufQuery(async (rpc) => {
    const query = new SubscriptionQueryServiceClientImpl(rpc)
    const resp = await withTimeout(
      query.QueryParams(SubscriptionQueryParamsRequest.fromPartial({})),
      QUERY_TIMEOUT_MS,
      'subscription.params',
    )
    const share = resp.params?.stakingShare
    if (!share) throw new Error('The chain did not report the subscription staking share')
    return share
  })
}

/**
 * Every plan this provider owns, at any status. The SDK's `plansForProvide`
 * (sic — misspelled, and it never sends a status) leaves the request's status at
 * STATUS_UNSPECIFIED, which the hub treats as "no filter" — which is what we
 * want, since a freshly created plan is INACTIVE and must still be listed.
 */
export async function listMyPlans(accountAddress: string): Promise<MyPlanInfo[]> {
  const provAddress = toProviderAddress(accountAddress)
  return withReadClient(async (client) => {
    const resp = await withTimeout(
      Promise.resolve(
        client.sentinelQuery?.plan.plansForProvide(provAddress, {
          key: new Uint8Array(),
          offset: Long.fromNumber(0, true),
          limit: Long.fromNumber(200, true),
          countTotal: false,
          reverse: false,
        }),
      ),
      QUERY_TIMEOUT_MS,
      'plan.plansForProvider',
    )
    type RawPlan = {
      id: Long
      bytes: string
      duration?: { seconds: Long; nanos: number }
      prices: { denom: string; baseValue: string; quoteValue: string }[]
      private: boolean
      status: number
    }
    return ((resp?.plans ?? []) as unknown as RawPlan[]).map((p) => ({
      id: p.id.toString(),
      bytes: p.bytes,
      durationSeconds: p.duration ? p.duration.seconds.toNumber() + (p.duration.nanos || 0) / 1e9 : null,
      prices: p.prices ?? [],
      private: p.private,
      status: p.status,
    }))
  })
}

const SUBS_PAGE_SIZE = 500
// Enough for any plan a person actually runs, and a hard stop for the ones that
// aren't: plan 36 on mainnet has 800k+ subscriptions (all from one account), and
// paging that would take minutes.
const SUBS_MAX_SCAN = 2_000

/**
 * How many subscriptions a plan has, and how many of those are active.
 *
 * The total is the chain's own `pagination.total` (one request with countTotal),
 * so it is exact and cheap. The active count has no such counter — the status
 * lives on each record — so it is scanned page by page and stops at
 * SUBS_MAX_SCAN, which `truncated` reports so the UI can say "at least".
 */
export async function getPlanSubscriberStats(planId: string): Promise<PlanSubscriberStats> {
  const id = Long.fromString(planId, true)
  return withReadClient(async (client) => {
    let key: Uint8Array = new Uint8Array()
    let total = 0
    let scanned = 0
    let active = 0
    let first = true

    while (scanned < SUBS_MAX_SCAN) {
      const resp = await withTimeout(
        Promise.resolve(
          client.sentinelQuery?.subscription.subscriptionsForPlan(id, {
            key,
            offset: Long.fromNumber(0, true),
            limit: Long.fromNumber(SUBS_PAGE_SIZE, true),
            countTotal: first,
            reverse: false,
          }),
        ),
        QUERY_TIMEOUT_MS,
        'subscription.subscriptionsForPlan',
      )
      const subs = (resp?.subscriptions ?? []) as unknown as { status: number }[]
      if (first) {
        total = Number(resp?.pagination?.total ?? subs.length) || 0
        first = false
      }
      for (const s of subs) {
        scanned++
        if (s.status === Status.STATUS_ACTIVE) active++
      }
      const nextKey = resp?.pagination?.nextKey
      if (!nextKey || nextKey.length === 0) break
      key = nextKey
    }

    return { subscriptions: total, active, truncated: scanned < total }
  })
}

/**
 * Just the lifetime subscription count for a plan — one request, `countTotal` on a
 * single-row page, so the chain does the counting.
 *
 * Deliberately not getPlanSubscriberStats: revenue only needs the total, and that
 * helper additionally pages up to SUBS_MAX_SCAN records to classify statuses. Doing
 * that for every plan on the summary strip would cost minutes on a busy plan.
 */
async function countPlanSubscriptions(planId: string): Promise<number> {
  const id = Long.fromString(planId, true)
  return withReadClient(async (client) => {
    const resp = await withTimeout(
      Promise.resolve(
        client.sentinelQuery?.subscription.subscriptionsForPlan(id, {
          key: new Uint8Array(),
          offset: Long.fromNumber(0, true),
          limit: Long.fromNumber(1, true),
          countTotal: true,
          reverse: false,
        }),
      ),
      QUERY_TIMEOUT_MS,
      'subscription.subscriptionsForPlan',
    )
    return Number(resp?.pagination?.total ?? 0) || 0
  })
}

export interface ProviderEconomics {
  /** udvpn billed per hour across every still-billing lease. */
  burnHourlyUdvpn: string
  /** The same run rate over 24h — what the UI headlines. */
  burnDailyUdvpn: string
  activeLeases: number
  /** Escrowed but unspent: what ending every lease right now would refund. */
  committedUdvpn: string
  /**
   * Cumulative plan income, net of the staking share.
   *
   * A FLOOR, and deliberately so: subscription renewals may charge again without
   * creating a new record, so this can only understate. There is intentionally no
   * profit figure to pair it with — the chain deletes leases once they end, so
   * historical spend is unknowable and any "net" would flatter by omission.
   */
  estimatedRevenueUdvpn: string
  /** Subscriptions across all of this provider's plans. */
  subscriptions: number
  /** LegacyDec (10^18-scaled): the hub's cut of plan sales. Drives break-even in the UI. */
  subscriptionStakingShare: string
  /** LegacyDec (10^18-scaled): the community-pool cut of lease payments. '' if absent. */
  leaseStakingShare: string
}

/**
 * One read of everything the provider console needs to talk about money.
 *
 * Every figure is computed here from chain values and crosses IPC finished, the same
 * rule cachedPlanCost follows. If any part fails the whole call rejects — the strip
 * shows "unavailable" rather than a partial total that reads as fact.
 */
export async function getProviderEconomics(accountAddress: string): Promise<ProviderEconomics> {
  const provAddress = toProviderAddress(accountAddress)
  const [leases, leaseParams, share, plans] = await Promise.all([
    listLeasesForProvider(provAddress),
    getLeaseParams(),
    getSubscriptionStakingShare(),
    listMyPlans(accountAddress),
  ])

  const parsedShare = parseDecShare(share)
  const burn = computeBurn(leases)

  let revenue = 0n
  let subscriptions = 0
  for (const plan of plans) {
    const count = await countPlanSubscriptions(plan.id)
    subscriptions += count
    const price = plan.prices.find((p) => p.denom === 'udvpn')?.quoteValue
    // A plan priced in some other denom earns nothing we can express in udvpn.
    if (!price) continue
    revenue += BigInt(computeEstimatedRevenue(count, netOfStakingShare(price, parsedShare)))
  }

  return {
    burnHourlyUdvpn: burn.hourlyUdvpn,
    burnDailyUdvpn: burn.dailyUdvpn,
    activeLeases: burn.activeLeases,
    committedUdvpn: computeCommitted(leases),
    estimatedRevenueUdvpn: revenue.toString(),
    subscriptions,
    subscriptionStakingShare: share,
    leaseStakingShare: leaseParams.stakingShare,
  }
}

/**
 * A node's on-chain hourly price — the figure a lease is billed at. Read from the
 * chain rather than taken from the renderer or the aggregator feed, because it is
 * what the deposit is computed from.
 */
export async function getNodeHourlyPrice(nodeAddress: string): Promise<NodePriceInfo> {
  return withReadClient(async (client) => {
    // Same NotFound-is-thrown behaviour as the provider lookup — turn it into the
    // message that actually explains the problem.
    const found = await withTimeout(
      Promise.resolve(client.sentinelQuery?.node.node(nodeAddress)),
      QUERY_TIMEOUT_MS,
      'node.node',
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (isChainNotFound(message)) return undefined
      throw err
    })
    if (!found) throw new Error(`Node ${nodeAddress} is not registered on chain`)
    const n = found as unknown as {
      hourlyPrices?: { denom: string; quoteValue: string }[]
      status?: number
    }
    const udvpn = n.hourlyPrices?.find((p) => p.denom === 'udvpn')
    return {
      address: nodeAddress,
      hourlyPrice: udvpn?.quoteValue ?? '',
      status: n.status ?? 0,
    }
  })
}

// --- writes ---

async function broadcast(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  msg: EncodeObject
  memo: string
  /** Set on txs that move funds, so the chain rejects a late-landing one. */
  bounded?: boolean
}): Promise<void> {
  const client = await withTimeout(
    SigningSentinelClient.connectWithSigner(getRpcEndpoint(), params.wallet, {
      gasPrice: GAS_PRICE,
      // Replaces the SDK default (connectWithSigner merges shallowly), which is why
      // PROVIDER_REGISTRY spreads SentinelRegistry back in — without this the lease
      // type URLs are unknown and encoding throws.
      registry: PROVIDER_REGISTRY,
    }),
    RPC_CONNECT_TIMEOUT_MS,
    'RPC connect',
  )
  try {
    const timeoutHeight = params.bounded
      ? BigInt((await client.getHeight()) + TX_TIMEOUT_HEIGHT_OFFSET)
      : undefined
    const tx = await broadcastOrTimeout(
      client.signAndBroadcast(params.accountAddress, [params.msg], 'auto', params.memo, timeoutHeight),
      TX_TIMEOUT_MESSAGE,
    )
    assertTxSucceeded(tx, 'Transaction')
  } finally {
    client.disconnect()
  }
}

/**
 * Register the wallet as a provider. Costs the module's deposit param, which the
 * hub sends to the COMMUNITY POOL — it is spent, not escrowed, and there is no
 * way to get it back. The provider is created INACTIVE; setProviderStatus follows.
 */
export async function registerProvider(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  details: ProviderDetails
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildRegisterProviderMsg(params.accountAddress, params.details),
    memo: 'katacomb-vpn: register provider',
    bounded: true,
  })
}

export async function updateProviderDetails(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  details: ProviderDetails
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildProviderDetailsMsg(toProviderAddress(params.accountAddress), params.details),
    memo: 'katacomb-vpn: update provider details',
  })
}

export async function setProviderStatus(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  active: boolean
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildProviderStatusMsg(toProviderAddress(params.accountAddress), params.active),
    memo: `katacomb-vpn: ${params.active ? 'activate' : 'deactivate'} provider`,
  })
}

/** Create a plan. It lands INACTIVE and needs setPlanStatus(true) before anyone can subscribe. */
export async function createPlan(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  input: PlanInput
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildCreatePlanMsg(toProviderAddress(params.accountAddress), params.input),
    memo: 'katacomb-vpn: create plan',
  })
}

export async function setPlanStatus(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  planId: string
  active: boolean
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildPlanStatusMsg(toProviderAddress(params.accountAddress), params.planId, params.active),
    memo: `katacomb-vpn: ${params.active ? 'activate' : 'deactivate'} plan`,
  })
}

/**
 * Buy a lease from a node operator. This is the prerequisite for linkNode — the
 * hub's HandleMsgLinkNode rejects unless HasAnyLeaseForNodeByProvider(...) — and
 * it escrows `hourlyPrice x hours` from the wallet, paid out to the node hourly
 * and refunded pro rata by endLease.
 *
 * `hourlyQuoteValue` must come from the chain (getNodeHourlyPrice), not the
 * renderer: it is sent as MaxPrice, so it is also the overpay guard.
 */
export async function startLease(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  nodeAddress: string
  hours: number
  hourlyQuoteValue: string
  renewalPricePolicy: number
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildStartLeaseMsg({
      provAddress: toProviderAddress(params.accountAddress),
      nodeAddress: params.nodeAddress,
      hours: params.hours,
      hourlyQuoteValue: params.hourlyQuoteValue,
      renewalPricePolicy: params.renewalPricePolicy,
    }),
    memo: 'katacomb-vpn: start lease',
    bounded: true,
  })
}

/** End a lease early. Refunds the unused hours and unlinks the node from every plan. */
export async function endLease(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  leaseId: string
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildEndLeaseMsg(toProviderAddress(params.accountAddress), params.leaseId),
    memo: 'katacomb-vpn: end lease',
  })
}

export async function linkNode(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  planId: string
  nodeAddress: string
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildLinkNodeMsg(toProviderAddress(params.accountAddress), params.planId, params.nodeAddress),
    memo: 'katacomb-vpn: link node to plan',
  })
}

export async function unlinkNode(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  planId: string
  nodeAddress: string
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildUnlinkNodeMsg(toProviderAddress(params.accountAddress), params.planId, params.nodeAddress),
    memo: 'katacomb-vpn: unlink node from plan',
  })
}
