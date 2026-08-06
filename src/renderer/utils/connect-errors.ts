// Import-free so Node's native test runner can load it directly (same constraint
// as wallet-errors.ts). The markers are inlined rather than imported from
// '../../shared/error-markers' for that reason; connect-errors.test.ts asserts
// they stay equal to the shared ones.
const DNS_PROVISION_FAILED = 'DNS_PROVISION_FAILED'
const INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS'
const RPC_UNREACHABLE = 'RPC_UNREACHABLE'

const MARKERS = [DNS_PROVISION_FAILED, INSUFFICIENT_FUNDS, RPC_UNREACHABLE]

/**
 * Undo Electron's IPC wrapper. Anything an `ipcMain.handle` handler throws comes
 * back through `ipcRenderer.invoke` as
 *   `Error invoking remote method '<channel>': Error: <our message>`
 * and every marker below is matched with startsWith, so without stripping the
 * wrapper first the RPC / funds / DNS branches can NEVER fire — they'd all fall
 * through to the generic error pane.
 *
 * Verified live: a rate-limited RPC reached the connect modal as
 * `Error invoking remote method 'connection:subscribe': Error: Bad status on
 * response: 429`, wrapper and all, instead of the "switch endpoint in Settings →
 * Network" pane. The same wrapper is why that text looked like an internal crash.
 */
function unwrapIpc(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
}

/** Did the bring-up fail only because the host has no resolvconf? */
export function isDnsProvisionFailure(message: string): boolean {
  return unwrapIpc(message).startsWith(DNS_PROVISION_FAILED)
}

/** Was the operation refused because the wallet can't pay? Nothing was charged. */
export function isInsufficientFunds(message: string): boolean {
  return unwrapIpc(message).startsWith(INSUFFICIENT_FUNDS)
}

/** Did the chain call never reach the RPC endpoint? The fix is the endpoint, not a retry. */
export function isRpcUnreachable(message: string): boolean {
  return unwrapIpc(message).startsWith(RPC_UNREACHABLE)
}

/** Strip the IPC wrapper and the internal marker prefix — users should see neither. */
export function displayConnectError(message: string): string {
  const unwrapped = unwrapIpc(message)
  const marker = MARKERS.find((m) => unwrapped.startsWith(m))
  return marker ? unwrapped.slice(marker.length).replace(/^:\s*/, '') : unwrapped
}
