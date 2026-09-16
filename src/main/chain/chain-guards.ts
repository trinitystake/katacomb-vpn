import type { SentinelClient } from '@sentinel-official/sentinel-js-sdk'

import { checkFunds, insufficientFundsMessage, udvpnOf } from '../../shared/funds'
import { isRpcConnectivityError, rpcHostLabel } from '../../shared/rpc-health'
import { INSUFFICIENT_FUNDS, RPC_UNREACHABLE } from '../../shared/error-markers'
import { getBalance, getBalanceForAddress } from './wallet'
import { getRpcHealth, reportRpcFailure } from './rpc-monitor'

/**
 * Guards that run before a chain call that spends money, and the one that
 * classifies a chain call that failed.
 *
 * They live here rather than in ipc-handlers.ts because every handler group
 * that broadcasts a transaction needs them - the connect path, the plan paths
 * and the provider console - and none of them needs the connection state
 * machine those handlers sit next to.
 */
/**
 * Refuse to broadcast when the wallet can't cover `costUdvpn` plus gas. Pass 0 for
 * a gas-only tx. The renderer runs the same check to disable its pay buttons, but
 * its balance is polled and can be minutes stale — this one reads it fresh.
 *
 * Fails OPEN: if the balance can't be read (RPC down, or a tunnel is up and RPC is
 * unreachable through it) we let the tx proceed and let the chain decide. Blocking
 * someone from ending a session because we couldn't reach an RPC is worse than the
 * on-chain failure, which `assertTxSucceeded` now reports readably anyway.
 */
export async function assertSufficientFunds(costUdvpn: number, client?: SentinelClient): Promise<void> {
  let balances: { denom: string; amount: string }[]
  try {
    balances = await getBalance(client)
  } catch {
    reportRpcFailure()
    return
  }
  const check = checkFunds(udvpnOf(balances), costUdvpn)
  if (!check.ok) throw new Error(`${INSUFFICIENT_FUNDS}: ${insufficientFundsMessage(check)}`)
}

/**
 * The same check against a specific account, for the second wallet of a per-hop
 * chain. Fails OPEN on an unreadable balance for the same reason as above: blocking
 * a purchase because an RPC was briefly unreachable is worse than letting the chain
 * reject it, which `assertTxSucceeded` reports readably.
 */
export async function assertSufficientFundsFor(address: string, costUdvpn: number): Promise<void> {
  let balances: { denom: string; amount: string }[]
  try {
    balances = await getBalanceForAddress(address)
  } catch {
    reportRpcFailure()
    return
  }
  const check = checkFunds(udvpnOf(balances), costUdvpn)
  if (!check.ok) {
    throw new Error(
      `${INSUFFICIENT_FUNDS}: the wallet paying for the exit hop is short. ` +
      insufficientFundsMessage(check),
    )
  }
}

/**
 * Report a failed chain call to the health monitor and rethrow it. When the
 * message says we never reached the endpoint, tag it so the renderer can offer
 * the network settings instead of showing a raw `RPC connect timed out`.
 *
 * Wraps chain-only calls, never node calls — a node's own `ECONNREFUSED` would
 * otherwise be blamed on the RPC. The message deliberately makes no claim about
 * whether a transaction landed: `broadcastOrTimeout`'s own timeout text (which
 * this never matches) is what covers that case, carefully.
 */
export function noteChainError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  if (isRpcConnectivityError(message)) {
    reportRpcFailure()
    throw new Error(
      `${RPC_UNREACHABLE}: Couldn't reach the blockchain at ${rpcHostLabel(getRpcHealth().endpoint || 'the RPC endpoint')}. ` +
      `Check your internet connection, or switch to another RPC endpoint in Settings → Network. (${message})`,
    )
  }
  throw err
}
