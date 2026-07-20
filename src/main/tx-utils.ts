import { TimeoutError } from '@cosmjs/stargate'

/**
 * Wrap a session-creating broadcast so a CosmJS `TimeoutError` (the tx wasn't
 * confirmed within the client's poll window) becomes an actionable, money-aware
 * message instead of a raw error. The tx MAY still land, so the message points the
 * user at the Session tab to cancel any unexpected session (finding H2). Where a
 * `timeoutHeight` is also set on the broadcast, the chain additionally rejects a
 * tx that misses the window, bounding the late-landing risk.
 */
export async function broadcastOrTimeout<T>(p: Promise<T>, timeoutMessage: string): Promise<T> {
  try {
    return await p
  } catch (err) {
    if (err instanceof TimeoutError) throw new Error(timeoutMessage)
    throw err
  }
}
