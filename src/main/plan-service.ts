import { GasPrice } from '@cosmjs/stargate'
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
} from '@sentinel-official/sentinel-js-sdk'
import { BrowserWindow } from 'electron'
import { getRpcEndpoint } from './settings'
import { GAS_PRICE_STR } from '../shared/chain-constants'
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

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
const PAGE_SIZE = 50

type SentinelPlan = {
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

function toCachedPlan(p: SentinelPlan): CachedPlan {
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
  const client = await SentinelClient.connect(getRpcEndpoint())
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
        results.push(toCachedPlan(raw as unknown as SentinelPlan))
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
    client.disconnect()
  }
}

export function listCachedPlans(): { plans: EnrichedPlan[]; fetchedAt: number | null } {
  const cache = getCachedPlans()
  const { providers } = getCachedProviders()
  return { plans: enrichPlans(cache.plans, providers), fetchedAt: cache.fetchedAt }
}

const planNodesCache = new Map<string, { addresses: string[]; fetchedAt: number }>()
const PLAN_NODES_TTL_MS = 10 * 60 * 1000

export async function listNodesForPlan(planId: string): Promise<string[]> {
  if (!/^\d+$/.test(planId)) return []
  const now = Date.now()
  const cached = planNodesCache.get(planId)
  if (cached && now - cached.fetchedAt < PLAN_NODES_TTL_MS) {
    return cached.addresses
  }

  const client = await SentinelClient.connect(getRpcEndpoint())
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
    client.disconnect()
  }
}

export async function listPlansForNode(nodeAddress: string): Promise<EnrichedPlan[]> {
  const cache = getCachedPlans()
  if (cache.plans.length === 0) return []

  const compatibleIds = new Set<string>()
  const queue = cache.plans.map((p) => p.id)
  const CONCURRENCY = 4

  async function worker(): Promise<void> {
    while (true) {
      const id = queue.shift()
      if (!id) return
      try {
        const addresses = await listNodesForPlan(id)
        if (addresses.includes(nodeAddress)) compatibleIds.add(id)
      } catch {
        // skip individual failures; partial result is better than none
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

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

type SentinelSubscription = {
  id: Long
  accAddress: string
  planId: Long
  status: number
  inactiveAt?: Date
  startAt?: Date
}

export async function queryPlanAllocations(walletAddress: string): Promise<PlanAllocationInfo[]> {
  const client = await SentinelClient.connect(getRpcEndpoint())
  try {
    const resp = await client.sentinelQuery?.subscription.subscriptionsForAccount(walletAddress, {
      key: new Uint8Array(),
      offset: Long.fromNumber(0, true),
      limit: Long.fromNumber(50, true),
      countTotal: false,
      reverse: false,
    })
    const subs = (resp?.subscriptions || []) as unknown as SentinelSubscription[]
    // Only plan-based subscriptions (planId > 0)
    const planSubs = subs.filter((s) => s.planId && !s.planId.isZero())
    if (planSubs.length === 0) return []

    // Resolve plan details for each unique planId
    const uniquePlanIds = Array.from(new Set(planSubs.map((s) => s.planId.toString())))
    const planDetails = new Map<string, SentinelPlan>()
    for (const pid of uniquePlanIds) {
      try {
        const p = await client.sentinelQuery?.plan.plan(Long.fromString(pid, true))
        if (p) planDetails.set(pid, p as unknown as SentinelPlan)
      } catch {
        // best-effort per plan
      }
    }

    return planSubs.map((s) => {
      const pid = s.planId.toString()
      const plan = planDetails.get(pid)
      return {
        subscriptionId: s.id.toString(),
        planId: pid,
        planProvAddress: plan?.provAddress || '',
        planBytes: plan?.bytes || '0',
        planDurationSeconds: plan ? durationToSeconds(plan.duration) : null,
        startAt: s.startAt ? s.startAt.toISOString() : null,
        inactiveAt: s.inactiveAt ? s.inactiveAt.toISOString() : null,
        status: s.status,
      }
    })
  } finally {
    client.disconnect()
  }
}

export async function startSessionWithExistingSubscription(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  subscriptionId: string
  nodeAddress: string
}): Promise<{ sessionId: string; subscriptionId: string }> {
  const { wallet, address, subscriptionId, nodeAddress } = params
  const client = await SigningSentinelClient.connectWithSigner(getRpcEndpoint(), wallet, {
    gasPrice: GAS_PRICE,
  })
  try {
    const tx = await client.subscriptionStartSession({
      from: address,
      id: Long.fromString(subscriptionId, true),
      nodeAddress,
      memo: 'sentinel-dvpn-app: subscription start session',
    } as Parameters<typeof client.subscriptionStartSession>[0])

    if (tx.code !== 0) {
      throw new Error(`Transaction failed with code ${tx.code}: ${tx.rawLog}`)
    }

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
    client.disconnect()
  }
}

export async function subscribeToPlan(params: {
  wallet: DirectSecp256k1HdWallet
  address: string
  planId: string
  denom: string
  nodeAddress: string
}): Promise<{ sessionId: string; subscriptionId: string }> {
  const { wallet, address, planId, denom, nodeAddress } = params
  const client = await SigningSentinelClient.connectWithSigner(getRpcEndpoint(), wallet, {
    gasPrice: GAS_PRICE,
  })
  try {
    const tx = await client.planStartSession({
      from: address,
      id: Long.fromString(planId, true),
      denom,
      renewalPricePolicy: RenewalPricePolicy.RENEWAL_PRICE_POLICY_ALWAYS,
      nodeAddress,
      memo: 'sentinel-dvpn-app: plan start session',
    } as Parameters<typeof client.planStartSession>[0])

    if (tx.code !== 0) {
      throw new Error(`Transaction failed with code ${tx.code}: ${tx.rawLog}`)
    }

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
    client.disconnect()
  }
}
