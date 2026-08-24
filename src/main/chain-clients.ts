import { connectComet, type CometClient } from '@cosmjs/tendermint-rpc'
import { GasPrice, type SigningStargateClientOptions } from '@cosmjs/stargate'
import { Registry, type OfflineSigner } from '@cosmjs/proto-signing'
import { SentinelClient, SigningSentinelClient, SentinelRegistry } from '@sentinel-official/sentinel-js-sdk'
import { getRpcEndpoint } from './settings'
import { withTimeout } from './async-utils'
import { GAS_PRICE_STR } from '../shared/chain-constants'

const GAS_PRICE = GasPrice.fromString(GAS_PRICE_STR)
const RPC_CONNECT_TIMEOUT_MS = 10_000
const REDIRECT_PROBE_TIMEOUT_MS = 3_000
/**
 * How often the signing client re-checks whether a broadcast tx has committed.
 * CosmJS's default is 3000ms and it sleeps BEFORE the first check, so with
 * Sentinel's ~3.6s blocks the default discovers an included tx ~1.5s late on
 * average. 1s costs a couple of extra getTx queries and returns that time to
 * the user on every paid connect.
 */
export const TX_POLL_INTERVAL_MS = 1_000

/**
 * The RPC base each configured endpoint actually serves from, discovered once
 * per launch (per endpoint string, so changing the setting re-resolves).
 *
 * The default endpoint (rpc.sentinel.co) 307-redirects EVERY request to another
 * host (~100ms extra per request, measured; a connect flow makes ~20 requests).
 * Following the redirect once and talking to the target directly returns that
 * time while the user-facing setting keeps the official, stable name — the
 * target is a runtime detail, re-discovered at next launch, never persisted and
 * never shown in the UI. Fail-open: any probe failure means "use the endpoint
 * as configured", which is exactly today's behavior.
 */
const resolvedBases = new Map<string, Promise<string>>()

export function resolveRpcBase(endpoint: string): Promise<string> {
  let pending = resolvedBases.get(endpoint)
  if (!pending) {
    pending = discoverRedirect(endpoint)
    resolvedBases.set(endpoint, pending)
  }
  return pending
}

async function discoverRedirect(endpoint: string): Promise<string> {
  try {
    const res = await fetch(endpoint, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REDIRECT_PROBE_TIMEOUT_MS),
    })
    if (res.status !== 307 && res.status !== 308) return endpoint
    const location = res.headers.get('location')
    if (!location) return endpoint
    // Only ever follow to another https host. The Location for the probed URL is
    // the new base itself (we probe the endpoint exactly as configured, so a
    // path-prefixed endpoint keeps its prefix in the target).
    const target = new URL(location, endpoint)
    if (target.protocol !== 'https:') return endpoint
    const base = target.href.replace(/\/$/, '')
    if (new URL(base).origin === new URL(endpoint).origin) return endpoint
    console.log(`[rpc] ${new URL(endpoint).host} redirects to ${target.host}, using it directly this session`)
    return base
  } catch {
    return endpoint
  }
}

// The SDK's constructors are protected (its static factories are the public
// surface), but the factories create one CometBFT connection each — and a
// connect flow needs a query client AND a signing client, which would cost two
// TLS connections and two status() version probes. These subclasses re-open the
// constructors so both clients can share ONE connection.
class FlowQueryClient extends SentinelClient {
  constructor(tmClient: CometClient) {
    super(tmClient)
  }
}

class FlowSigningClient extends SigningSentinelClient {
  constructor(tmClient: CometClient, signer: OfflineSigner, options: SigningStargateClientOptions) {
    super(tmClient, signer, options)
  }
}

/**
 * One RPC connection for one connect flow: a query client and a signing client
 * over the same CometBFT client, against the redirect-resolved base.
 *
 * Ownership: the handler that opened the flow calls `disconnect()` in its
 * `finally`; anything the flow's clients are passed to must never disconnect
 * them. Scope: the connect flows and the plan/subscription operations — the
 * few remaining one-shot reads elsewhere wrap their endpoint in
 * `resolveRpcBase` instead.
 */
export interface ChainFlow {
  query: SentinelClient
  signing: SigningSentinelClient
  disconnect: () => void
}

/**
 * The read-only sibling of `openChainFlow`: one query client against the
 * redirect-resolved base, for handlers that batch several chain reads. Same
 * ownership rule — the opener disconnects; anything handed the client must
 * never disconnect it.
 */
export interface ChainQuery {
  query: SentinelClient
  disconnect: () => void
}

export async function openChainQuery(): Promise<ChainQuery> {
  const base = await resolveRpcBase(getRpcEndpoint())
  const tmClient = await withTimeout(connectComet(base), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  return {
    query: new FlowQueryClient(tmClient),
    disconnect: () => tmClient.disconnect(),
  }
}

export async function openChainFlow(wallet: OfflineSigner): Promise<ChainFlow> {
  const base = await resolveRpcBase(getRpcEndpoint())
  const tmClient = await withTimeout(connectComet(base), RPC_CONNECT_TIMEOUT_MS, 'RPC connect')
  return {
    query: new FlowQueryClient(tmClient),
    signing: new FlowSigningClient(tmClient, wallet, {
      // The static factory injects this registry itself; constructing directly
      // skips that, and without it every sentinel msg fails to encode.
      registry: new Registry(SentinelRegistry),
      gasPrice: GAS_PRICE,
      broadcastPollIntervalMs: TX_POLL_INTERVAL_MS,
    }),
    disconnect: () => tmClient.disconnect(),
  }
}
