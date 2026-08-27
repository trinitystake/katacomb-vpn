// sentinel.types.v1.RenewalPricePolicy: what a lease is allowed to do when its
// term runs out, and whether a hand-sent MsgRenewLease will be accepted.
//
// Lives in shared/ rather than provider-msgs.ts because BOTH sides need it: main
// refuses a renewal that the chain would reject, and the renderer greys out the
// button and says why. The enum values are stable protobuf identifiers, so they
// are inlined here rather than imported from the SDK, which shared/ never pulls in.

export const RENEWAL_POLICY = {
  UNSPECIFIED: 0,
  IF_LESSER: 1,
  IF_LESSER_OR_EQUAL: 2,
  IF_EQUAL: 3,
  IF_NOT_EQUAL: 4,
  IF_GREATER: 5,
  IF_GREATER_OR_EQUAL: 6,
  ALWAYS: 7,
} as const

/**
 * The policies worth offering when buying or amending a lease.
 *
 * Deliberately not all eight: IF_GREATER and IF_NOT_EQUAL renew only when the
 * node has put its price UP, which nobody wants to opt into, and IF_EQUAL breaks
 * on any price move at all. The four here cover every intent a provider has.
 */
export const RENEWAL_POLICY_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: RENEWAL_POLICY.ALWAYS, label: 'Renew automatically', hint: 'Whatever the node charges at the time.' },
  { value: RENEWAL_POLICY.IF_LESSER_OR_EQUAL, label: 'Renew if the price has not risen', hint: 'Stops if the node puts its price up.' },
  { value: RENEWAL_POLICY.IF_LESSER, label: 'Renew only if the price has dropped', hint: 'Stops unless the node is cheaper than when you bought.' },
  { value: RENEWAL_POLICY.UNSPECIFIED, label: 'Never renew', hint: 'The lease ends when its hours run out, and cannot be extended.' },
]

export function renewalPolicyLabel(policy: number): string {
  return RENEWAL_POLICY_OPTIONS.find((o) => o.value === policy)?.label ?? `Policy ${policy}`
}

/**
 * Would the chain let this lease renew at the node's current price?
 *
 * Mirror of the hub's types/v1/renewal.go `RenewalPricePolicy.Validate(current,
 * stored)`, which gates BOTH the BeginBlocker's automatic renewal and a
 * hand-sent MsgRenewLease. Two consequences worth knowing before wiring a button
 * to it: UNSPECIFIED (0) always fails, so such a lease can never renew by any
 * route until MsgUpdateLease changes it; and the conditional policies compare
 * against the price stored on the lease, so an extend can be refused by a price
 * move the user never chose and cannot influence.
 *
 * Compared as BigInt: these are udvpn integer strings and can exceed 2^53.
 */
export function renewalPolicyAllows(policy: number, currentQuoteValue: string, storedQuoteValue: string): boolean {
  if (!/^\d+$/.test(currentQuoteValue) || !/^\d+$/.test(storedQuoteValue)) return false
  const current = BigInt(currentQuoteValue)
  const stored = BigInt(storedQuoteValue)
  switch (policy) {
    case RENEWAL_POLICY.IF_LESSER:
      return current < stored
    case RENEWAL_POLICY.IF_LESSER_OR_EQUAL:
      return current <= stored
    case RENEWAL_POLICY.IF_EQUAL:
      return current === stored
    case RENEWAL_POLICY.IF_NOT_EQUAL:
      return current !== stored
    case RENEWAL_POLICY.IF_GREATER:
      return current > stored
    case RENEWAL_POLICY.IF_GREATER_OR_EQUAL:
      return current >= stored
    case RENEWAL_POLICY.ALWAYS:
      return true
    // UNSPECIFIED and anything unrecognised: the hub errors out.
    default:
      return false
  }
}

/**
 * A udvpn integer string as the P2P figure the rest of the UI speaks in.
 * Inlined (this module imports nothing, for the native test runner); the
 * renderer's formatUdvpn agrees on the arithmetic.
 */
function asP2p(udvpn: string): string {
  const n = Number(udvpn)
  if (!isFinite(n)) return `${udvpn} udvpn`
  return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} P2P`
}

/**
 * Why the chain would refuse to renew this lease, or null when it would accept.
 *
 * Phrased for a user rather than naming the enum, because the enum name is not
 * the useful part: what they need to know is which price comparison failed and
 * that policy 0 is a dead end until the policy itself is changed. Prices are
 * stated in P2P, the unit every other figure on the tab uses.
 */
export function renewalPolicyRefusal(policy: number, currentQuoteValue: string, storedQuoteValue: string): string | null {
  if (renewalPolicyAllows(policy, currentQuoteValue, storedQuoteValue)) return null
  if (policy === RENEWAL_POLICY.UNSPECIFIED) {
    return 'This lease was bought as "never renew", so the chain refuses to extend it. Change its renewal policy first.'
  }
  if (!/^\d+$/.test(currentQuoteValue) || !/^\d+$/.test(storedQuoteValue)) {
    return 'The node does not publish a comparable hourly price, so the renewal policy cannot be checked.'
  }
  return (
    `The node now charges ${asP2p(currentQuoteValue)} an hour against the ${asP2p(storedQuoteValue)} this lease was bought at, ` +
    `which its renewal policy ("${renewalPolicyLabel(policy)}") does not allow. Change the policy or end the lease and buy a new one.`
  )
}
