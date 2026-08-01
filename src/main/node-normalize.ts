// Where the node feed's text fields are made to match the type the rest of the
// app declares for them.
//
// api.sentnodes.com sends `null` for any string it doesn't know — 43 of ~1800
// nodes have no country, 41 no moniker — but the renderer's `SentNode` types all
// of them as `string`. Anything that then does `node.country.toLowerCase()` (a
// search box, a sort, a lookup) throws and takes the whole React tree down with
// it. Fixing it at the single point where the feed enters the app is what makes
// that type true everywhere else, instead of every read site guessing.

const TEXT_FIELDS = ['moniker', 'version', 'api', 'asn', 'country', 'city'] as const

/** Replaces null/undefined text fields with '', leaving everything else alone. */
export function normalizeNodes(raw: unknown[]): unknown[] {
  return raw.map((entry) => {
    const node = { ...(entry as Record<string, unknown>) }
    for (const field of TEXT_FIELDS) {
      if (node[field] === null || node[field] === undefined) node[field] = ''
    }
    return node
  })
}

/** One page of the node feed: its entries, and how many pages there are in total. */
export interface NodesPage {
  /** Raw entries — still needs normalizeNodes(). */
  nodes: unknown[]
  /** Total page count for this query; 1 when the feed isn't paginated. */
  lastPage: number
}

/**
 * Reads the `/v2/nodes` envelope. On 2026-08-01 the aggregator changed `data`
 * from a flat array of every node into `{nodes: [...200], pagination: {...}}`,
 * which the old reader rejected outright — the app then ran on its disk cache
 * with no way to refresh. Both shapes are accepted so a revert upstream doesn't
 * break it a second time.
 *
 * Throws on anything else: a partial list silently replacing the full one is
 * worse than keeping the last good cache.
 */
export function parseNodesPage(json: unknown): NodesPage {
  const body = json as { success?: boolean; data?: unknown } | null
  if (typeof body !== 'object' || body === null || body.success !== true) {
    throw new Error('Invalid response from node API')
  }
  if (Array.isArray(body.data)) return { nodes: body.data, lastPage: 1 }

  const data = body.data as { nodes?: unknown; pagination?: { lastPage?: unknown } } | null
  if (typeof data !== 'object' || data === null || !Array.isArray(data.nodes)) {
    throw new Error('Invalid response from node API')
  }
  const lastPage = data.pagination?.lastPage
  return {
    nodes: data.nodes,
    lastPage: typeof lastPage === 'number' && Number.isInteger(lastPage) && lastPage > 0 ? lastPage : 1,
  }
}
