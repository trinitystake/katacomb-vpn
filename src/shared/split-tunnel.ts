/**
 * The split-tunnel bypass-route rule as the Settings pane needs to see it.
 *
 * SETTINGS_SET rejects the WHOLE array if any single entry fails
 * `isAllowedBypassCidr`, so a renderer that can't evaluate the rule locally only
 * finds out by being rejected — which is how "Save Routes" came to do nothing at
 * all on a bare IP, a hostname, an IPv6 range or a trailing `# comment`: the
 * click handler had no catch and the rejection went nowhere.
 *
 * `isAllowedBypassCidr` is deliberately a MIRROR of the one in
 * `main/config-guard.ts`, not an import of it — that module is the security
 * boundary and stays free of local runtime imports so the native test runner can
 * load it (the same arrangement `renderer/utils/connect-errors.ts` has with
 * `shared/error-markers.ts`). `split-tunnel.test.ts` asserts the two agree over a
 * table of inputs, so drift fails loudly. **The main-process copy is the
 * authority; this one only decides what the UI says before it asks.**
 */

/** Most bypass routes the app will store. Enforced at the IPC boundary too. */
export const MAX_SPLIT_TUNNEL_ROUTES = 64

/**
 * True for an IPv4 CIDR that is safe to route around the tunnel. Rejects
 * `0.0.0.0/x` and `/0` (either would send the whole default route past the VPN)
 * and out-of-range octets/prefixes.
 */
export function isAllowedBypassCidr(cidr: string): boolean {
  const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/)
  if (!m) return false
  const octets = [m[1], m[2], m[3], m[4]].map((o) => parseInt(o, 10))
  const prefix = parseInt(m[5], 10)
  if (octets.some((o) => o > 255)) return false
  if (prefix < 1 || prefix > 32) return false
  if (octets.every((o) => o === 0)) return false // 0.0.0.0/x — would bypass the whole tunnel
  return true
}

export interface SplitTunnelParse {
  /** Every non-blank line that passes the CIDR rule, trimmed, in order. */
  routes: string[]
  /** Non-blank lines that would make SETTINGS_SET throw, verbatim so they can be shown. */
  invalid: string[]
  /** True once the entry count is past what the IPC boundary accepts. */
  tooMany: boolean
}

/**
 * Split the Settings textarea into the array SETTINGS_SET receives, plus the
 * lines that would be rejected. Blank lines are dropped, not reported — a
 * trailing newline is not a user error.
 */
export function parseSplitTunnelRoutes(text: string): SplitTunnelParse {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const routes: string[] = []
  const invalid: string[] = []
  for (const line of lines) {
    if (isAllowedBypassCidr(line)) routes.push(line)
    else invalid.push(line)
  }
  return { routes, invalid, tooMany: lines.length > MAX_SPLIT_TUNNEL_ROUTES }
}
