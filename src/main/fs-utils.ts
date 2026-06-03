import { writeFileSync, renameSync } from 'fs'

/**
 * Write a file atomically: write a sibling temp file, then rename over the
 * target (rename is atomic on the same filesystem). Defaults to 0o600 so
 * settings / wallet-index / cache files aren't created world-readable. A
 * crash mid-write leaves the previous file intact instead of a truncated one.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}
