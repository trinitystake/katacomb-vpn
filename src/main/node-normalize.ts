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
