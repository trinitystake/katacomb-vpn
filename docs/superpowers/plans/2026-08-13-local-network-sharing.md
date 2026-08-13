# Local Network Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reach their own LAN (SSH, printers, NAS) while the kill switch is armed, via an opt-in firewall exception — and make the Kill Switch and LAN Sharing toggles apply immediately instead of at the next connection.

**Architecture:** Purely a firewall change. The `KATACOMB_KILLSWITCH` iptables chain gains ACCEPT rules for a hardcoded set of private/link-local/multicast ranges, inserted before its terminal DROP. The app sends **one boolean** across the trust boundary; the ranges themselves live only in the root helper. Routing is untouched for all six protocols. A pure decision function in `connect-decisions.ts` decides arm / disarm / re-arm / nothing when a setting changes mid-session.

**Tech Stack:** TypeScript (Electron main + React renderer), bash root helper, Node's native `--test` runner.

Design spec: `docs/superpowers/specs/2026-08-13-local-network-sharing-design.md`.
Branch: `feature/local-network-sharing` (already created; the spec is committed on it).

## Global Constraints

- **Node/npm are not on `PATH` in this environment.** Resolve the absolute paths once at the start (`ls ~/.nvm/versions/node/*/bin/node`) and use them for every `npm run typecheck` / `npm test` in this plan.
- `npm run typecheck` must pass clean — `tsc` is `strict` with `noUnusedLocals`/`noUnusedParameters`. There is no linter.
- Tests use Node's native runner against `src/**/*.test.ts`. Import the module under test with an explicit `.ts` extension. No Vitest/Jest, no new dependencies.
- **The LAN ranges are hardcoded in `resources/linux/katacomb-vpn-helper.sh` only.** They are never passed from the app, never user-editable, never derived from node data. The only value crossing the socket/pkexec boundary is a boolean.
- The daemon socket is unauthenticated, so **all validation lives in `daemon-core.ts`**. `daemon-core.ts` must NOT import `electron`.
- Adding an optional field to an existing daemon op is additive — **no protocol version bump** (same precedent as the amneziawg and openvpn ops).
- Sentinel token literal, identical in TS and bash: **`lan-sharing`**.
- Default for the new setting is `false`.
- Do not modify `settings.splitTunnelRoutes`, `bringUpTun`, or any routing code. Do not touch the INPUT chain.
- Surgical edits only: move existing comments with the code they explain, don't reformat neighbours.

---

### Task 1: Add the `lanSharing` setting

**Files:**
- Modify: `src/main/settings.ts:51-79`
- Modify: `src/renderer/types/index.ts:226` (the renderer's `AppSettings`)
- Modify: `src/main/ipc-handlers.ts:1676-1679` (allow-list) and `:1691-1693` (validation)

**Interfaces:**
- Consumes: nothing.
- Produces: `AppSettings.lanSharing: boolean` (default `false`), readable via `loadSettings()` in main and `window.api.settingsGet()` in the renderer, writable via `SETTINGS_SET`.

- [ ] **Step 1: Add the field to the main-process `AppSettings`**

In `src/main/settings.ts`, add to the `AppSettings` interface immediately after `killSwitch: boolean`:

```ts
  killSwitch: boolean
  /**
   * Let LAN destinations (SSH, printers, NAS) past the kill switch's DROP-all
   * chain. Only meaningful while the kill switch is armed — with it off the LAN
   * is already reachable, since no protocol's routing captures it. The ranges
   * live in the root helper; this boolean is all that crosses the boundary.
   */
  lanSharing: boolean
```

- [ ] **Step 2: Add the default**

In the same file, in `DEFAULT_SETTINGS`, immediately after `killSwitch: false,`:

```ts
  killSwitch: false,
  lanSharing: false,
```

- [ ] **Step 3: Mirror the field in the renderer types**

In `src/renderer/types/index.ts`, find the `AppSettings` interface (the `splitTunnelRoutes: string[]` line is at :226) and add `lanSharing: boolean` directly after its `killSwitch: boolean` line, matching the surrounding field style.

- [ ] **Step 4: Allow the key through `SETTINGS_SET`**

In `src/main/ipc-handlers.ts`, in the `allowed` Set (:1676-1679), add `'lanSharing'` after `'killSwitch'`:

```ts
    const allowed = new Set([
      'rpcEndpoint', 'activeWalletId', 'killSwitch', 'lanSharing', 'dnsResolver', 'autoReconnect',
      'bookmarkedNodes', 'splitTunnelRoutes',
    ])
```

- [ ] **Step 5: Validate the type**

Directly after the existing `killSwitch` check (:1691-1693), add:

```ts
    if (filtered.lanSharing !== undefined && typeof filtered.lanSharing !== 'boolean') {
      throw new Error('Invalid lanSharing: expected boolean')
    }
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean (no output, exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/main/settings.ts src/renderer/types/index.ts src/main/ipc-handlers.ts
git commit -m "Add lanSharing setting, defaulting off"
```

---

### Task 2: Emit the LAN ACCEPT rules from the root helper

**Files:**
- Modify: `resources/linux/katacomb-vpn-helper.sh` — header constants (~:6-30), `ipv6_killswitch_on()` (:268-278), the `killswitch-on)` case (:496-560)

**Interfaces:**
- Consumes: nothing.
- Produces: the helper CLI contract `killswitch-on <iface> <remote_ip> [dns_ip] [lan-sharing]`, where `lan-sharing` is recognised **only as the trailing argument**. The three- and four-argument forms keep their exact current meaning.

- [ ] **Step 1: Add the constants**

In `resources/linux/katacomb-vpn-helper.sh`, after the `PERSIST_DIR="/var/lib/katacomb-vpn"` line:

```bash
# --- Local network sharing ---
# Destinations that stay reachable while the kill switch is armed, so the user can
# still reach their own LAN. Hardcoded HERE on purpose: the app sends one boolean
# and never a range, so nothing a compromised renderer — or the unauthenticated
# daemon socket — can say turns this into a hole to a public address.
# An ACCEPT in OUTPUT only permits; it does not route. A packet reaches the
# physical NIC only if the routing table already decided the destination was
# local, so these rules cannot pull tunnel traffic out of the tunnel.
LAN_SHARING_ARG="lan-sharing"
LAN_RANGES_V4=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 224.0.0.0/4 255.255.255.255/32)
# fe80::/10 also unbreaks neighbour discovery, which the v6 chain drops today.
LAN_RANGES_V6=(fe80::/10 fc00::/7 ff00::/8)
```

- [ ] **Step 2: Parse the trailing sentinel in the `killswitch-on` case**

In the `killswitch-on)` case, replace the three assignment lines

```bash
    VPN_IFACE="${2:-}"
    REMOTE_HOST="${3:-}"
    DNS_IP="${4:-}"
```

with:

```bash
    VPN_IFACE="${2:-}"
    REMOTE_HOST="${3:-}"
    DNS_IP="${4:-}"
    # The LAN flag is a TRAILING sentinel token, so `killswitch-on <if> <host>` and
    # `killswitch-on <if> <host> <dns>` keep their exact meaning. It can collide
    # with neither $2 (an interface name) nor $3/$4 (IPv4 literals).
    LAN_SHARING=0
    if [[ "${!#}" == "$LAN_SHARING_ARG" ]]; then
      LAN_SHARING=1
      [[ "$DNS_IP" == "$LAN_SHARING_ARG" ]] && DNS_IP=""
    fi
```

The existing `if [[ -n "$DNS_IP" ]]; then validate_ipv4 "$DNS_IP"; fi` below is now correct for the no-DNS-with-LAN case, because `DNS_IP` was blanked.

- [ ] **Step 3: Insert the v4 ACCEPT rules before the DROP**

In the same case, find

```bash
    # Drop everything else
    iptables -w 5 -A "$CHAIN" -j DROP
```

and insert immediately **above** it:

```bash
    # Local network sharing — must precede the DROP below.
    if [[ "$LAN_SHARING" == "1" ]]; then
      for range in "${LAN_RANGES_V4[@]}"; do
        iptables -w 5 -A "$CHAIN" -d "$range" -j ACCEPT
      done
    fi
```

- [ ] **Step 4: Take the flag in `ipv6_killswitch_on`**

Replace the whole function (:268-278) with:

```bash
ipv6_killswitch_on() {
  local vpn_iface="$1"
  local lan_sharing="${2:-0}"
  ipv6_killswitch_off
  # Short-circuited so a partial failure aborts and the caller can clean up.
  ip6tables -w 5 -N "$CHAIN6" &&
  ip6tables -w 5 -A "$CHAIN6" -o lo -j ACCEPT &&
  ip6tables -w 5 -A "$CHAIN6" -o "$vpn_iface" -j ACCEPT &&
  ip6tables -w 5 -A "$CHAIN6" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  if [[ "$lan_sharing" == "1" ]]; then
    for range in "${LAN_RANGES_V6[@]}"; do
      ip6tables -w 5 -A "$CHAIN6" -d "$range" -j ACCEPT || return 1
    done
  fi
  ip6tables -w 5 -A "$CHAIN6" -j DROP &&
  ip6tables -w 5 -A OUTPUT -j "$CHAIN6"
}
```

- [ ] **Step 5: Pass the flag at the v6 call site**

At :552-553, change

```bash
      ipv6_killswitch_on "$VPN_IFACE" || { ipv6_killswitch_off; echo "Warning: IPv6 kill switch setup failed; IPv4 kill switch active" >&2; }
```

to

```bash
      ipv6_killswitch_on "$VPN_IFACE" "$LAN_SHARING" || { ipv6_killswitch_off; echo "Warning: IPv6 kill switch setup failed; IPv4 kill switch active" >&2; }
```

- [ ] **Step 6: Update the usage string**

At :661, change the `killswitch-on <iface> <host> [dns]` fragment to `killswitch-on <iface> <host> [dns] [lan-sharing]`. Leave the rest of the line alone.

- [ ] **Step 7: Syntax-check the helper**

Run: `bash -n resources/linux/katacomb-vpn-helper.sh`
Expected: no output, exit 0.

- [ ] **Step 8: Verify the sentinel parsing in isolation**

The helper needs root to run, so check just the parsing logic with the same expressions:

```bash
bash -c 'set -- killswitch-on sntl0 203.0.113.7 lan-sharing
  LAN_SHARING_ARG="lan-sharing"; DNS_IP="${4:-}"; LAN=0
  if [[ "${!#}" == "$LAN_SHARING_ARG" ]]; then LAN=1; [[ "$DNS_IP" == "$LAN_SHARING_ARG" ]] && DNS_IP=""; fi
  echo "lan=$LAN dns=[$DNS_IP]"'
```
Expected: `lan=1 dns=[]`

```bash
bash -c 'set -- killswitch-on sntl0 203.0.113.7 1.1.1.1 lan-sharing
  LAN_SHARING_ARG="lan-sharing"; DNS_IP="${4:-}"; LAN=0
  if [[ "${!#}" == "$LAN_SHARING_ARG" ]]; then LAN=1; [[ "$DNS_IP" == "$LAN_SHARING_ARG" ]] && DNS_IP=""; fi
  echo "lan=$LAN dns=[$DNS_IP]"'
```
Expected: `lan=1 dns=[1.1.1.1]`

```bash
bash -c 'set -- killswitch-on sntl0 203.0.113.7 1.1.1.1
  LAN_SHARING_ARG="lan-sharing"; DNS_IP="${4:-}"; LAN=0
  if [[ "${!#}" == "$LAN_SHARING_ARG" ]]; then LAN=1; [[ "$DNS_IP" == "$LAN_SHARING_ARG" ]] && DNS_IP=""; fi
  echo "lan=$LAN dns=[$DNS_IP]"'
```
Expected: `lan=0 dns=[1.1.1.1]`

- [ ] **Step 9: Commit**

```bash
git add resources/linux/katacomb-vpn-helper.sh
git commit -m "Helper: LAN sharing ACCEPT rules behind a trailing sentinel arg"
```

---

### Task 3: Validate and forward the flag in the daemon

**Files:**
- Create: nothing
- Modify: `src/main/config-guard.ts` (add the shared token constant), `src/main/daemon-core.ts:244-259`
- Test: `src/main/daemon-core.test.ts` (add cases near the existing killswitch tests at :247-260)

**Interfaces:**
- Consumes: the helper contract from Task 2.
- Produces: `LAN_SHARING_ARG: string` exported from `src/main/config-guard.ts` (value `'lan-sharing'`); daemon op `killswitch_on` accepts an optional `lanSharing?: boolean` arg.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/daemon-core.test.ts`, after the existing `killswitch_on refuses the 0.0.0.0 whitelist…` test:

```ts
test('killswitch_on appends the LAN sharing token when asked', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('killswitch_on', { iface: 'sntl0', remoteHost: '203.0.113.7', lanSharing: true }), deps)
  assert.equal(res.ok, true)
  assert.deepEqual(helperCalls, [['killswitch-on', 'sntl0', '203.0.113.7', 'lan-sharing']])
})

test('killswitch_on keeps the LAN token trailing, after the DNS arg', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(
    req('killswitch_on', { iface: 'sntl0', remoteHost: '203.0.113.7', dnsIp: '1.1.1.1', lanSharing: true }),
    deps,
  )
  assert.equal(res.ok, true)
  assert.deepEqual(helperCalls, [['killswitch-on', 'sntl0', '203.0.113.7', '1.1.1.1', 'lan-sharing']])
})

test('killswitch_on omits the LAN token when the flag is false or absent', () => {
  const { deps, helperCalls } = makeDeps()
  assert.equal(handleRequest(req('killswitch_on', { iface: 'sntl0', remoteHost: '203.0.113.7', lanSharing: false }), deps).ok, true)
  assert.deepEqual(helperCalls, [['killswitch-on', 'sntl0', '203.0.113.7']])
})

test('killswitch_on rejects a non-boolean lanSharing rather than coercing it', () => {
  const { deps, helperCalls } = makeDeps()
  const res = handleRequest(req('killswitch_on', { iface: 'sntl0', remoteHost: '203.0.113.7', lanSharing: 'yes' }), deps)
  assert.equal(res.ok, false)
  assert.deepEqual(helperCalls, [])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the four new tests FAIL — the three positive ones because the token is never appended, the rejection one because a truthy string is currently ignored rather than refused.

- [ ] **Step 3: Add the shared token constant**

In `src/main/config-guard.ts`, near `MAX_BYPASS_ROUTES` (:188), add:

```ts
/**
 * Trailing sentinel appended to the helper's `killswitch-on` argv to request the
 * local-network ACCEPT rules. A sentinel rather than a fourth positional arg
 * because the DNS arg before it is optional. **The bash helper hardcodes this
 * same literal** (LAN_SHARING_ARG) — change both together.
 */
export const LAN_SHARING_ARG = 'lan-sharing'
```

- [ ] **Step 4: Validate and append in the daemon**

In `src/main/daemon-core.ts`, add `LAN_SHARING_ARG` to the existing import from `./config-guard` (:19 area). Then in the `killswitch_on` case, after the `remoteHost === '0.0.0.0'` guard and before `deps.runHelper(helperArgs)`:

```ts
        if (a.lanSharing !== undefined && typeof a.lanSharing !== 'boolean') {
          return fail('killswitch_on: invalid lanSharing')
        }
        const helperArgs = ['killswitch-on', a.iface, a.remoteHost]
        if (a.dnsIp !== undefined && a.dnsIp !== null) {
          if (typeof a.dnsIp !== 'string' || !isIPv4(a.dnsIp)) return fail('killswitch_on: invalid dnsIp')
          helperArgs.push(a.dnsIp)
        }
        // Trailing, so the helper's `${!#}` check finds it and the DNS arg keeps
        // its position.
        if (a.lanSharing === true) helperArgs.push(LAN_SHARING_ARG)
        deps.runHelper(helperArgs)
```

(The `lanSharing` type check goes above the `helperArgs` declaration so a bad value is refused before any arg is built.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests pass, including the pre-existing `killswitch_on passes a real endpoint IP through to the helper` (which asserts the exact three-element argv — proof the default path is unchanged).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/config-guard.ts src/main/daemon-core.ts src/main/daemon-core.test.ts
git commit -m "Daemon: validate and forward the lanSharing flag"
```

---

### Task 4: Thread the flag through to the connect path

This task makes the feature work end-to-end **at connect time**. The live toggle comes in Tasks 5-6.

**Files:**
- Modify: `src/main/kill-switch.ts:31-41`, `src/main/privileged.ts:88-92`, `src/main/ipc-handlers.ts:1010-1011`

**Interfaces:**
- Consumes: `LAN_SHARING_ARG` from Task 3; the daemon op from Task 3; the helper contract from Task 2.
- Produces: `enableKillSwitch(vpnInterface: string, remoteHost: string, opts?: { dnsIp?: string; lanSharing?: boolean }): Promise<void>` — **the third parameter changes from a bare `dnsIp` string to an options object**; every call site must be updated.

- [ ] **Step 1: Change the `enableKillSwitch` signature**

In `src/main/kill-switch.ts`, add `LAN_SHARING_ARG` to the imports (`import { LAN_SHARING_ARG } from './config-guard'`) and replace the function (:30-41) with:

```ts
/** Enable kill switch — blocks all traffic except through the VPN interface and to the VPN server */
export async function enableKillSwitch(
  vpnInterface: string,
  remoteHost: string,
  opts: { dnsIp?: string; lanSharing?: boolean } = {},
): Promise<void> {
  // Mark BEFORE arming, so even a partial/failed arm (e.g. v4 chain added, v6
  // failed) is still covered by startup self-heal.
  markKillSwitchArmed()
  await runPrivileged([
    'killswitch-on',
    vpnInterface,
    remoteHost,
    ...(opts.dnsIp && opts.dnsIp !== 'system' ? [opts.dnsIp] : []),
    // Trailing — the helper reads it as the last argument.
    ...(opts.lanSharing ? [LAN_SHARING_ARG] : []),
  ])
}
```

- [ ] **Step 2: Parse the sentinel back out on the daemon route**

In `src/main/privileged.ts`, add `import { LAN_SHARING_ARG } from './config-guard'` alongside the existing imports, and replace the `killswitch-on` case (:88-92) with:

```ts
    case 'killswitch-on': {
      // The helper's argv is positional with an optional dns arg, so the LAN flag
      // rides as a trailing sentinel — strip it before destructuring the rest.
      const lanSharing = rest[rest.length - 1] === LAN_SHARING_ARG
      const [iface, remoteHost, dnsIp] = lanSharing ? rest.slice(0, -1) : rest
      await daemonRequest('killswitch_on', { iface, remoteHost, dnsIp, lanSharing })
      return
    }
```

`dnsIp` is `undefined` when absent, which the daemon's `a.dnsIp !== undefined && a.dnsIp !== null` guard already skips.

- [ ] **Step 3: Pass the setting at the connect-time call site**

In `src/main/ipc-handlers.ts`, replace lines 1010-1011:

```ts
      const dnsIp = v2rayDnsIp ?? undefined
      await enableKillSwitch(vpnIface, remoteHost, dnsIp)
```

with:

```ts
      const dnsIp = v2rayDnsIp ?? undefined
      await enableKillSwitch(vpnIface, remoteHost, { dnsIp, lanSharing: settings.lanSharing })
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. If it reports another `enableKillSwitch` call site, update it the same way — the options object is the only allowed form now.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all pass, unchanged from Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/main/kill-switch.ts src/main/privileged.ts src/main/ipc-handlers.ts
git commit -m "Arm the kill switch with the LAN sharing flag on connect"
```

---

### Task 5: Pure decision function for a mid-session toggle

**Files:**
- Modify: `src/main/connect-decisions.ts` (append; it is the repo's home for pure, Electron-free decision logic)
- Test: `src/main/connect-decisions.test.ts` (append)

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```ts
  export function decideFirewallAction(input: {
    killSwitch: boolean
    lanSharing: boolean
    armed: boolean
    armedLanSharing: boolean
    tunnelActive: boolean
  }): 'arm' | 'disarm' | 'rearm' | 'none'
  ```
  The union is written inline rather than as an exported `FirewallAction` alias:
  nothing else needs to name the type, and this repo treats exports without
  callers as an antipattern.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/connect-decisions.test.ts` (match the file's existing import style — it imports from `'./connect-decisions.ts'`):

```ts
test('decideFirewallAction disarms when the kill switch is switched off', () => {
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: false, armed: true, armedLanSharing: false, tunnelActive: true,
  }), 'disarm')
})

test('decideFirewallAction disarms an armed chain even with no tunnel up', () => {
  // The stand-down state ("expired, traffic blocked") — this is the user's way out.
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: false, armed: true, armedLanSharing: false, tunnelActive: false,
  }), 'disarm')
})

test('decideFirewallAction re-arms when LAN sharing changes under an armed chain', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: true, armedLanSharing: false, tunnelActive: true,
  }), 'rearm')
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: false, armed: true, armedLanSharing: true, tunnelActive: true,
  }), 'rearm')
})

test('decideFirewallAction re-arms in the stand-down state too', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: true, armedLanSharing: false, tunnelActive: false,
  }), 'rearm')
})

test('decideFirewallAction arms when the kill switch goes on over a live tunnel', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: false, armed: false, armedLanSharing: false, tunnelActive: true,
  }), 'arm')
})

test('decideFirewallAction does nothing with no tunnel to protect', () => {
  // Also covers proxy mode: isVpnActive() is false there by design, and the kill
  // switch is deliberately never armed for it.
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: false, armedLanSharing: false, tunnelActive: false,
  }), 'none')
})

test('decideFirewallAction does nothing when the chain already matches the settings', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: true, armedLanSharing: true, tunnelActive: true,
  }), 'none')
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: true, armed: false, armedLanSharing: false, tunnelActive: true,
  }), 'none')
})

test('decideFirewallAction ignores a LAN change while nothing is armed', () => {
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: true, armed: false, armedLanSharing: false, tunnelActive: true,
  }), 'none')
})
```

Add `decideFirewallAction` to the file's existing import from `'./connect-decisions.ts'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `decideFirewallAction is not a function` / no matching export.

- [ ] **Step 3: Implement**

Append to `src/main/connect-decisions.ts`:

```ts
/**
 * What to do to the kill-switch chain after the user toggles Kill Switch or Local
 * Network Sharing mid-session. The ARMED MARKER decides, not the connection
 * state: the chain deliberately outlives the tunnel in the stand-down ("expired,
 * traffic blocked") state, and the user must still be able to change their mind
 * there. `tunnelActive` is `isVpnActive()`, which is false in proxy mode by
 * design — so proxy mode can never reach 'arm'.
 */
export function decideFirewallAction(input: {
  killSwitch: boolean
  lanSharing: boolean
  armed: boolean
  armedLanSharing: boolean
  tunnelActive: boolean
}): 'arm' | 'disarm' | 'rearm' | 'none' {
  if (input.armed && !input.killSwitch) return 'disarm'
  if (input.armed && input.lanSharing !== input.armedLanSharing) return 'rearm'
  if (!input.armed && input.killSwitch && input.tunnelActive) return 'arm'
  return 'none'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/connect-decisions.ts src/main/connect-decisions.test.ts
git commit -m "Add pure decideFirewallAction for mid-session firewall toggles"
```

---

### Task 6: Apply the toggles live

**Files:**
- Modify: `src/main/ipc-handlers.ts` — new module state near `killSwitchFailed` (:143-147), extract `armKillSwitch()` out of `applyPostConnectSettings` (:983-1019), clear the state in `revertPostConnectSettings` (:1037-1042), hook `SETTINGS_SET` (:1718-1723)

**Interfaces:**
- Consumes: `decideFirewallAction` / `FirewallAction` (Task 5); `enableKillSwitch(iface, host, opts)` (Task 4); existing `disableKillSwitch`, `isKillSwitchArmed`, `isVpnActive`, `withConnectionLock`, `desiredProtocol`, `effectiveV2RayResolverIp`, `markDnsOverridden`, `isDnsOverridden`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Record what the chain was armed with**

In `src/main/ipc-handlers.ts`, next to `let killSwitchFailed = false` (:143), add:

```ts
// What the LIVE kill-switch chain was actually built with, recorded at arm time so
// a mid-session re-arm replays the same endpoint instead of re-deriving the
// protocol. Deliberately NOT cleared by standDownSession — that leaves the chain
// armed on purpose, and the user must still be able to toggle LAN sharing (or turn
// the kill switch off) in that state.
let armedWith: { iface: string; remoteHost: string; dnsIp?: string; lanSharing: boolean } | null = null
```

Add `decideFirewallAction` to the existing import from `'./connect-decisions'`.

- [ ] **Step 2: Extract `armKillSwitch()`**

Replace the body of the `if (settings.killSwitch) { … }` block in `applyPostConnectSettings` (:984-1019) with a call, and put the logic in a new function directly above `applyPostConnectSettings`. **Move the existing comments across verbatim** — they document decisions that are still true:

```ts
/**
 * Arm the kill switch for a live tunnel and remember what it was armed with.
 * Returns false when there is no endpoint IP to whitelist, so the caller can flag
 * killSwitchFailed: `-d 0.0.0.0/32 -j ACCEPT` matches nothing, so the DROP-all
 * rule would swallow the tunnel's OWN outer packets and the connection would die
 * with the interface still up and reporting "connected".
 */
async function armKillSwitch(
  protocol: 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn',
  dnsIp: string | undefined,
  lanSharing: boolean,
): Promise<boolean> {
  // AmneziaWG rides the WG branch throughout: same sntl0 iface, same Endpoint=
  // line in its config, and awg-quick owns resolv.conf like wg-quick does.
  const isWgLike = protocol === 'wireguard' || protocol === 'amneziawg'
  // OpenVPN has its own interface and its own `remote` line; the kill switch
  // itself is protocol-agnostic (`-d host -j ACCEPT`), so it needs no changes.
  const isOpenVpn = protocol === 'openvpn'
  const iface = isWgLike ? 'sntl0' : isOpenVpn ? 'sntl-ovpn' : 'sntl-tun'
  // Whitelist the *real* server endpoint so the tunnel can re-handshake while the
  // kill switch is engaged.
  const remoteHost =
    isWgLike ? getWireGuardRemoteHost() : isOpenVpn ? getOpenVpnRemoteHost() : getV2RayRemoteHost()
  if (!remoteHost) {
    console.error(`[killswitch] no endpoint IP for ${protocol} — not arming (traffic would be blackholed)`)
    return false
  }
  await enableKillSwitch(iface, remoteHost, { dnsIp, lanSharing })
  armedWith = { iface, remoteHost, dnsIp, lanSharing }
  return true
}
```

and in `applyPostConnectSettings`:

```ts
  // Enable kill switch
  if (settings.killSwitch) {
    try {
      const dnsIp = v2rayDnsIp ?? undefined
      if (!(await armKillSwitch(protocol, dnsIp, settings.lanSharing))) killSwitchFailed = true
    } catch (err) {
      console.error('Failed to enable kill switch:', err)
      // Don't silently leave the user thinking they're protected — flag it so
      // the renderer can warn. The connection itself is intentionally not torn
      // down (a transient daemon hiccup shouldn't drop a working tunnel).
      killSwitchFailed = true
    }
  }
```

Note the original used `return` after setting the flag; the kill-switch block is the last thing in the function, so falling through is equivalent.

- [ ] **Step 3: Clear the record on a confirmed teardown**

In `revertPostConnectSettings` (:1037-1042), change:

```ts
  if (isKillSwitchArmed()) {
    const teardownOk = await disableKillSwitch()
    killSwitchTeardownFailed = !teardownOk
    if (teardownOk) armedWith = null
  } else {
    killSwitchTeardownFailed = false
    armedWith = null
  }
```

- [ ] **Step 4: Add the live re-apply**

Add this function after `revertPostConnectSettings`:

```ts
/**
 * Re-apply the firewall after a mid-session Kill Switch / Local Network Sharing
 * toggle, so the toggles mean what they say instead of taking effect at the next
 * connect. `killswitch-on` flushes and rebuilds the chain, so a re-arm is one
 * idempotent call. Runs under the connection lock: arming reads the endpoint that
 * connect/disconnect are concurrently setting.
 */
async function reapplyFirewall(): Promise<void> {
  const settings = loadSettings()
  const action = decideFirewallAction({
    killSwitch: settings.killSwitch,
    lanSharing: settings.lanSharing,
    armed: isKillSwitchArmed(),
    armedLanSharing: armedWith?.lanSharing ?? false,
    tunnelActive: isVpnActive(),
  })
  if (action === 'none') return
  try {
    if (action === 'disarm') {
      const ok = await disableKillSwitch()
      killSwitchTeardownFailed = !ok
      if (ok) armedWith = null
      return
    }
    if (action === 'rearm') {
      // Needs the endpoint recorded at arm time. A chain stranded across a restart
      // has none (startup self-heal normally reverts it), so leave it alone —
      // turning the kill switch off still disarms.
      if (!armedWith) return
      await enableKillSwitch(armedWith.iface, armedWith.remoteHost, {
        dnsIp: armedWith.dnsIp,
        lanSharing: settings.lanSharing,
      })
      armedWith = { ...armedWith, lanSharing: settings.lanSharing }
      return
    }
    // 'arm' — a tunnel is up and the kill switch was just switched on.
    if (!desiredProtocol) return
    // Mirror applyPostConnectSettings' DNS decision for the dns-set protocols:
    // arming without a tunnel-routed resolver leaves DNS pointing at one the
    // chain now drops. effectiveV2RayResolverIp reads the (now true) killSwitch
    // setting, so a 'system' resolver becomes the public fallback.
    const needsDns = desiredProtocol === 'v2ray' || desiredProtocol === 'xray'
      || desiredProtocol === 'hysteria2' || desiredProtocol === 'openvpn'
    const dnsIp = needsDns ? effectiveV2RayResolverIp(settings) ?? undefined : undefined
    if (dnsIp && !isDnsOverridden()) {
      markDnsOverridden()
      try {
        await runPrivileged(['dns-set', dnsIp])
      } catch (err) {
        console.error('Failed to set DNS:', err)
      }
    }
    if (!(await armKillSwitch(desiredProtocol, dnsIp, settings.lanSharing))) killSwitchFailed = true
  } catch (err) {
    console.error('Failed to re-apply firewall settings:', err)
    killSwitchFailed = true
  }
}
```

- [ ] **Step 5: Hook it into `SETTINGS_SET`**

In the `SETTINGS_SET` handler, after `const saved = saveSettings(...)` and next to the existing `onRpcEndpointChanged()` call (:1718-1723), add:

```ts
    // Apply the firewall change now rather than at the next connect. Fire-and-
    // forget under the lock so the toggle returns immediately instead of queueing
    // behind an in-flight connect; failures surface through killSwitchFailed on
    // the connection status, the same path the connect-time arm uses.
    if (filtered.killSwitch !== undefined || filtered.lanSharing !== undefined) {
      void withConnectionLock(reapplyFirewall)
    }
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. `noUnusedLocals` will catch anything left dangling by the extraction.

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "Apply kill switch and LAN sharing toggles immediately"
```

---

### Task 7: The toggle, the docs, and live verification

**Files:**
- Modify: `src/renderer/components/Settings.tsx:421-434` (add the nested toggle after the Kill Switch row)
- Modify: `CLAUDE.md` (kill-switch invariants)

**Interfaces:**
- Consumes: `AppSettings.lanSharing` (Task 1), the live re-apply (Task 6).
- Produces: nothing.

- [ ] **Step 1: Add the toggle**

In `src/renderer/components/Settings.tsx`, directly after the Kill Switch row's closing `</div>` (:434) and before the Auto-Reconnect block, add:

```tsx
                {/* Local network sharing — a hole in the kill switch's DROP-all
                    chain, so it only means anything while that chain is armed.
                    With the kill switch off the LAN is already reachable: no
                    protocol's routing captures it. */}
                <div className="flex items-center justify-between py-3 px-4 border border-border bg-bg-tertiary rounded-md">
                  <div>
                    <span className="text-text-primary text-sm">Local Network Sharing</span>
                    <p className="text-text-tertiary text-xs mt-0.5">
                      {settings.killSwitch
                        ? 'Reach other devices on your network — SSH, printers, NAS — while the kill switch is on. This traffic stays on your LAN and is not encrypted by the VPN.'
                        : 'Only applies while the kill switch is on. Your local network is already reachable without it.'}
                    </p>
                  </div>
                  <Toggle
                    checked={settings.lanSharing}
                    disabled={!settings.killSwitch}
                    onChange={async (checked) => {
                      const updated = await window.api.settingsSet({ lanSharing: checked })
                      setSettings(updated)
                    }}
                  />
                </div>
```

- [ ] **Step 2: (No component change needed)**

`Toggle` already takes `disabled?: boolean` and applies `disabled:opacity-40` — verified at `src/renderer/components/Toggle.tsx:4,13,15`. Nothing to add; this step exists only so you don't go looking.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 4: Document the invariants**

In `CLAUDE.md`, in the "Reliability invariants (do not regress)" section, append a bullet:

```markdown
- **Local network sharing is a firewall exception, not a routing one.** No protocol's
  routing captures the LAN (wg-quick/awg-quick use `suppress_prefixlength 0`, OpenVPN
  emits `redirect-gateway def1`, tun2socks uses the `/1` halves — a LAN route is more
  specific than all of them), so the only thing that blocks it is the kill switch's
  DROP-all chain. `lanSharing` therefore adds ACCEPT rules and nothing else. **The
  ranges are hardcoded in the bash helper** (`LAN_RANGES_V4`/`_V6`) and only a boolean
  crosses the boundary — never accept a range from the app, and never wire
  `splitTunnelRoutes` (which is tun2socks-only routing, and accepts public CIDRs) into
  the firewall. Kill Switch and LAN Sharing now apply **live**: `SETTINGS_SET` runs
  `reapplyFirewall()` under `withConnectionLock`, and the pure `decideFirewallAction`
  keys off the **armed marker**, not the connection — which is what lets the user
  disarm the stand-down ("expired, traffic blocked") chain without a restart.
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Settings.tsx CLAUDE.md
git commit -m "Add the Local Network Sharing toggle and document the invariant"
```

- [ ] **Step 6: Live verification — the feature**

This needs a real tunnel and a real LAN box. Run the app (`env -u ELECTRON_RUN_AS_NODE npm run dev` — the VSCode shell leaks that variable), connect to a node, and with **Kill Switch on, Local Network Sharing off**:

1. `ssh <lan-box>` → must fail/time out (the current, pre-feature behaviour)
2. Toggle **Local Network Sharing on**. Without reconnecting: `ssh <lan-box>` → must succeed
3. `sudo iptables -S KATACOMB_KILLSWITCH` → the six `-d … -j ACCEPT` rules appear immediately above `-j DROP`
4. Toggle it back off → `sudo iptables -S KATACOMB_KILLSWITCH` shows them gone, and `ssh` to a *new* host fails again

- [ ] **Step 7: Live verification — no leak**

With LAN Sharing **on** and the tunnel up:

1. `curl https://ifconfig.me` → still the VPN's IP, not your ISP's
2. `sudo ip6tables -S KATACOMB_KILLSWITCH6` → `fe80::/10`, `fc00::/7`, `ff00::/8` above the DROP
3. `ping6 -c2 <lan-box-link-local>%<physical-nic>` → replies (this is the v6 half actually working, not just present in the ruleset). Find the address with `ip -6 neigh show dev <nic>`; skip this step only if the LAN box has no IPv6 at all, and say so in the report.
4. Confirm the exception did not widen: no ACCEPT rule in either chain names a public address other than the node endpoint

- [ ] **Step 8: Live verification — the live toggle**

Reproduce the three cases from the spec's "connect-time only" table, which must now all behave:

1. Connect with Kill Switch **off** → toggle it **on** → `sudo iptables -S KATACOMB_KILLSWITCH` shows the chain, and a public `curl` still works while a non-LAN direct connection is blocked
2. Connect with Kill Switch **on** → toggle it **off** → the chain is gone (`iptables -S KATACOMB_KILLSWITCH` errors with "No chain by that name")
3. Both directions leave the tunnel itself up and working

- [ ] **Step 9: Commit any fixes and report**

If steps 6-8 surfaced defects, fix them, re-run `npm run typecheck && npm test`, and commit. Report the actual observed output of each verification step — not "it should work".

---

## Notes for the implementer

- **The deb daemon is a separate binary.** If you are testing on an installed `.deb`, `src/main/daemon-core.ts` changes only take effect after `npm run build` + reinstall, because the daemon runs from `resources/daemon/index.js` outside the asar. Under `npm run dev` there is no daemon and everything goes through `pkexec`, so each toggle prompts for a password once — that is expected, not a bug.
- **`${RUN_DIR}/killswitch.state`** is written by `killswitch-on` and never read back anywhere in the tree. Pre-existing dead state — leave it alone; do not extend it with the LAN flag.
- A stale daemon paired with a new GUI silently ignores `lanSharing` and leaves the LAN blocked. Transient (the deb ships both and the postinst restarts the unit), and not worth a version negotiation.

---

## Outstanding: live verification (not run)

Everything above is implemented, reviewed and committed; unit tests, typecheck and
build are clean. **The live steps in Task 7 (6-9) have NOT been run** — they need
root, a paid on-chain session, and a second LAN machine. The final whole-branch
review sharpened that list; run this version:

1. **The bash actually emitting rules.** No unit test executes the helper.
   `sudo iptables -S KATACOMB_KILLSWITCH` — check the ACCEPTs sit **above** `-j DROP`,
   not merely that they exist.
2. **The routing premise, per protocol.** The ACCEPT is necessary but not sufficient:
   if a protocol's routing *did* capture the LAN, packets would enter the tunnel and
   the rule would do nothing. Run the `ssh <lan-box>` check on at least two protocol
   families — WireGuard/AmneziaWG (the `suppress_prefixlength 0` path) and
   V2Ray/XRAY/Hysteria2 (the tun2socks `/1` path). OpenVPN (`redirect-gateway def1`)
   is a third distinct path.
3. **The daemon half.** `npm run dev` exercises only `pkexec`. The daemon has its own
   copy of the argv builder and ships outside the asar, so `killswitch_on` +
   `lanSharing` is only exercised by an installed `.deb`. A daemon that didn't restart
   on upgrade ignores the field and leaves the LAN blocked **with no error**. Run the
   toggle once on the installed deb and confirm `systemctl status katacomb-vpn-daemon`
   is the new build.
4. **Whether a mid-session arm strangles the tunnel.** `reapplyFirewall`'s `'arm'` has
   no `assertTunnelCarriesTraffic()` after it, unlike the connect path — which runs one
   precisely because the kill switch can kill a tunnel. Only `checkTunnelStalled` would
   catch it, minutes later. After arming mid-session, watch the traffic-stats **rx**
   counter keep climbing for a minute; one successful `curl` is not enough.
5. **IPv6 reachability, not ruleset presence.** `ping6 fe80::…%<nic>` to a LAN
   neighbour. Neighbour discovery needs `ff00::/8` (solicited-node multicast) as much
   as `fe80::/10`, so a partial v6 arm looks like "rules present, ping still fails".
6. **A cancelled polkit prompt** (AppImage/dev only). Cancel one deliberately and
   confirm the warning badge reports the failure, and that the *next* toggle clears it.
7. **Whether the hardcoded ranges cover your network.** `100.64.0.0/10` (CGNAT,
   Tailscale) is deliberately absent — a LAN reached through such an address stays
   blocked. Only your own topology reveals this.

Known, accepted, not fixed: `killswitch-on` rebuilds the chain non-atomically (delete
jump → flush → re-add), so toggling LAN sharing **in the stand-down state**, where the
default route is back on the physical NIC, opens a few-millisecond unfiltered window.
Pre-existing mechanism, newly reachable; an atomic `iptables-restore` swap would be a
disproportionate rewrite.
