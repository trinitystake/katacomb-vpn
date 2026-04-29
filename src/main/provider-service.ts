import { SentinelClient, Status } from '@sentinel-official/sentinel-js-sdk'
import Long from 'long'
import { getRpcEndpoint } from './settings'
import { isVpnActive } from './vpn-manager'
import {
  getCachedProviders,
  isCacheFresh,
  setCachedProviders,
} from './provider-cache'

export interface ProviderInfo {
  address: string
  name: string
  identity: string
  website: string
  description: string
}

type RawProvider = {
  address: string
  name: string
  identity: string
  website: string
  description: string
}

function toInfo(p: RawProvider): ProviderInfo {
  return {
    address: p.address,
    name: p.name,
    identity: p.identity,
    website: p.website,
    description: p.description,
  }
}

const CONNECT_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 10_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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

let sharedClient: SentinelClient | null = null
let sharedClientEndpoint: string | null = null

async function getSharedClient(): Promise<SentinelClient> {
  const endpoint = getRpcEndpoint()
  if (sharedClient && sharedClientEndpoint === endpoint) return sharedClient
  if (sharedClient) {
    try {
      sharedClient.disconnect()
    } catch {
      // ignore
    }
    sharedClient = null
    sharedClientEndpoint = null
  }
  const client = await withTimeout(SentinelClient.connect(endpoint), CONNECT_TIMEOUT_MS, 'RPC connect')
  sharedClient = client
  sharedClientEndpoint = endpoint
  return client
}

function resetSharedClient(): void {
  if (sharedClient) {
    try {
      sharedClient.disconnect()
    } catch {
      // ignore
    }
  }
  sharedClient = null
  sharedClientEndpoint = null
}

async function fetchProvidersFromChain(): Promise<ProviderInfo[]> {
  const client = await getSharedClient()
  const results: ProviderInfo[] = []
  let nextKey: Uint8Array = new Uint8Array()
  let firstPage = true
  const MAX = 2000

  while (results.length < MAX) {
    const pagination = {
      key: nextKey,
      offset: Long.fromNumber(0, true),
      limit: Long.fromNumber(500, true),
      countTotal: firstPage,
      reverse: false,
    }
    firstPage = false

    const resp = await withTimeout(
      Promise.resolve(client.sentinelQuery?.provider.providers(Status.STATUS_UNSPECIFIED, pagination)),
      QUERY_TIMEOUT_MS,
      'provider.providers',
    )
    if (!resp || !resp.providers) break

    for (const p of resp.providers as unknown as RawProvider[]) {
      if (!p.address) continue
      results.push(toInfo(p))
    }

    const nk = resp.pagination?.nextKey
    if (!nk || nk.length === 0) break
    nextKey = nk
  }

  return results
}

let inflightRefresh: Promise<ProviderInfo[]> | null = null

function refreshInBackground(): void {
  if (inflightRefresh) return
  inflightRefresh = fetchProvidersFromChain()
    .then((fresh) => {
      if (fresh.length > 0) setCachedProviders(fresh)
      return fresh
    })
    .catch(() => {
      resetSharedClient()
      return [] as ProviderInfo[]
    })
    .finally(() => {
      inflightRefresh = null
    })
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const cached = getCachedProviders()

  // VPN active: RPC is unreachable through the tunnel. Never attempt the network.
  if (isVpnActive()) return cached.providers

  const cacheFresh = isCacheFresh() && cached.providers.length > 0

  // Fresh cache: return immediately, refresh in the background for next time.
  if (cacheFresh) {
    refreshInBackground()
    return cached.providers
  }

  // Stale or empty: fetch with a hard timeout, fall back to cache on failure.
  if (inflightRefresh) {
    try {
      return await inflightRefresh
    } catch {
      return cached.providers
    }
  }

  try {
    const fresh = await fetchProvidersFromChain()
    if (fresh.length > 0) setCachedProviders(fresh)
    return fresh
  } catch {
    resetSharedClient()
    return cached.providers
  }
}

export async function getProvider(address: string): Promise<ProviderInfo | null> {
  const all = await listProviders()
  return all.find((p) => p.address === address) ?? null
}
