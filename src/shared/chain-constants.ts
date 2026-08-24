export const GAS_PRICE_STR = '0.2udvpn'
export const WALLET_PREFIX = 'sent'
// Blocks of validity for a session-creating tx (~3.6s/block measured on mainnet
// 2026-08-24 → ~110s). Past this height the chain rejects the tx, so it can't
// confirm long after the client has stopped polling (finding H2).
export const TX_TIMEOUT_HEIGHT_OFFSET = 30
