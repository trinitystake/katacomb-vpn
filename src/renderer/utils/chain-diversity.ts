import type { SentNode } from '../types'

// Operator-diversity checks for a two-hop chain.
//
// A chain is only worth paying twice for if the two hops are held by different
// people. If one operator runs both, they see your IP at the entry and your
// destinations at the exit and can simply put the two together — the chain buys
// nothing and costs double. Nothing on chain says who owns a node, so these are
// heuristics over what the node list does carry (ASN, address, country) plus the
// endpoint hostname.
//
// They are ADVISORY. Each one can be true of two genuinely independent operators
// (a big host serves many customers from one ASN), so the UI states the specific
// observation and lets the user decide, rather than silently filtering nodes out.
// Note also what none of this can detect: one operator renting from several ASNs.
//
// Pure + unit-tested (native runner), like node-status.ts.

export type DiversitySeverity = 'operator' | 'jurisdiction'

export interface DiversityIssue {
  key: 'asn' | 'subnet' | 'domain' | 'country'
  severity: DiversitySeverity
  /** States the observation, not a conclusion — see above. */
  label: string
}

/** host[:port] → host, with any scheme and trailing path removed. */
export function endpointHost(api: string | null | undefined): string | null {
  if (typeof api !== 'string') return null
  let host = api.trim()
  if (host === '') return null
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  host = host.split('/')[0]
  // IPv6 literals are bracketed; anything else splits on the port colon.
  const bracketed = host.match(/^\[([^\]]+)\]/)
  if (bracketed) return bracketed[1].toLowerCase()
  const colon = host.lastIndexOf(':')
  if (colon > 0) host = host.slice(0, colon)
  return host.toLowerCase() || null
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** The /24 an IPv4 endpoint sits in, or null when the host isn't an IPv4 literal. */
export function ipv4Slash24(host: string | null): string | null {
  if (host === null) return null
  const m = host.match(IPV4)
  if (!m) return null
  const octets = m.slice(1, 5).map(Number)
  if (octets.some((o) => o > 255)) return null
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
}

/**
 * The domain two hostnames share, when both are subdomains of it — the tell that
 * catches an operator's fleet (`nlv2.pytonode.my.id` and `hk2.pytonode.my.id`).
 * Returns null unless the shared suffix is at least two labels AND both hosts have
 * a label of their own in front of it.
 *
 * Deliberately not a public-suffix lookup: two unrelated hosts named `a.example.co.uk`
 * and `b.other.co.uk` share `co.uk` and would be reported. That is why the issue is
 * worded as "these two endpoints share the domain X" rather than "same operator" —
 * it states what was observed and lets the user judge it.
 */
export function sharedDomain(a: string | null, b: string | null): string | null {
  if (a === null || b === null || a === b) return null
  if (ipv4Slash24(a) !== null || ipv4Slash24(b) !== null) return null
  const al = a.split('.')
  const bl = b.split('.')
  let shared = 0
  while (shared < al.length && shared < bl.length && al[al.length - 1 - shared] === bl[bl.length - 1 - shared]) {
    shared++
  }
  if (shared < 2 || shared >= al.length || shared >= bl.length) return null
  return al.slice(al.length - shared).join('.')
}

/**
 * Everything that suggests the two hops are not independent. Empty means nothing
 * detectable links them — which is not the same as proof that they are separate.
 */
export function chainDiversityIssues(entry: SentNode, exit: SentNode): DiversityIssue[] {
  const issues: DiversityIssue[] = []

  const asn = (n: SentNode) => (n.asn || '').trim()
  if (asn(entry) !== '' && asn(entry) === asn(exit)) {
    issues.push({
      key: 'asn',
      severity: 'operator',
      label: `Both hops are in AS${asn(entry)}. The same network operator announces both.`,
    })
  }

  const entryHost = endpointHost(entry.api)
  const exitHost = endpointHost(exit.api)
  const entrySubnet = ipv4Slash24(entryHost)
  if (entrySubnet !== null && entrySubnet === ipv4Slash24(exitHost)) {
    issues.push({
      key: 'subnet',
      severity: 'operator',
      label: `Both hops are in ${entrySubnet}, almost certainly the same machine or rack.`,
    })
  }

  const domain = sharedDomain(entryHost, exitHost)
  if (domain !== null) {
    issues.push({
      key: 'domain',
      severity: 'operator',
      label: `Both endpoints are hosts under ${domain}.`,
    })
  }

  const country = (n: SentNode) => n.country.trim()
  if (country(entry) !== '' && country(entry) === country(exit)) {
    issues.push({
      key: 'country',
      severity: 'jurisdiction',
      label: `Both hops are in ${country(entry)}. One legal request can reach both.`,
    })
  }

  return issues
}

/** True when something suggests one operator holds both hops (not merely one country). */
export function hasOperatorOverlap(issues: DiversityIssue[]): boolean {
  return issues.some((i) => i.severity === 'operator')
}
