import { DNS_PROVISION_FAILED, INSUFFICIENT_FUNDS, RPC_UNREACHABLE } from '../../shared/error-markers'

const MARKERS = [DNS_PROVISION_FAILED, INSUFFICIENT_FUNDS, RPC_UNREACHABLE]

/** Did the bring-up fail only because the host has no resolvconf? */
export function isDnsProvisionFailure(message: string): boolean {
  return message.startsWith(DNS_PROVISION_FAILED)
}

/** Was the operation refused because the wallet can't pay? Nothing was charged. */
export function isInsufficientFunds(message: string): boolean {
  return message.startsWith(INSUFFICIENT_FUNDS)
}

/** Did the chain call never reach the RPC endpoint? The fix is the endpoint, not a retry. */
export function isRpcUnreachable(message: string): boolean {
  return message.startsWith(RPC_UNREACHABLE)
}

/** Strip the internal marker prefix — users should never see it. */
export function displayConnectError(message: string): string {
  const marker = MARKERS.find((m) => message.startsWith(m))
  return marker ? message.slice(marker.length).replace(/^:\s*/, '') : message
}
