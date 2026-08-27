// Provider-side chain operations: register a provider, publish plans, and lease
// nodes into them. The consumer-side counterpart is plan-service.ts, whose
// conventions this file follows exactly — a fresh client per call wrapped in
// `withTimeout`, `disconnect()` in a `finally`, every broadcast through
// `broadcastOrTimeout` + `assertTxSucceeded` with an unconditional timeoutHeight.
// Writes additionally serialize through withProviderWriteLock, and aggregate
// reads can thread one shared connection instead of opening one per query.
//
// Everything here is deliberately single-tx and stateless. The chain flows are
// multi-step (register → activate, create → activate, lease → link) and the
// intermediate state lives on chain, so a failed second step leaves a row the UI
// can resume from rather than a half-written local wizard.
//
// Message construction and the lease registry live in provider-msgs.ts (pure,
// unit-tested) — see the notes there on the SDK's broken planCreate() and its
// missing lease module.

import { GasPrice, type ProtobufRpcClient } from '@cosmjs/stargate'
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
import { listLeasesForProvider, getLeaseParams, type LeaseInfo } from './lease-query'
import {
  computeBurn,
  computeCommitted,
  computeEstimatedRevenue,
  netOfStakingShare,
  parseDecShare,
} from '../shared/provider-economics'
import { assertTxSucceeded, broadcastOrTimeout, isChainNotFound } from './tx-utils'
import { GAS_PRICE_STR, TX_TIMEOUT_HEIGHT_OFFSET } from '../shared/chain-constants'
import { openChainQuery, resolveRpcBase, TX_POLL_INTERVAL_MS, type ChainQuery } from './chain-clients'
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
  buildUpdatePlanDetailsMsg,
  buildUpdateLeaseMsg,
  buildRenewLeaseMsg,
} from './provider-msgs'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
const RPC_CONNECT_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 10_000
// Bound on the whole economics aggregation (one read per plan on top of the four
// base reads), so a stalling RPC can't hang the strip for minutes.
const ECONOMICS_TIMEOUT_MS = 30_000
// Deliberately NOT plan-service's TX_TIMEOUT_MESSAGE: same situation, but each
// points the user at its own tab. Siblings, not a duplicate to merge.
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
  /** When the status last changed, ISO string. null when not registered or not reported. */
  statusAt: string | null
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

/**
 * Run `fn` against a short-lived read client. When `shared` is passed (an
 * aggregate read reusing one connection), the caller keeps ownership and nothing
 * is opened or disconnected here.
 */
async function withReadClient<T>(fn: (c: SentinelClient) => Promise<T>, shared?: SentinelClient): Promise<T> {
  if (shared) return fn(shared)
  const base = await resolveRpcBase(getRpcEndpoint())
  const client = await withTimeout(SentinelClient.connect(base), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  try {
    return await fn(client)
  } finally {
    client.disconnect()
  }
}

/**
 * The SDK types `sentinelQuery` as optional. A missing one is an infrastructure
 * failure and must THROW: reached through optional chaining it decayed into an
 * empty result, which the callers here translate into chain facts ("you have no
 * provider", "zero plans", "node not registered") — false statements.
 */
function queryOf(client: SentinelClient): NonNullable<SentinelClient['sentinelQuery']> {
  const q = client.sentinelQuery
  if (!q) throw new Error('Chain query client unavailable')
  return q
}

function unregistered(address: string): MyProviderInfo {
  return { address, registered: false, name: '', identity: '', website: '', description: '', status: 0, statusAt: null }
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
export async function getMyProvider(accountAddress: string, shared?: SentinelClient): Promise<MyProviderInfo> {
  const address = toProviderAddress(accountAddress)
  return withReadClient(async (client) => {
    const found = await withTimeout(
      queryOf(client).provider.provider(address),
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
    // `statusAt` rides the same cast: it is a Date on the wire and has to be
    // flattened to a string to cross IPC at all.
    const p = found as unknown as Omit<MyProviderInfo, 'status' | 'statusAt'> & { status?: number; statusAt?: Date }
    return {
      address,
      registered: true,
      name: p.name ?? '',
      identity: p.identity ?? '',
      website: p.website ?? '',
      description: p.description ?? '',
      status: p.status ?? 0,
      statusAt: p.statusAt instanceof Date ? p.statusAt.toISOString() : null,
    }
  }, shared)
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
    // Fail closed, like the staking share below: a response that names no
    // denomination is a read failure, and defaulting it priced registration as
    // free whenever the param could not actually be read. A genuinely zero
    // deposit still arrives with its denom set (proto3 omits only the amount,
    // whose '' therefore IS the value 0).
    const deposit = resp.params?.deposit
    if (!deposit?.denom) throw new Error('The chain did not report the provider deposit')
    return { denom: deposit.denom, amount: deposit.amount || '0' }
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
async function getSubscriptionStakingShare(shared?: ProtobufRpcClient): Promise<string> {
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
  }, shared)
}

const PLANS_PAGE_SIZE = 200
const MAX_PLANS = 1000

/**
 * Every plan this provider owns, at any status. The SDK's `plansForProvide`
 * (sic — misspelled, and it never sends a status) leaves the request's status at
 * STATUS_UNSPECIFIED, which the hub treats as "no filter" — which is what we
 * want, since a freshly created plan is INACTIVE and must still be listed.
 * Paginated like lease-query, with the same hard stop.
 */
export async function listMyPlans(accountAddress: string, shared?: SentinelClient): Promise<MyPlanInfo[]> {
  const provAddress = toProviderAddress(accountAddress)
  return withReadClient(async (client) => {
    type RawPlan = {
      id: Long
      bytes: string
      duration?: { seconds: Long; nanos: number }
      prices: { denom: string; baseValue: string; quoteValue: string }[]
      private: boolean
      status: number
    }
    const out: MyPlanInfo[] = []
    let key: Uint8Array = new Uint8Array()

    while (out.length < MAX_PLANS) {
      const resp = await withTimeout(
        queryOf(client).plan.plansForProvide(provAddress, {
          key,
          offset: Long.fromNumber(0, true),
          limit: Long.fromNumber(PLANS_PAGE_SIZE, true),
          countTotal: false,
          reverse: false,
        }),
        QUERY_TIMEOUT_MS,
        'plan.plansForProvider',
      )
      const plans = (resp?.plans ?? []) as unknown as RawPlan[]
      for (const p of plans) {
        out.push({
          id: p.id.toString(),
          bytes: p.bytes,
          durationSeconds: p.duration ? p.duration.seconds.toNumber() + (p.duration.nanos || 0) / 1e9 : null,
          prices: p.prices ?? [],
          private: p.private,
          status: p.status,
        })
      }
      const nextKey = resp?.pagination?.nextKey
      if (!nextKey || nextKey.length === 0) break
      key = nextKey
    }

    return out
  }, shared)
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
export async function getPlanSubscriberStats(planId: string, shared?: SentinelClient): Promise<PlanSubscriberStats> {
  const id = Long.fromString(planId, true)
  return withReadClient(async (client) => {
    let key: Uint8Array = new Uint8Array()
    let total = 0
    let scanned = 0
    let active = 0
    let first = true
    // Whether the scan saw every record. Keyed off the pagination cursor, not
    // `scanned < total`: the chain's `total` is a separate counter and when it
    // disagrees with the rows actually returned, an exhausted scan must still
    // report itself as complete.
    let exhausted = false

    while (scanned < SUBS_MAX_SCAN) {
      const resp = await withTimeout(
        queryOf(client).subscription.subscriptionsForPlan(id, {
          key,
          offset: Long.fromNumber(0, true),
          limit: Long.fromNumber(SUBS_PAGE_SIZE, true),
          countTotal: first,
          reverse: false,
        }),
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
      if (!nextKey || nextKey.length === 0) {
        exhausted = true
        break
      }
      key = nextKey
    }

    return { subscriptions: total, active, truncated: !exhausted }
  }, shared)
}

/**
 * Just the lifetime subscription count for a plan — one request, `countTotal` on a
 * single-row page, so the chain does the counting.
 *
 * Deliberately not getPlanSubscriberStats: revenue only needs the total, and that
 * helper additionally pages up to SUBS_MAX_SCAN records to classify statuses. Doing
 * that for every plan on the summary strip would cost minutes on a busy plan.
 */
async function countPlanSubscriptions(planId: string, shared?: SentinelClient): Promise<number> {
  const id = Long.fromString(planId, true)
  return withReadClient(async (client) => {
    const resp = await withTimeout(
      queryOf(client).subscription.subscriptionsForPlan(id, {
        key: new Uint8Array(),
        offset: Long.fromNumber(0, true),
        limit: Long.fromNumber(1, true),
        countTotal: true,
        reverse: false,
      }),
      QUERY_TIMEOUT_MS,
      'subscription.subscriptionsForPlan',
    )
    return Number(resp?.pagination?.total ?? 0) || 0
  }, shared)
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
 *
 * The whole aggregation rides ONE connection (it used to open one per query — a
 * 200-plan provider cost 204 connects) and is bounded as a whole, since the
 * per-plan loop multiplies the per-query timeout by the plan count.
 */
export async function getProviderEconomics(accountAddress: string, shared?: ChainQuery): Promise<ProviderEconomics> {
  const provAddress = toProviderAddress(accountAddress)
  const q = shared ?? (await openChainQuery())
  try {
    return await withTimeout(readEconomics(accountAddress, provAddress, q), ECONOMICS_TIMEOUT_MS, 'provider economics')
  } finally {
    if (!shared) q.disconnect()
  }
}

async function readEconomics(accountAddress: string, provAddress: string, q: ChainQuery): Promise<ProviderEconomics> {
  const [leases, leaseParams, share, plans] = await Promise.all([
    listLeasesForProvider(provAddress, q.protobufRpc),
    getLeaseParams(q.protobufRpc),
    getSubscriptionStakingShare(q.protobufRpc),
    listMyPlans(accountAddress, q.query),
  ])

  const parsedShare = parseDecShare(share)
  const burn = computeBurn(leases)

  let revenue = 0n
  let subscriptions = 0
  for (const plan of plans) {
    const count = await countPlanSubscriptions(plan.id, q.query)
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

export interface ProviderOverview {
  provider: MyProviderInfo
  plans: MyPlanInfo[]
  leases: LeaseInfo[]
  /** null when the economics half failed; the strip shows "unavailable". */
  economics: ProviderEconomics | null
}

/**
 * Everything the Provider tab renders, in one read over one connection — the
 * provider-side sibling of getPlanOverview. Provider, plans and leases are
 * required (any failure fails the whole read, so a cached answer can be served
 * instead of a partial one); economics stays best-effort, preserving its
 * independent "unavailable" rendering.
 */
export async function getProviderOverview(accountAddress: string): Promise<ProviderOverview> {
  const q = await openChainQuery()
  try {
    const provider = await getMyProvider(accountAddress, q.query)
    if (!provider.registered) {
      // Genuinely empty, not unknown: an unregistered provider cannot own plans
      // or leases, so nothing else is worth a query.
      return { provider, plans: [], leases: [], economics: null }
    }
    const [plans, leases] = await Promise.all([
      listMyPlans(accountAddress, q.query),
      listLeasesForProvider(provider.address, q.protobufRpc),
    ])
    const economics = await getProviderEconomics(accountAddress, q).catch(() => null)
    return { provider, plans, leases, economics }
  } finally {
    q.disconnect()
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
      queryOf(client).node.node(nodeAddress),
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

// Serializes every provider tx. Each broadcast connects a fresh signing client,
// which fetches the account sequence at sign time — so two writes in flight from
// the one wallet sign the SAME sequence and the loser lands as a raw "account
// sequence mismatch" (same collision the multihop refunds serialize around).
// Same shape as ipc-handlers' withConnectionLock.
let providerWriteLock: Promise<unknown> = Promise.resolve()
function withProviderWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = providerWriteLock.then(fn, fn)
  providerWriteLock = run.then(() => {}, () => {})
  return run
}

async function broadcast(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  msg: EncodeObject
  memo: string
}): Promise<void> {
  return withProviderWriteLock(async () => {
    const base = await resolveRpcBase(getRpcEndpoint())
    const client = await withTimeout(
      SigningSentinelClient.connectWithSigner(base, params.wallet, {
        gasPrice: GAS_PRICE,
        // Replaces the SDK default (connectWithSigner merges shallowly), which is why
        // PROVIDER_REGISTRY spreads SentinelRegistry back in — without this the lease
        // type URLs are unknown and encoding throws.
        registry: PROVIDER_REGISTRY,
        broadcastPollIntervalMs: TX_POLL_INTERVAL_MS,
      }),
      RPC_CONNECT_TIMEOUT_MS,
      'RPC connect',
    )
    try {
      // Unconditional: even a "gas-only" provider tx changes on-chain state that
      // a minutes-late landing would silently rewrite (endLease moves funds;
      // deactivation cascades through every lease, link and plan). Past this
      // height the chain rejects the tx, so a timeout reported to the user stays
      // a timeout.
      const height = await withTimeout(client.getHeight(), QUERY_TIMEOUT_MS, 'chain height')
      const timeoutHeight = BigInt(height + TX_TIMEOUT_HEIGHT_OFFSET)
      const tx = await broadcastOrTimeout(
        client.signAndBroadcast(params.accountAddress, [params.msg], 'auto', params.memo, timeoutHeight),
        TX_TIMEOUT_MESSAGE,
      )
      assertTxSucceeded(tx, 'Transaction')
    } finally {
      client.disconnect()
    }
  })
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
 * Flip a plan between public and private.
 *
 * Gas only, and the hub imposes no status precondition — a live plan can be
 * hidden without deactivating it first.
 */
export async function updatePlanDetails(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  planId: string
  private: boolean
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildUpdatePlanDetailsMsg(toProviderAddress(params.accountAddress), params.planId, params.private),
    memo: `katacomb-vpn: make plan ${params.private ? 'private' : 'public'}`,
  })
}

/**
 * Change a live lease's renewal price policy. Gas only, ownership is the only
 * check the hub makes — and it is the sole way out of a lease bought under
 * policy 0, which can otherwise never renew by any route.
 */
export async function updateLease(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  leaseId: string
  renewalPricePolicy: number
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildUpdateLeaseMsg(toProviderAddress(params.accountAddress), params.leaseId, params.renewalPricePolicy),
    memo: 'katacomb-vpn: update lease renewal policy',
  })
}

/**
 * Renew a lease early. Moves funds: the hub refunds the old escrow and charges a
 * fresh `hourlyPrice x hours` for the whole new term rather than topping the
 * existing one up.
 *
 * `hourlyQuoteValue` must come from the chain (getNodeHourlyPrice), not the
 * renderer: it is sent as MaxPrice, so it is also the overpay guard.
 */
export async function renewLease(params: {
  wallet: DirectSecp256k1HdWallet
  accountAddress: string
  leaseId: string
  hours: number
  hourlyQuoteValue: string
}): Promise<void> {
  await broadcast({
    wallet: params.wallet,
    accountAddress: params.accountAddress,
    msg: buildRenewLeaseMsg({
      provAddress: toProviderAddress(params.accountAddress),
      leaseId: params.leaseId,
      hours: params.hours,
      hourlyQuoteValue: params.hourlyQuoteValue,
    }),
    memo: 'katacomb-vpn: renew lease',
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
