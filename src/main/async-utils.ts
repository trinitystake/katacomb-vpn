/**
 * Race a promise against a timeout. Rejects with `<label> timed out after <ms>ms`
 * if `p` hasn't settled by then; otherwise passes the result/rejection through.
 * Bounds the *wait*, not the underlying work — a timed-out promise keeps running
 * and its eventual result is ignored (e.g. the SDK's axios request has no abort
 * hook). Used by provider-service (RPC connect/query) and the node handshake.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
