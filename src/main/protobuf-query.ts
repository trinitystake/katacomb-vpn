// Talk to a Sentinel gRPC query service that `SentinelClient.sentinelQuery`
// doesn't cover. Two cases need this, both verified against mainnet:
//
//   - `x/lease` has no SDK module at all (see lease-query.ts).
//   - `provider.params()` in the SDK calls sentinel.provider.v2.QueryService,
//     which the chain does NOT implement — it answers "Unimplemented: unknown
//     request". Only the v3 service serves Params. (The v2 service does still
//     answer QueryProvider/QueryProviders, which is why the rest of the SDK's
//     provider queries work.)
//
// Same construction the SDK uses internally (modules/plan/query.js): CometClient
// → QueryClient → createProtobufRpcClient → generated QueryServiceClientImpl.

import { QueryClient, createProtobufRpcClient, type ProtobufRpcClient } from '@cosmjs/stargate'
import { connectComet, type CometClient } from '@cosmjs/tendermint-rpc'
import { getRpcEndpoint } from './settings'
import { withTimeout } from './async-utils'
import { resolveRpcBase } from './chain-clients'

const CONNECT_TIMEOUT_MS = 10_000
export const QUERY_TIMEOUT_MS = 10_000

/**
 * Run `fn` against a short-lived protobuf RPC client, always disconnecting after.
 *
 * When a `shared` client is passed (an aggregate read reusing one connection for
 * several queries, e.g. getProviderEconomics), `fn` runs against it directly and
 * the CALLER keeps ownership — nothing is opened or disconnected here.
 */
export async function withProtobufQuery<T>(
  fn: (rpc: ProtobufRpcClient) => Promise<T>,
  shared?: ProtobufRpcClient,
): Promise<T> {
  if (shared) return fn(shared)
  let comet: CometClient | null = null
  try {
    const base = await resolveRpcBase(getRpcEndpoint())
    comet = await withTimeout(connectComet(base), CONNECT_TIMEOUT_MS, 'RPC connect')
    return await fn(createProtobufRpcClient(QueryClient.withExtensions(comet)))
  } finally {
    comet?.disconnect()
  }
}
