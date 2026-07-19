import { createHash } from 'crypto'
import { readFileSync } from 'fs'

// SHA-256 hashes of the bundled binaries (vendored in-repo under
// resources/linux/v2ray/ and shipped in the package). Shared by the user-space
// app (vpn-manager) and the root daemon, which both refuse to execute a binary
// whose hash doesn't match. Update these whenever the vendored binaries are
// replaced. Node builtins only — importable by the standalone daemon (no Electron deps).
export const BUNDLED_HASHES: Record<string, string> = {
  v2ray: '751f52a3d9324c993953b7ebb6aab79e77115542a8ca1ef83078cb215c03dea8',
  tun2socks: '42ce074a9a225825ef5e3f21b3657af7ed25187f7cd4e6d11e0646d5d166eb04',
}

/** Verify a bundled binary's SHA-256 hash matches the expected value. */
export function verifyBinaryIntegrity(path: string, name: string): boolean {
  const expected = BUNDLED_HASHES[name]
  if (!expected) return true // no hash registered — skip check
  try {
    const data = readFileSync(path)
    const actual = createHash('sha256').update(data).digest('hex')
    return actual === expected
  } catch {
    return false
  }
}
