import { COUNTRY_CODES } from '../utils/country-codes'

/**
 * The flag for a node's country, or nothing when the aggregator didn't report a
 * country (or reported one that isn't in COUNTRY_CODES). Renders the same
 * flag-icons span the Nodes table uses, so every list shows the same glyph.
 */
export default function CountryFlag({ country, className = '' }: { country: string; className?: string }) {
  const code = COUNTRY_CODES[country]
  if (!code) return null
  return (
    <span
      className={`fi fi-${code} shrink-0 ${className}`}
      style={{ fontSize: '12px', lineHeight: 1 }}
      title={country}
    />
  )
}
