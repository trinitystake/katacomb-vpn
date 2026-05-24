import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

export interface NodesCacheFile {
  nodes: unknown[]
  fetchedAt: number
}

function cachePath(): string {
  return join(app.getPath('userData'), 'nodes-cache.json')
}

export function loadNodesCache(): NodesCacheFile | null {
  const p = cachePath()
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as NodesCacheFile
    if (!Array.isArray(data?.nodes) || typeof data?.fetchedAt !== 'number') return null
    return data
  } catch {
    return null
  }
}

export function saveNodesCache(nodes: unknown[]): void {
  try {
    writeFileSync(cachePath(), JSON.stringify({ nodes, fetchedAt: Date.now() }))
  } catch {
    // silent — disk full / permission errors must not break the app
  }
}
