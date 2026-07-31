import { useEffect, useState } from 'react'
import type { RpcHealth } from '../../shared/rpc-health'

const INITIAL: RpcHealth = {
  state: 'unknown',
  endpoint: '',
  reachable: false,
  latencyMs: null,
  chainId: null,
  height: null,
  blockAgeSec: null,
  error: null,
  checkedAt: 0,
}

/**
 * Health of the RPC endpoint every chain read and transaction goes through.
 *
 * No polling: main owns the cadence and pushes on change, the same shape as
 * `onNodesUpdate`. `state: 'suspended'` means our own tunnel is up and the chain
 * is unreachable through it by design — that is not a fault, so don't warn on it.
 */
export function useRpcHealth(): RpcHealth {
  const [health, setHealth] = useState<RpcHealth>(INITIAL)

  useEffect(() => {
    let cancelled = false
    window.api.rpcHealthGet()
      .then((h) => { if (!cancelled) setHealth(h) })
      .catch(() => { /* keep 'unknown' — the push below will correct it */ })
    const unsubscribe = window.api.onRpcHealthUpdate(setHealth)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return health
}
