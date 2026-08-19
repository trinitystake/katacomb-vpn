import { makeDiskCache } from './disk-cache'

export interface NodesCacheFile {
  nodes: unknown[]
  fetchedAt: number
}

const cache = makeDiskCache<unknown>('nodes-cache.json', 'nodes')

export function loadNodesCache(): NodesCacheFile | null {
  const disk = cache.load()
  return disk ? { nodes: disk.items, fetchedAt: disk.fetchedAt } : null
}

export function saveNodesCache(nodes: unknown[]): void {
  cache.save(nodes, Date.now())
}
