// The provider record's four editable fields, and the chain's own rules for them.
//
// Mirrors x/provider/types/v3/msg.go ValidateBasic at sentinelhub v12.0.2. Lives
// in shared/ because both sides need the identical rule: the renderer to refuse a
// bad form before it costs anything, and the main process because the renderer is
// not a trust boundary.

export interface ProviderDetails {
  name: string
  identity: string
  website: string
  description: string
}

/** Field caps from the hub's ValidateBasic. Go's len() counts BYTES, not runes. */
export const PROVIDER_LIMITS = { name: 64, identity: 64, website: 64, description: 256 } as const

/** Byte length the way Go measures a string, without needing Buffer in the renderer. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Does `website` parse the way Go's `url.ParseRequestURI` does?
 *
 * That function takes an absolute URI *or* an absolute path, which is why a bare
 * "example.com" is rejected but "/about" is not. Mirrored rather than tightened:
 * a validator that refuses what the chain would have accepted is its own bug.
 */
function isRequestUri(website: string): boolean {
  if (website.startsWith('/')) return true
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(website)) return false
  try {
    new URL(website)
    return true
  } catch {
    return false
  }
}

/**
 * The first thing wrong with these details, or null when the chain would take them.
 *
 * `requireName` is the one asymmetry between the two messages that carry these
 * fields: registration demands a name, an update does not. The hub KEEPS the
 * stored name when MsgUpdateProviderDetails carries an empty one, but overwrites
 * identity, website and description unconditionally, so an edit form must be
 * pre-filled from the current record or those three are wiped.
 */
export function providerDetailsProblem(
  details: ProviderDetails,
  options: { requireName: boolean },
): string | null {
  if (options.requireName && !details.name.trim()) {
    return 'Give your provider a name: it is what subscribers see next to your plans.'
  }
  for (const [field, cap] of Object.entries(PROVIDER_LIMITS)) {
    const value = details[field as keyof ProviderDetails]
    if (byteLength(value) > cap) {
      return `Provider ${field} is too long: the chain allows ${cap} bytes.`
    }
  }
  if (details.website && !isRequestUri(details.website)) {
    return 'Provider website must be a full address including the scheme, for example https://example.com'
  }
  return null
}

/** providerDetailsProblem as a guard, for the main process. */
export function assertValidProviderDetails(
  details: ProviderDetails,
  options: { requireName: boolean },
): void {
  const problem = providerDetailsProblem(details, options)
  if (problem) throw new Error(problem)
}
