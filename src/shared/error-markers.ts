// Prefixes on Error messages that cross the IPC bridge and mean something
// specific to the renderer. Kept as plain string markers (not error classes)
// because only `message` survives ipcRenderer.invoke's rejection.

/**
 * A WireGuard/AmneziaWG bring-up failed at the DNS step — wg-quick/awg-quick
 * couldn't run `resolvconf`. The tunnel is otherwise fine, so the renderer
 * offers a retry with `DNS =` stripped (system DNS, outside the tunnel).
 */
export const DNS_PROVISION_FAILED = 'DNS_PROVISION_FAILED'

/**
 * The wallet can't cover the operation's cost plus gas — either caught by the
 * pre-broadcast check in `ipc-handlers`, or reported by the chain itself. Nothing
 * was charged. The renderer offers the wallet address to top up, plus a retry.
 */
export const INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS'

/**
 * A chain call couldn't reach the RPC endpoint at all — DNS, refused connection,
 * timeout or a gateway error. Nothing was sent, so the renderer offers the
 * network settings and a plain retry.
 *
 * Only for connect/query failures. A *broadcast* timeout must never carry this
 * marker: that transaction may still land, and telling the user nothing was sent
 * would hide a session they paid for.
 */
export const RPC_UNREACHABLE = 'RPC_UNREACHABLE'

/**
 * A wallet with the derived address is already stored, so nothing was created.
 * Unlike the others this marker carries a payload — `WALLET_EXISTS:<id>: …` —
 * so the renderer can offer to switch to that wallet instead of making the user
 * go and find it. Parse it with `parseWalletExists` in `wallet-errors.ts`.
 */
export const WALLET_EXISTS = 'WALLET_EXISTS'
