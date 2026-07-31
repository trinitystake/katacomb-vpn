// Import-free so Node's native test runner can load it directly (same constraint
// as funds.ts and rpc-health.ts). The marker is inlined rather than imported
// from './error-markers' for that reason; wallet-errors.test.ts asserts the two
// stay equal.
const WALLET_EXISTS = 'WALLET_EXISTS'

export interface WalletExists {
  /** The id of the wallet that already holds this address. */
  id: string
  /** User-facing text, marker and id stripped. */
  message: string
}

/**
 * Read a `WALLET_EXISTS:<id>: <message>` failure, or null when the error is
 * something else. The id lets the renderer offer "use that wallet" instead of
 * dead-ending on "already exists".
 */
export function parseWalletExists(message: string): WalletExists | null {
  const prefix = `${WALLET_EXISTS}:`
  if (!message.startsWith(prefix)) return null
  const rest = message.slice(prefix.length)
  const separator = rest.indexOf(':')
  if (separator === -1) return null
  const id = rest.slice(0, separator).trim()
  if (!id) return null
  return { id, message: rest.slice(separator + 1).trim() }
}
