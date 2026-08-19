// Wallet-balance arithmetic, shared by main and renderer so the pre-check the UI
// does (disable the pay button) and the one main does right before broadcasting
// agree on the numbers and the wording. No Electron/DOM imports.
//
// The chain denom is `udvpn`; the UI unit is "P2P" (1 P2P = 1e6 udvpn).

/**
 * Gas headroom reserved on top of the on-chain cost, in udvpn. Fees are paid at
 * `GAS_PRICE_STR` with a CosmJS-simulated gas limit, so the exact figure isn't
 * known before broadcasting — 0.05 P2P comfortably covers every tx this app sends.
 */
export const FEE_RESERVE_UDVPN = 50_000

const UDVPN_PER_P2P = 1_000_000

/** Total `udvpn` across a balance list, ignoring every other denom. */
export function udvpnOf(balances: { denom: string; amount: string }[]): number {
  const entry = balances.find((b) => b.denom === 'udvpn')
  if (!entry) return 0
  const parsed = parseInt(entry.amount, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** udvpn → the "1.20" display string. Always 2 decimals, truncation-free. */
export function formatP2p(udvpn: number): string {
  return (udvpn / UDVPN_PER_P2P).toFixed(2)
}

/**
 * udvpn → a display string rounded UP to 2 decimals, so the "add this much"
 * figure is always enough. A 1-udvpn shortfall must read "0.01", never "0.00".
 */
export function formatP2pCeil(udvpn: number): string {
  return (Math.ceil(udvpn / (UDVPN_PER_P2P / 100)) / 100).toFixed(2)
}

export interface FundsCheck {
  ok: boolean
  /** udvpn the wallet holds. */
  available: number
  /** udvpn the operation itself costs; 0 for a gas-only tx. */
  cost: number
  /** cost + FEE_RESERVE_UDVPN. */
  required: number
  /** udvpn still missing; 0 when `ok`. */
  shortfall: number
}

export function checkFunds(available: number, costUdvpn: number): FundsCheck {
  const required = costUdvpn + FEE_RESERVE_UDVPN
  return {
    ok: available >= required,
    available,
    cost: costUdvpn,
    required,
    shortfall: Math.max(0, required - available),
  }
}

/**
 * The one user-facing sentence for "the wallet can't pay", used verbatim by the
 * modal warnings and by the errors main throws. Deliberately carries no wallet
 * address — each side renders that itself (the renderer with a copy button).
 */
export function insufficientFundsMessage(c: FundsCheck): string {
  if (c.cost === 0) {
    return (
      `Not enough P2P for the network fee: this needs ~${formatP2p(c.required)} P2P ` +
      `and your wallet has ${formatP2p(c.available)}.`
    )
  }
  return (
    `Not enough P2P: this costs ${formatP2p(c.cost)} plus ~${formatP2p(FEE_RESERVE_UDVPN)} ` +
    `in network fees (${formatP2p(c.required)} total), and your wallet has ${formatP2p(c.available)}. ` +
    `Add ${formatP2pCeil(c.shortfall)} P2P and try again.`
  )
}
