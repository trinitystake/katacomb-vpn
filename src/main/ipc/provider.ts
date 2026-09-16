import { IPC } from '../../shared/ipc-channels'
import { registrationDepositCost } from '../../shared/funds'
import { assertValidProviderDetails } from '../../shared/provider-details'
import { renewalPolicyRefusal } from '../../shared/renewal-policy'
import { isRpcConnectivityError } from '../../shared/rpc-health'
import { openChainQuery } from '../chain/chain-clients'
import { assertSufficientFunds, noteChainError } from '../chain/chain-guards'
import { getLeaseParams, listLeasesForProvider } from '../chain/lease-query'
import { getTokenPrice } from '../chain/price-service'
import { reportRpcFailure } from '../chain/rpc-monitor'
import { getAddress, getWallet } from '../chain/wallet'
import { invalidateAllPlanNodes, invalidatePlanNodes, listNodesForPlan } from '../plans/plan-service'
import {
  getCachedProviders,
  getCachedProviderOverview,
  setCachedProviderOverview,
} from '../provider/provider-cache'
import {
  createPlan,
  endLease,
  getNodeHourlyPrice,
  getPlanSubscriberStats,
  getProviderDeposit,
  getProviderOverview,
  linkNode,
  registerProvider,
  renewLease,
  setPlanStatus,
  setProviderStatus,
  startLease,
  unlinkNode,
  updateLease,
  updatePlanDetails,
  updateProviderDetails,
} from '../provider/provider-console'
import {
  assertValidLeaseHours,
  leaseDepositNumber,
  leaseDepositUdvpn,
  toProviderAddress,
} from '../provider/provider-msgs'
import { getProvider, listProviders } from '../provider/provider-service'
import { loadSettings, setWalletProviderMode } from '../settings'
import { isVpnActive } from '../vpn/vpn-manager'
import {
  assertIntRange,
  assertOptionalString,
  assertSentAddress,
  assertString,
} from './validate'
import type { Handle } from './handle'

/**
 * The provider console: acting AS a provider rather than consuming one.
 * Registration, plans, node links and the x/lease term management behind them,
 * plus the token price the lease quotes are displayed in.
 *
 * These touch none of the connection state in ipc-handlers.ts - every one is a
 * single transaction or a single query against the chain, and the multi-step
 * flows (register then activate, lease then link) are resumable because the
 * middle state lives on chain rather than in a local wizard.
 *
 * They do refuse while the tunnel is up: the chain is unreachable through it.
 */
export function registerProviderHandlers(handle: Handle): void {
  handle(IPC.PROVIDER_GET, async (_event, params: { address: string }) => {
    assertString(params?.address, 'address')
    assertSentAddress(params.address, 'address')
    try {
      return await getProvider(params.address)
    } catch {
      reportRpcFailure()
      const cached = getCachedProviders().providers
      return cached.find((p) => p.address === params.address) ?? null
    }
  })

  handle(IPC.PROVIDER_LIST, async () => {
    try {
      return await listProviders()
    } catch {
      reportRpcFailure()
      return getCachedProviders().providers
    }
  })

  // --- Provider console ---
  //
  // Every one of these talks to the chain live: there is no cache to fall back on
  // and a stale answer would be worse than none (a provider registered seconds ago
  // must show as registered). So reads AND writes refuse while the tunnel is up,
  // rather than lying. Writes additionally go through assertSufficientFunds with a
  // cost computed HERE from on-chain data — never from a renderer-supplied figure.

  /** Reads that need the wallet's account address, and the chain to be reachable. */
  function requireProviderContext(): { wallet: NonNullable<ReturnType<typeof getWallet>>; address: string } {
    const wallet = getWallet()
    const address = getAddress()
    if (!wallet || !address) throw new Error('Wallet not loaded')
    if (isVpnActive()) {
      throw new Error('Provider actions need the blockchain, which is unreachable through the VPN tunnel. Disconnect first.')
    }
    return { wallet, address }
  }

  /**
   * The lease is read back from the provider's own list rather than trusted from
   * the renderer: that carries the ownership check (the hub only accepts a lease
   * msg from its own provider), the stored price the renewal policy compares
   * against, and a friendly refusal instead of a broadcast the chain rejects at
   * the cost of gas and a raw rawLog.
   */
  async function assertOwnLease(accountAddress: string, leaseId: string) {
    const leases = await listLeasesForProvider(toProviderAddress(accountAddress)).catch(noteChainError)
    const lease = leases.find((l) => l.id === leaseId)
    if (!lease) throw new Error('That lease is no longer on chain. Reopen the Provider tab to see the current state.')
    return lease
  }

  /**
   * Everything the Provider tab renders, in one round-trip: provider record,
   * plans, leases and economics, plus `stale` and `fetchedAt`.
   *
   * While the tunnel is up (or the live read fails) it serves the last good
   * answer marked `stale: true` — the PLAN_OVERVIEW pattern — so the tab stays
   * readable while mutations are refused by requireProviderContext. `null` means
   * there is nothing safe to show (no cache for THIS address): the renderer must
   * keep whatever it already has rather than treat it as "no provider".
   */
  handle(IPC.PROVIDER_OVERVIEW, async () => {
    const address = getAddress()
    if (!address) throw new Error('Wallet not loaded')
    const cachedForActive = () => {
      const cachedOverview = getCachedProviderOverview(address)
      return cachedOverview
        ? { ...cachedOverview.data, fetchedAt: cachedOverview.fetchedAt, stale: true }
        : null
    }
    if (isVpnActive()) return cachedForActive()
    try {
      const data = await getProviderOverview(address)
      const fetchedAt = Date.now()
      setCachedProviderOverview(address, data, fetchedAt)
      return { ...data, fetchedAt, stale: false }
    } catch (err) {
      const cached = cachedForActive()
      // noteChainError classifies and reports the connectivity case itself, so
      // only the serve-from-cache path reports here (and only for connectivity —
      // a decode error must not accuse the endpoint).
      if (!cached) return noteChainError(err)
      const message = err instanceof Error ? err.message : String(err)
      if (isRpcConnectivityError(message)) reportRpcFailure()
      return cached
    }
  })

  // Reveals the Provider tab for the ACTIVE wallet only. Read back off the wallet
  // entry (walletList / walletStoreStatus), so there's no getter here.
  handle(IPC.PROVIDER_MODE_SET, async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid providerMode: expected boolean')
    const activeWalletId = loadSettings().activeWalletId
    if (!activeWalletId) throw new Error('No active wallet')
    setWalletProviderMode(activeWalletId, enabled)
  })

  handle(IPC.PROVIDER_DEPOSIT, async () => {
    if (isVpnActive()) return null
    return await getProviderDeposit().catch(noteChainError)
  })

  handle(IPC.PROVIDER_REGISTER, async (_event, params: { name: string; identity: string; website: string; description: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.name, 'name')
    assertOptionalString(params?.identity, 'identity')
    assertOptionalString(params?.website, 'website')
    assertOptionalString(params?.description, 'description')
    const details = {
      name: params.name,
      identity: params.identity ?? '',
      website: params.website ?? '',
      description: params.description ?? '',
    }
    // Mirrors the hub's ValidateBasic (64/64/64/256 bytes, website must parse as
    // a request URI), so over-long or malformed input fails before it costs gas.
    assertValidProviderDetails(details, { requireName: true })
    // The deposit is spent to the community pool, not escrowed — check for it
    // explicitly rather than letting the tx fail after the gas simulation.
    // registrationDepositCost fails CLOSED on a deposit it cannot price.
    const deposit = await getProviderDeposit().catch(noteChainError)
    await assertSufficientFunds(registrationDepositCost(deposit))
    await registerProvider({ wallet, accountAddress: address, details }).catch(noteChainError)
  })

  /**
   * Overwrite the provider's metadata.
   *
   * The hub's handler is ASYMMETRIC: it keeps the stored name when the message
   * carries an empty one, but overwrites identity, website and description
   * unconditionally. So this is a full replace for three of the four fields, and
   * a caller that sends a partially filled form wipes whatever it left blank —
   * which is why the renderer's edit form is pre-filled from the current record.
   */
  handle(IPC.PROVIDER_UPDATE_DETAILS, async (_event, params: { name: string; identity: string; website: string; description: string }) => {
    const { wallet, address } = requireProviderContext()
    // The name IS required here, although the hub would keep the stored one for
    // an empty name: the edit form is pre-filled from the current record, so an
    // empty name arriving is a renderer bug, not a "keep it" intent.
    assertString(params?.name, 'name')
    assertOptionalString(params?.identity, 'identity')
    assertOptionalString(params?.website, 'website')
    assertOptionalString(params?.description, 'description')
    const details = {
      name: params.name,
      identity: params.identity ?? '',
      website: params.website ?? '',
      description: params.description ?? '',
    }
    assertValidProviderDetails(details, { requireName: true })
    await assertSufficientFunds(0)
    await updateProviderDetails({ wallet, accountAddress: address, details }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_SET_STATUS, async (_event, params: { active: boolean }) => {
    const { wallet, address } = requireProviderContext()
    if (typeof params?.active !== 'boolean') throw new Error('Invalid active: expected boolean')
    await assertSufficientFunds(0)
    try {
      await setProviderStatus({ wallet, accountAddress: address, active: params.active }).catch(noteChainError)
    } finally {
      // Deactivation cascades on chain: every lease ends and every node is
      // unlinked from every plan, so single-plan invalidation can't follow it.
      if (!params.active) invalidateAllPlanNodes()
    }
  })

  handle(IPC.PROVIDER_PLAN_CREATE, async (_event, params: { gigabytes: number; days: number; priceUdvpn: number; private: boolean }) => {
    const { wallet, address } = requireProviderContext()
    // Outer sanity bounds only — the semantic rules (whole numbers, non-zero
    // bytes/duration) are enforced by buildCreatePlanMsg, which mirrors the hub's
    // own ValidateBasic.
    assertIntRange(params?.gigabytes, 'gigabytes', 1, 1_000_000)
    assertIntRange(params?.days, 'days', 1, 3650)
    assertIntRange(params?.priceUdvpn, 'priceUdvpn', 0, 1_000_000_000_000)
    if (typeof params?.private !== 'boolean') throw new Error('Invalid private: expected boolean')
    await assertSufficientFunds(0)
    await createPlan({
      wallet,
      accountAddress: address,
      input: {
        gigabytes: params.gigabytes,
        days: params.days,
        priceUdvpn: params.priceUdvpn,
        private: params.private,
      },
    }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_PLAN_SET_STATUS, async (_event, params: { planId: string; active: boolean }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    if (typeof params?.active !== 'boolean') throw new Error('Invalid active: expected boolean')
    await assertSufficientFunds(0)
    await setPlanStatus({ wallet, accountAddress: address, planId: params.planId, active: params.active }).catch(noteChainError)
  })

  /**
   * Flip a plan between public and private after creation.
   *
   * Only reachable because provider-msgs registers the type URL itself: the SDK
   * ships the codec but omits it from SentinelRegistry, which is what made the
   * flag write-once. The hub checks ownership and nothing else, so this works at
   * any plan status.
   */
  handle(IPC.PROVIDER_PLAN_SET_PRIVATE, async (_event, params: { planId: string; private: boolean }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    if (typeof params?.private !== 'boolean') throw new Error('Invalid private: expected boolean')
    await assertSufficientFunds(0)
    await updatePlanDetails({ wallet, accountAddress: address, planId: params.planId, private: params.private }).catch(noteChainError)
  })

  handle(IPC.PROVIDER_PLAN_LINK, async (_event, params: { planId: string; nodeAddress: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    await assertSufficientFunds(0)
    // The plan→nodes list is cached for 10 minutes for browsing; after our own
    // link the console re-reads it immediately and must not get the old answer.
    // In a `finally` because a tx that times out here can still LAND — the old
    // answer must not be served for the rest of the TTL either way.
    try {
      await linkNode({ wallet, accountAddress: address, planId: params.planId, nodeAddress: params.nodeAddress }).catch(noteChainError)
    } finally {
      invalidatePlanNodes(params.planId)
    }
  })

  handle(IPC.PROVIDER_PLAN_UNLINK, async (_event, params: { planId: string; nodeAddress: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.planId, 'planId')
    if (!/^\d+$/.test(params.planId)) throw new Error('Invalid planId')
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    await assertSufficientFunds(0)
    try {
      await unlinkNode({ wallet, accountAddress: address, planId: params.planId, nodeAddress: params.nodeAddress }).catch(noteChainError)
    } finally {
      invalidatePlanNodes(params.planId)
    }
  })

  /**
   * Per-plan counters for the provider's own plan list: linked nodes, and how
   * many subscriptions the plan has sold. Batched over the wallet's plans (there
   * are a handful) so the console makes one call rather than three per plan, and
   * all of it rides one connection.
   *
   * Best-effort per plan — one unreadable plan must not blank the whole list —
   * but a failure is REPORTED as `null` for that id, never silently absent: the
   * renderer must be able to tell "could not count" from "no stats", or a failed
   * read renders as a plan with no nodes and no sales.
   */
  handle(IPC.PROVIDER_PLAN_STATS, async (_event, params: { planIds: string[] }) => {
    if (!Array.isArray(params?.planIds)) throw new Error('Invalid planIds')
    if (params.planIds.length > 50) throw new Error('Too many planIds')
    for (const id of params.planIds) {
      assertString(id, 'planId')
      if (!/^\d+$/.test(id)) throw new Error('Invalid planId')
    }
    const nullStats = () => Object.fromEntries(params.planIds.map((id) => [id, null]))
    if (isVpnActive()) return nullStats()

    type PlanStatsRow = { nodes: number; subscriptions: number; active: number; truncated: boolean }
    const out: Record<string, PlanStatsRow | null> = {}
    const q = await openChainQuery().catch(() => null)
    if (!q) {
      reportRpcFailure()
      return nullStats()
    }
    try {
      for (const planId of params.planIds) {
        try {
          const [nodes, subs] = await Promise.all([
            listNodesForPlan(planId, q.query),
            getPlanSubscriberStats(planId, q.query),
          ])
          out[planId] = { nodes: nodes.length, ...subs }
        } catch (err) {
          // Only an unreachable-RPC failure concerns the health monitor; a
          // per-plan decode error must not accuse the endpoint.
          const message = err instanceof Error ? err.message : String(err)
          if (isRpcConnectivityError(message)) reportRpcFailure()
          out[planId] = null
        }
      }
    } finally {
      q.disconnect()
    }
    return out
  })

  /** Display-only USD rate. Null when it can't be reached — the UI just omits it. */
  handle(IPC.PRICE_TOKEN, async () => {
    return await getTokenPrice()
  })

  // --- Leases ---

  handle(IPC.LEASE_PARAMS, async () => {
    if (isVpnActive()) return null
    return await getLeaseParams().catch(noteChainError)
  })

  /**
   * What a lease on this node would cost. Priced in main from the node's own
   * on-chain hourly price so the renderer never supplies a figure that a funds
   * check or a MaxPrice guard would then be based on.
   */
  handle(IPC.LEASE_QUOTE, async (_event, params: { nodeAddress: string; hours: number }) => {
    requireProviderContext()
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    assertIntRange(params?.hours, 'hours', 1, 720)
    const [price, leaseParams] = await Promise.all([
      getNodeHourlyPrice(params.nodeAddress).catch(noteChainError),
      getLeaseParams().catch(noteChainError),
    ])
    if (!price.hourlyPrice) {
      throw new Error('That node does not publish an hourly price in P2P, so it cannot be leased.')
    }
    return {
      hourlyPrice: price.hourlyPrice,
      totalUdvpn: leaseDepositUdvpn(price.hourlyPrice, params.hours),
      nodeStatus: price.status,
      minHours: leaseParams.minHours,
      maxHours: leaseParams.maxHours,
    }
  })

  handle(IPC.LEASE_START, async (_event, params: { nodeAddress: string; hours: number; renewalPolicy: number }) => {
    const { wallet, address } = requireProviderContext()
    assertSentAddress(params?.nodeAddress, 'nodeAddress')
    assertIntRange(params?.hours, 'hours', 1, 720)
    // assertIntRange, not assertNumber: the policy lands in a protobuf int32,
    // which would silently truncate a fractional value into a DIFFERENT policy.
    assertIntRange(params.renewalPolicy, 'renewalPolicy', 0, 7)

    const [price, leaseParams] = await Promise.all([
      getNodeHourlyPrice(params.nodeAddress).catch(noteChainError),
      getLeaseParams().catch(noteChainError),
    ])
    if (!price.hourlyPrice) {
      throw new Error('That node does not publish an hourly price in P2P, so it cannot be leased.')
    }
    // Enforced HERE, not just greyed out in the picker: escrow against an
    // inactive node is money the hub's NodeInactivePreHook takes straight back
    // by ending the lease. sentinel.types.v1.Status: 1 = active.
    if (price.status !== 1) {
      throw new Error('That node is not active on chain right now, so a lease on it would end immediately. Nothing was escrowed.')
    }
    assertValidLeaseHours(params.hours, leaseParams.minHours, leaseParams.maxHours)
    await assertSufficientFunds(leaseDepositNumber(price.hourlyPrice, params.hours))

    await startLease({
      wallet,
      accountAddress: address,
      nodeAddress: params.nodeAddress,
      hours: params.hours,
      hourlyQuoteValue: price.hourlyPrice,
      renewalPricePolicy: params.renewalPolicy,
    }).catch(noteChainError)
  })

  /**
   * Extend a lease early.
   *
   * The hub does NOT top the remaining term up: it resets Hours to 0, sets
   * MaxHours to the new duration, refunds the old escrow and charges a fresh
   * deposit for the whole period. So the funds check is priced on the full new
   * term, not the difference.
   *
   * The renewal policy is checked HERE as well as in the renderer, because it is
   * the chain's own gate (the same one the BeginBlocker applies) and failing it
   * costs a broadcast: a lease bought as "never renew" can never be extended at
   * all until MsgUpdateLease changes the policy.
   */
  handle(IPC.LEASE_RENEW, async (_event, params: { leaseId: string; hours: number }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.leaseId, 'leaseId')
    if (!/^\d+$/.test(params.leaseId)) throw new Error('Invalid leaseId')
    assertIntRange(params?.hours, 'hours', 1, 720)

    const lease = await assertOwnLease(address, params.leaseId)

    const [price, leaseParams] = await Promise.all([
      getNodeHourlyPrice(lease.nodeAddress).catch(noteChainError),
      getLeaseParams().catch(noteChainError),
    ])
    if (!price.hourlyPrice) {
      throw new Error('That node no longer publishes an hourly price in P2P, so its lease cannot be renewed.')
    }
    const refusal = renewalPolicyRefusal(lease.renewalPricePolicy, price.hourlyPrice, lease.hourlyPrice)
    if (refusal) throw new Error(refusal)

    assertValidLeaseHours(params.hours, leaseParams.minHours, leaseParams.maxHours)
    await assertSufficientFunds(leaseDepositNumber(price.hourlyPrice, params.hours))

    await renewLease({
      wallet,
      accountAddress: address,
      leaseId: params.leaseId,
      hours: params.hours,
      hourlyQuoteValue: price.hourlyPrice,
    }).catch(noteChainError)
  })

  /**
   * Change a live lease's renewal price policy. Gas only, and the only escape
   * from a lease bought under policy 0, which the chain will otherwise never
   * renew by any route.
   */
  handle(IPC.LEASE_UPDATE_POLICY, async (_event, params: { leaseId: string; renewalPolicy: number }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.leaseId, 'leaseId')
    if (!/^\d+$/.test(params.leaseId)) throw new Error('Invalid leaseId')
    // assertIntRange: a fractional policy would truncate in the protobuf int32.
    assertIntRange(params?.renewalPolicy, 'renewalPolicy', 0, 7)
    await assertOwnLease(address, params.leaseId)
    await assertSufficientFunds(0)
    await updateLease({
      wallet,
      accountAddress: address,
      leaseId: params.leaseId,
      renewalPricePolicy: params.renewalPolicy,
    }).catch(noteChainError)
  })

  handle(IPC.LEASE_END, async (_event, params: { leaseId: string }) => {
    const { wallet, address } = requireProviderContext()
    assertString(params?.leaseId, 'leaseId')
    if (!/^\d+$/.test(params.leaseId)) throw new Error('Invalid leaseId')
    await assertOwnLease(address, params.leaseId)
    await assertSufficientFunds(0)
    try {
      await endLease({ wallet, accountAddress: address, leaseId: params.leaseId }).catch(noteChainError)
    } finally {
      // Ending a lease unlinks its node from EVERY plan it served (the hub's
      // LeaseInactivePreHook), so the per-plan node caches are all suspect.
      invalidateAllPlanNodes()
    }
  })
}
