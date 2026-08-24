import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import Long from 'long'
import {
  SigningSentinelClient,
  SentinelClient,
  searchEvent,
  SubscriptionEventCreateSession,
  SubscriptionEventCreate,
  Status,
  RenewalPricePolicy,
  planStartSession,
  subscriptionStartSession,
  subscriptionCancel,
  subscriptionRenew,
  subscriptionUpdate,
} from '@sentinel-official/sentinel-js-sdk'
import { BrowserWindow } from 'electron'
import { openChainFlow, openChainQuery } from './chain-clients'
import { assertTxSucceeded, broadcastOrTimeout } from './tx-utils'
import { TX_TIMEOUT_HEIGHT_OFFSET } from '../shared/chain-constants'
import { IPC } from '../shared/ipc-channels'
import { setCachedPlans, getCachedPlans, type CachedPlan } from './plan-cache'
import { getCachedProviders } from './provider-cache'
import type { ProviderInfo } from './provider-service'
import { isTestPlan } from '../shared/test-plan'

export type EnrichedPlan = CachedPlan & { isTest: boolean }

function enrichPlans(plans: CachedPlan[], providers: ProviderInfo[]): EnrichedPlan[] {
  const byAddr = new Map<string, ProviderInfo>(providers.map((p) => [p.address, p]))
  return plans.map((p) => ({
    ...p,
    isTest: isTestPlan(byAddr.get(p.provAddress)?.name),
  }))
}

const PAGE_SIZE = 50
// Bound on the subscriptionsForAccount paged read (8 pages). Beyond it the rest
// is ignored: a consumer wallet with 400+ subscriptions is out of scope.
const SUBS_MAX = 400
// A session-creating tx may confirm after we stop polling — surface that instead of a
// raw CosmJS TimeoutError so the user can check the Session tab (finding H2).
// Exported so PLAN_SMART_CONNECT can recognize a timeout and STOP its ladder
// (the tx may still land; a second one could buy a second subscription).
export const TX_TIMEOUT_MESSAGE =
  'The transaction timed out before confirmation. It may still be processing. Check ' +
  'the Session tab shortly and cancel any unexpected session.'

type ChainPlan = {
  id: Long
  provAddress: string
  bytes: string
  duration?: { seconds: Long; nanos: number }
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
}

function durationToSeconds(d?: { seconds: Long; nanos: number }): number | null {
  if (!d) return null
  try {
    return d.seconds.toNumber() + (d.nanos || 0) / 1e9
  } catch {
    return null
  }
}

function toCachedPlan(p: ChainPlan): CachedPlan {
  return {
    id: p.id.toString(),
    provAddress: p.provAddress,
    bytes: p.bytes,
    durationSeconds: durationToSeconds(p.duration),
    prices: p.prices.map((pr) => ({
      denom: pr.denom,
      baseValue: pr.baseValue,
      quoteValue: pr.quoteValue,
    })),
    private: p.private,
    status: p.status,
  }
}

function sendDiscoverProgress(done: number, total: number, phase: 'connecting' | 'fetching' | 'done'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.PLAN_DISCOVER_PROGRESS, { done, total, phase })
  }
}

export async function discoverPlans(maxCount: number): Promise<EnrichedPlan[]> {
  sendDiscoverProgress(0, maxCount, 'connecting')
  const { query: client, disconnect } = await openChainQuery()
  try {
    sendDiscoverProgress(0, maxCount, 'fetching')
    const results: CachedPlan[] = []
    let nextKey: Uint8Array = new Uint8Array()
    let firstPage = true

    while (results.length < maxCount) {
      const remaining = maxCount - results.length
      const pageLimit = Math.min(PAGE_SIZE, remaining)
      const pagination = {
        key: nextKey,
        offset: Long.fromNumber(0, true),
        limit: Long.fromNumber(pageLimit, true),
        countTotal: firstPage,
        reverse: false,
      }
      firstPage = false

      const resp = await client.sentinelQuery?.plan.plans(Status.STATUS_ACTIVE, pagination)
      if (!resp || !resp.plans) break

      for (const raw of resp.plans) {
        results.push(toCachedPlan(raw as unknown as ChainPlan))
        if (results.length >= maxCount) break
      }

      sendDiscoverProgress(results.length, maxCount, 'fetching')

      const nk = resp.pagination?.nextKey
      if (!nk || nk.length === 0) break
      nextKey = nk
    }

    setCachedPlans(results)
    sendDiscoverProgress(results.length, results.length, 'done')
    const { providers } = getCachedProviders()
    return enrichPlans(results, providers)
  } finally {
    disconnect()
  }
}

export function listCachedPlans(): { plans: EnrichedPlan[]; fetchedAt: number | null } {
  const cache = getCachedPlans()
  const { providers } = getCachedProviders()
  return { plans: enrichPlans(cache.plans, providers), fetchedAt: cache.fetchedAt }
}

const planNodesCache = new Map<string, { addresses: string[]; fetchedAt: number }>()
const PLAN_NODES_TTL_MS = 10 * 60 * 1000

/** Drop a plan's cached node list after we ourselves link/unlink one of its nodes. */
export function invalidatePlanNodes(planId: string): void {
  planNodesCache.delete(planId)
}

export async function listNodesForPlan(planId: string, sharedClient?: SentinelClient): Promise<string[]> {
  if (!/^\d+$/.test(planId)) return []
  const now = Date.now()
  const cached = planNodesCache.get(planId)
  if (cached && now - cached.fetchedAt < PLAN_NODES_TTL_MS) {
    return cached.addresses
  }

  // A shared connect-flow client stays the caller's to close (see chain-clients.ts).
  const own = sharedClient ? null : await openChainQuery()
  const client = sharedClient ?? own!.query
  try {
    const addresses: string[] = []
    let nextKey: Uint8Array = new Uint8Array()
    let firstPage = true
    const MAX_NODES = 500

    while (addresses.length < MAX_NODES) {
      const pagination = {
        key: nextKey,
        offset: Long.fromNumber(0, true),
        limit: Long.fromNumber(PAGE_SIZE, true),
        countTotal: firstPage,
        reverse: false,
      }
      firstPage = false

      const resp = await client.sentinelQuery?.node.nodesForPlan(
        Long.fromString(planId, true),
        Status.STATUS_ACTIVE,
        pagination
      )
      if (!resp || !resp.nodes) break

      for (const n of resp.nodes as unknown as { address: string }[]) {
        if (n.address) addresses.push(n.address)
        if (addresses.length >= MAX_NODES) break
      }

      const nk = resp.pagination?.nextKey
      if (!nk || nk.length === 0) break
      nextKey = nk
    }

    planNodesCache.set(planId, { addresses, fetchedAt: now })
    return addresses
  } finally {
    own?.disconnect()
  }
}

export async function listPlansForNode(nodeAddress: string): Promise<EnrichedPlan[]> {
  const cache = getCachedPlans()
  if (cache.plans.length === 0) return []

  const compatibleIds = new Set<string>()
  const queue = cache.plans.map((p) => p.id)
  const CONCURRENCY = 4

  // One connection for the whole fan-out; cache misses used to open one each.
  const { query, disconnect } = await openChainQuery()

  async function worker(): Promise<void> {
    while (true) {
      const id = queue.shift()
      if (!id) return
      try {
        const addresses = await listNodesForPlan(id, query)
        if (addresses.includes(nodeAddress)) compatibleIds.add(id)
      } catch {
        // skip individual failures; partial result is better than none
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  } finally {
    disconnect()
  }

  const compatible = cache.plans.filter((p) => compatibleIds.has(p.id))
  const { providers } = getCachedProviders()
  return enrichPlans(compatible, providers)
}

export interface PlanAllocationInfo {
  subscriptionId: string
  planId: string
  planProvAddress: string
  planBytes: string
  planDurationSeconds: number | null
  startAt: string | null
  inactiveAt: string | null
  status: number
}

type ChainSubscription = {
  id: Long
  accAddress: string
  planId: Long
  status: number
  renewalPricePolicy?: number
  inactiveAt?: Date
  startAt?: Date
}

export type SubscriptionInfo = {
  id: string
  /** '0' for a node (per-GB/hour) subscription; otherwise the plan it belongs to. */
  planId: string
  status: number
  /**
   * sentinel.types.v1.RenewalPricePolicy. 0 (UNSPECIFIED) means "never renew" —
   * the hub's Subscription.RenewalAt() returns the zero time for it, so the
   * subscription is never indexed for renewal. 7 (ALWAYS) renews at any price.
   */
  renewalPricePolicy: number
  startAt: string | null
  inactiveAt: string | null
}

/** The paged subscriptionsForAccount read every subscription view builds on. */
async function fetchSubscriptionsForAccount(
  client: SentinelClient,
  walletAddress: string,
): Promise<ChainSubscription[]> {
  const subs: ChainSubscription[] = []
  let nextKey: Uint8Array = new Uint8Array()
  while (subs.length < SUBS_MAX) {
    const resp = await client.sentinelQuery?.subscription.subscriptionsForAccount(walletAddress, {
      key: nextKey,
      offset: Long.fromNumber(0, true),
      limit: Long.fromNumber(PAGE_SIZE, true),
      countTotal: false,
      reverse: false,
    })
    const page = (resp?.subscriptions || []) as unknown as ChainSubscription[]
    subs.push(...page)
    const nk = resp?.pagination?.nextKey
    if (!nk || nk.length === 0 || page.length === 0) break
    nextKey = nk
  }
  return subs
}

function toSubscriptionInfo(s: ChainSubscription): SubscriptionInfo {
  return {
    id: s.id.toString(),
    planId: s.planId ? s.planId.toString() : '0',
    status: s.status,
    renewalPricePolicy: s.renewalPricePolicy ?? 0,
    startAt: s.startAt ? s.startAt.toISOString() : null,
    inactiveAt: s.inactiveAt ? s.inactiveAt.toISOString() : null,
  }
}

/**
 * Every subscription this wallet owns — plan-based AND node (per-GB/hour) ones,
 * which is what makes this different from queryPlanAllocations (plan-only, and
 * its callers depend on that filter).
 */
export async function querySubscriptions(walletAddress: string, sharedClient?: SentinelClient): Promise<SubscriptionInfo[]> {
  // A shared connect-flow client stays the caller's to close (see chain-clients.ts).
  const own = sharedClient ? null : await openChainQuery()
  const client = sharedClient ?? own!.query
  try {
    const subs = await fetchSubscriptionsForAccount(client, walletAddress)
    return subs.map(toSubscriptionInfo)
  } finally {
    own?.disconnect()
  }
}

/**
 * Cancel a subscription. On-chain this marks it inactive-pending and clears its
 * renewal policy — it stops renewing and its sessions end; it is NOT an instant
 * refund. Only an ACTIVE subscription can be cancelled (the hub rejects others).
 */
export async function cancelSubscription(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  subscriptionId: string
  /** Share a connect flow's signing client (see chain-clients.ts); the caller owns it. */
  client?: SigningSentinelClient
}): Promise<void> {
  const { wallet, address, subscriptionId } = params
  const ownFlow = params.client ? null : await openChainFlow(wallet)
  const client = params.client ?? ownFlow!.signing
  try {
    // Raw msg + signAndBroadcast rather than the SDK convenience method, which
    // never sets a timeoutHeight — same bound as the session-creating broadcasts.
    const msg = subscriptionCancel({
      from: address,
      id: Long.fromString(subscriptionId, true),
    })
    const timeoutHeight = BigInt((await client.getHeight()) + TX_TIMEOUT_HEIGHT_OFFSET)
    const tx = await broadcastOrTimeout(
      client.signAndBroadcast(address, [msg], 'auto', 'katacomb-vpn: cancel subscription', timeoutHeight),
      TX_TIMEOUT_MESSAGE,
    )
    assertTxSucceeded(tx, 'Transaction')
  } finally {
    ownFlow?.disconnect()
  }
}

/**
 * Renew a subscription for another period at the current on-chain price, rather
 * than buying a fresh one. Charges the plan's price again, so callers must gate
 * it on funds the same way a first subscribe does.
 */
export async function renewSubscription(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  subscriptionId: string
  denom: string
  /** Share a connect flow's signing client (see chain-clients.ts); the caller owns it. */
  client?: SigningSentinelClient
}): Promise<void> {
  const { wallet, address, subscriptionId, denom } = params
  const ownFlow = params.client ? null : await openChainFlow(wallet)
  const client = params.client ?? ownFlow!.signing
  try {
    // Raw msg form for the timeoutHeight, as in cancelSubscription above.
    const msg = subscriptionRenew({
      from: address,
      id: Long.fromString(subscriptionId, true),
      denom,
    })
    const timeoutHeight = BigInt((await client.getHeight()) + TX_TIMEOUT_HEIGHT_OFFSET)
    const tx = await broadcastOrTimeout(
      client.signAndBroadcast(address, [msg], 'auto', 'katacomb-vpn: renew subscription', timeoutHeight),
      TX_TIMEOUT_MESSAGE,
    )
    assertTxSucceeded(tx, 'Transaction')
  } finally {
    ownFlow?.disconnect()
  }
}

/** Change a subscription's auto-renewal price policy (0 = never renew). */
export async function updateSubscriptionPolicy(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  subscriptionId: string
  policy: number
  /** Share a connect flow's signing client (see chain-clients.ts); the caller owns it. */
  client?: SigningSentinelClient
}): Promise<void> {
  const { wallet, address, subscriptionId, policy } = params
  const ownFlow = params.client ? null : await openChainFlow(wallet)
  const client = params.client ?? ownFlow!.signing
  try {
    // Raw msg form for the timeoutHeight, as in cancelSubscription above.
    const msg = subscriptionUpdate({
      from: address,
      id: Long.fromString(subscriptionId, true),
      renewalPricePolicy: policy as RenewalPricePolicy,
    })
    const timeoutHeight = BigInt((await client.getHeight()) + TX_TIMEOUT_HEIGHT_OFFSET)
    const tx = await broadcastOrTimeout(
      client.signAndBroadcast(address, [msg], 'auto', 'katacomb-vpn: update renewal policy', timeoutHeight),
      TX_TIMEOUT_MESSAGE,
    )
    assertTxSucceeded(tx, 'Transaction')
  } finally {
    ownFlow?.disconnect()
  }
}

/**
 * Resolve plan rows for the given ids, reading the plan cache first and hitting
 * the chain (in parallel, best-effort) only for ids the cache doesn't know.
 */
async function resolvePlanDetails(client: SentinelClient, planIds: string[]): Promise<Map<string, CachedPlan>> {
  const details = new Map<string, CachedPlan>()
  const cachedById = new Map(getCachedPlans().plans.map((p) => [p.id, p]))
  const missing: string[] = []
  for (const pid of planIds) {
    const hit = cachedById.get(pid)
    if (hit) details.set(pid, hit)
    else missing.push(pid)
  }
  await Promise.allSettled(missing.map(async (pid) => {
    const p = await client.sentinelQuery?.plan.plan(Long.fromString(pid, true))
    if (p) details.set(pid, toCachedPlan(p as unknown as ChainPlan))
  }))
  return details
}

/** Plan-based subscriptions joined with their plan's size and validity. */
function joinAllocations(planSubs: ChainSubscription[], planDetails: Map<string, CachedPlan>): PlanAllocationInfo[] {
  return planSubs.map((s) => {
    const pid = s.planId.toString()
    const plan = planDetails.get(pid)
    return {
      subscriptionId: s.id.toString(),
      planId: pid,
      planProvAddress: plan?.provAddress || '',
      planBytes: plan?.bytes || '0',
      planDurationSeconds: plan ? plan.durationSeconds : null,
      startAt: s.startAt ? s.startAt.toISOString() : null,
      inactiveAt: s.inactiveAt ? s.inactiveAt.toISOString() : null,
      status: s.status,
    }
  })
}

function onlyPlanSubs(subs: ChainSubscription[]): ChainSubscription[] {
  return subs.filter((s) => s.planId && !s.planId.isZero())
}

export async function queryPlanAllocations(walletAddress: string, sharedClient?: SentinelClient): Promise<PlanAllocationInfo[]> {
  // A shared connect-flow client stays the caller's to close (see chain-clients.ts).
  const own = sharedClient ? null : await openChainQuery()
  const client = sharedClient ?? own!.query
  try {
    const subs = await fetchSubscriptionsForAccount(client, walletAddress)
    const planSubs = onlyPlanSubs(subs)
    if (planSubs.length === 0) return []
    const uniquePlanIds = Array.from(new Set(planSubs.map((s) => s.planId.toString())))
    const planDetails = await resolvePlanDetails(client, uniquePlanIds)
    return joinAllocations(planSubs, planDetails)
  } finally {
    own?.disconnect()
  }
}

export interface PlanOverview {
  plans: EnrichedPlan[]
  fetchedAt: number | null
  subscriptions: SubscriptionInfo[]
  allocations: PlanAllocationInfo[]
}

/**
 * Everything the Plans tab needs in one round-trip: cached plans plus ONE paged
 * subscriptionsForAccount read feeding both the subscription list and the
 * allocations join. Replaces the tab's separate PLAN_LIST_CACHED /
 * SUBSCRIPTION_LIST / PLAN_ALLOCATIONS calls (three connections, two of them
 * reading the same rows).
 */
export async function getPlanOverview(walletAddress: string): Promise<PlanOverview> {
  const { query, disconnect } = await openChainQuery()
  try {
    const subs = await fetchSubscriptionsForAccount(query, walletAddress)
    const planSubs = onlyPlanSubs(subs)
    const uniquePlanIds = Array.from(new Set(planSubs.map((s) => s.planId.toString())))
    const planDetails = await resolvePlanDetails(query, uniquePlanIds)
    const { plans, fetchedAt } = listCachedPlans()
    return {
      plans,
      fetchedAt,
      subscriptions: subs.map(toSubscriptionInfo),
      allocations: joinAllocations(planSubs, planDetails),
    }
  } finally {
    disconnect()
  }
}

/**
 * A plan's last known node list, TTL ignored — for answering while our own
 * tunnel makes the chain unreachable, where stale beats a false "no nodes".
 */
export function getCachedPlanNodes(planId: string): string[] | null {
  return planNodesCache.get(planId)?.addresses ?? null
}

export async function startSessionWithExistingSubscription(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  subscriptionId: string
  nodeAddress: string
  /** Share a connect flow's signing client (see chain-clients.ts); the caller owns it. */
  client?: SigningSentinelClient
}): Promise<{ sessionId: string; subscriptionId: string }> {
  const { wallet, address, subscriptionId, nodeAddress } = params
  const ownFlow = params.client ? null : await openChainFlow(wallet)
  const client = params.client ?? ownFlow!.signing
  try {
    // The raw msg + signAndBroadcast form (not the SDK convenience method) so a
    // timeoutHeight can bound how late this session-creating tx can land, the
    // same way subscribeToNode's does (H2).
    const msg = subscriptionStartSession({
      from: address,
      id: Long.fromString(subscriptionId, true),
      nodeAddress,
    })
    const timeoutHeight = BigInt((await client.getHeight()) + TX_TIMEOUT_HEIGHT_OFFSET)
    const tx = await broadcastOrTimeout(
      client.signAndBroadcast(address, [msg], 'auto', 'katacomb-vpn: subscription start session', timeoutHeight),
      TX_TIMEOUT_MESSAGE,
    )

    assertTxSucceeded(tx, 'Transaction')

    const sessionEvent = searchEvent(SubscriptionEventCreateSession.type, tx.events)
    if (!sessionEvent) {
      throw new Error('Could not find session creation event in subscription transaction')
    }
    const parsed = SubscriptionEventCreateSession.parse(sessionEvent)
    const sessionId = parsed.value.sessionId
    if (!sessionId) throw new Error('Session ID missing from subscription event')

    return {
      sessionId: sessionId.toString(),
      subscriptionId: parsed.value.subscriptionId?.toString() || subscriptionId,
    }
  } finally {
    ownFlow?.disconnect()
  }
}

export async function subscribeToPlan(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  planId: string
  denom: string
  nodeAddress: string
  /** sentinel.types.v1.RenewalPricePolicy; defaults to ALWAYS (previous behavior). */
  renewalPricePolicy?: number
  /** Share a connect flow's signing client (see chain-clients.ts); the caller owns it. */
  client?: SigningSentinelClient
}): Promise<{ sessionId: string; subscriptionId: string }> {
  const { wallet, address, planId, denom, nodeAddress } = params
  const renewalPricePolicy = params.renewalPricePolicy ?? RenewalPricePolicy.RENEWAL_PRICE_POLICY_ALWAYS
  const ownFlow = params.client ? null : await openChainFlow(wallet)
  const client = params.client ?? ownFlow!.signing
  try {
    // Raw msg + signAndBroadcast rather than the SDK convenience method, so the
    // session-creating tx carries a timeoutHeight like subscribeToNode's (H2).
    const msg = planStartSession({
      from: address,
      id: Long.fromString(planId, true),
      denom,
      renewalPricePolicy: renewalPricePolicy as RenewalPricePolicy,
      nodeAddress,
    })
    const timeoutHeight = BigInt((await client.getHeight()) + TX_TIMEOUT_HEIGHT_OFFSET)
    const tx = await broadcastOrTimeout(
      client.signAndBroadcast(address, [msg], 'auto', 'katacomb-vpn: plan start session', timeoutHeight),
      TX_TIMEOUT_MESSAGE,
    )

    assertTxSucceeded(tx, 'Transaction')

    const sessionEvent = searchEvent(SubscriptionEventCreateSession.type, tx.events)
    if (!sessionEvent) {
      throw new Error('Could not find session creation event in plan transaction')
    }
    const parsedSession = SubscriptionEventCreateSession.parse(sessionEvent)
    const sessionId = parsedSession.value.sessionId
    const subscriptionId = parsedSession.value.subscriptionId
    if (!sessionId) throw new Error('Session ID missing from plan event')

    // Also confirm subscription created (best-effort)
    if (!subscriptionId) {
      const createEvent = searchEvent(SubscriptionEventCreate.type, tx.events)
      if (createEvent) {
        const parsedCreate = SubscriptionEventCreate.parse(createEvent)
        return {
          sessionId: sessionId.toString(),
          subscriptionId: parsedCreate.value.subscriptionId?.toString() || '',
        }
      }
    }

    return {
      sessionId: sessionId.toString(),
      subscriptionId: subscriptionId?.toString() || '',
    }
  } finally {
    ownFlow?.disconnect()
  }
}
