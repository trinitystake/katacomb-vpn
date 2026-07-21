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
  // Xray-core v26.3.27 (official XTLS/Xray-core Xray-linux-64.zip release, zip
  // SHA2-256 23cd9af9…f7c8ae verified against the published .dgst).
  xray: '8255dd939c34cf966cc91517b6324dd3c8d0bcf49ffac8beca049a38c46845ed',
  // Hysteria2 v2.10.0 (official apernet/hysteria app/v2.10.0 hysteria-linux-amd64,
  // non-AVX; SHA-256 verified against the release's hashes.txt).
  hysteria: '04f7804159ef1d798de12a817d73aab4b9040ebe45fc62e223000c5c59e987fe',
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
