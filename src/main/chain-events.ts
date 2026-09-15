// Finds one typed event in a transaction's event list.
//
// Replaces the SDK's `searchEvent`, which was a three-line linear scan. Kept as a
// named function rather than inlined at the four call sites because the event
// TYPE constants still come from the SDK's generated modules, and having one
// place that pairs them keeps the next reader from wondering whether the scan
// differs between the node and subscription paths. It does not.
//
// Electron-free and import-free, so it runs under the native test runner.

export interface ChainEvent {
  type: string
  attributes: { key: string; value: string }[]
}

/** The first event of `type`, or null. Order is the chain's, so first wins. */
export function searchEvent<T extends { type: string }>(type: string, events: readonly T[]): T | null {
  for (const event of events) {
    if (event.type === type) return event
  }
  return null
}
