// Provider-side economics: what the leased nodes cost, what the plans bring in, and
// how many subscribers a given plan price needs to cover the burn.
//
// The two sides are denominated differently, which is the whole reason this module
// exists: a lease bills `hourlyPrice` every hour per node whether or not anyone uses
// it, while a plan sells a fixed allocation for a one-off price. Cost is a function
// of TIME, revenue is a function of SUBSCRIBERS — so extra subscribers on already
// leased nodes are nearly free margin, until the nodes saturate (which this app has
// no way to observe, so it never claims otherwise).
//
// Everything here is pure and Electron-free so it runs under the native test runner,
// and every figure is a udvpn integer carried as a string: these numbers are money,
// and `0.1 + 0.2` is not what a provider wants to see. All arithmetic is BigInt.

/** The lease fields economics needs — a structural subset of lease-query's LeaseInfo. */
export interface LeaseCost {
  /** udvpn per hour, integer string. */
  hourlyPrice: string
  /** Hours already consumed and paid out. */
  hours: number
  /** Hours bought up front. */
  maxHours: number
}

export interface Burn {
  /** udvpn charged per hour across every active lease. */
  hourlyUdvpn: string
  /** The same figure over 24h — what the strip headlines, since leases outlive an hour. */
  dailyUdvpn: string
  /** How many leases are still being billed. */
  activeLeases: number
}

/**
 * How many subscribers a plan needs before it covers the burn. Three distinct
 * outcomes rather than a nullable number, because "you have no nodes yet" and
 * "this plan can never pay for itself" need different words in the UI.
 */
export type BreakEven =
  | { kind: 'subscribers'; count: number }
  /** No active lease, so there is nothing to cover yet. */
  | { kind: 'no-burn' }
  /** The plan nets zero per subscriber (free, or wholly eaten by the staking share). */
  | { kind: 'never' }

const HOURS_PER_DAY = 24n

/**
 * Cosmos LegacyDec precision. A Dec is an integer scaled by 10^18 — `stakingShare`
 * comes off the wire as "200000000000000000", NOT "0.2". Verified live against
 * sentinel.subscription.v3 and sentinel.lease.v1 params on mainnet: both are 20%.
 */
const DEC_ONE = 10n ** 18n

function assertUdvpn(value: string, what: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${what} is not a whole number of udvpn: "${value}"`)
  }
  return BigInt(value)
}

/**
 * Parse a LegacyDec share off the protobuf wire into its raw 10^18-scaled BigInt.
 *
 * Throws rather than coping with a decimal point: the protobuf form is always the
 * scaled integer, so a "0.2" here would mean the caller is reading some other
 * encoding, and silently accepting it would misprice every figure by 10^18.
 */
export function parseDecShare(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Staking share is not a LegacyDec integer: "${raw}"`)
  }
  const share = BigInt(raw)
  if (share > DEC_ONE) {
    throw new Error(`Staking share exceeds 100%: "${raw}"`)
  }
  return share
}

/**
 * A lease still being billed. An exhausted lease (all its hours consumed) can still
 * come back from the chain, and counting it would overstate the burn.
 */
export function isActiveLease(lease: LeaseCost): boolean {
  return lease.hours < lease.maxHours
}

export function computeBurn(leases: LeaseCost[]): Burn {
  const active = leases.filter(isActiveLease)
  const hourly = active.reduce(
    (sum, l) => sum + assertUdvpn(l.hourlyPrice, 'Lease hourly price'),
    0n,
  )
  return {
    hourlyUdvpn: hourly.toString(),
    dailyUdvpn: (hourly * HOURS_PER_DAY).toString(),
    activeLeases: active.length,
  }
}

/**
 * Escrowed but not yet spent: the refund a provider would get by ending every lease
 * right now. Deliberately separate from burn — it is money already committed, so
 * showing it alongside the run rate stops a provider double-counting it as budget.
 */
export function computeCommitted(leases: LeaseCost[]): string {
  const total = leases.filter(isActiveLease).reduce(
    (sum, l) => sum + assertUdvpn(l.hourlyPrice, 'Lease hourly price') * BigInt(l.maxHours - l.hours),
    0n,
  )
  return total.toString()
}

/**
 * What the provider actually banks per subscription. The hub keeps `stakingShare`
 * of every plan payment, so the sticker price is NOT income — quoting it as such
 * would overstate earnings by 20% on mainnet today.
 *
 * Rounds DOWN, so the estimate errs toward understating income.
 */
export function netOfStakingShare(priceUdvpn: string, share: bigint): string {
  const price = assertUdvpn(priceUdvpn, 'Plan price')
  return ((price * (DEC_ONE - share)) / DEC_ONE).toString()
}

/**
 * Subscribers needed to cover the burn for one plan-duration window.
 *
 * A subscription pays once for `durationDays` of access, so its contribution per day
 * is netPrice/durationDays; setting that equal to the daily burn and solving gives
 * `dailyBurn * durationDays / netPrice`. Rounds UP — a fractional subscriber does not
 * pay, so the honest answer is the next whole one.
 */
export function computeBreakEven(params: {
  dailyBurnUdvpn: string
  netPricePerSubUdvpn: string
  durationDays: number
}): BreakEven {
  const burn = assertUdvpn(params.dailyBurnUdvpn, 'Daily burn')
  const net = assertUdvpn(params.netPricePerSubUdvpn, 'Net plan price')
  if (burn === 0n) return { kind: 'no-burn' }
  if (net === 0n) return { kind: 'never' }
  if (!Number.isInteger(params.durationDays) || params.durationDays <= 0) {
    throw new Error('Plan duration must be a whole number of days greater than zero')
  }

  const numerator = burn * BigInt(params.durationDays)
  // Ceiling division on integers.
  const count = (numerator + net - 1n) / net
  return { kind: 'subscribers', count: Number(count) }
}

/**
 * Gross-of-nothing, net-of-staking-share revenue for one plan. `subscriptions` is the
 * chain's own lifetime count, so this is cumulative income, not a run rate — and it is
 * a floor whenever the caller's count was truncated by the scan limit.
 */
export function computeEstimatedRevenue(subscriptions: number, netPricePerSubUdvpn: string): string {
  if (!Number.isInteger(subscriptions) || subscriptions < 0) {
    throw new Error('Subscription count must be a whole, non-negative number')
  }
  const net = assertUdvpn(netPricePerSubUdvpn, 'Net plan price')
  return (net * BigInt(subscriptions)).toString()
}
