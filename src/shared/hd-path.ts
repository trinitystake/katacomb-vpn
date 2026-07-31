// The BIP-44 derivation path this app uses, as a string. Pure and import-free so
// main (which turns it into an HdPath via @cosmjs/crypto) and the renderer
// (which shows it to the user) build the exact same text, and so Node's native
// test runner can load it (same constraint as funds.ts and rpc-health.ts).

/** Cosmos SDK chains, including Sentinel. */
export const COSMOS_COIN_TYPE = 118

/**
 * `m/44'/118'/<account>'/0/<address>`. Varying `account` is what Keplr and
 * Ledger Live call a subaccount; varying `address` walks the addresses inside
 * one account. The change level stays 0 — Cosmos has no change addresses.
 */
export function formatHdPath(accountIndex: number, addressIndex: number): string {
  return `m/44'/${COSMOS_COIN_TYPE}'/${accountIndex}'/0/${addressIndex}`
}
