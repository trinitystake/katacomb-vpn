# Refactor-Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Act on the seven findings of the 2026-08-19 refactor-candidate report: kill the four-copy child-proxy bring-up drift, single-source the SOCKS listener constant, delete/unexport dead exports, unify the three cache modules, close the bash OpenVPN validator gap, and remove the `|| ''` guards that contradict the normalizeNodes contract.

**Architecture:** Behavior-preserving refactors inside the existing module layout. Two deliberate behavior changes only, both named by the spec: (a) the auto-reconnect spawn-failure error gains the same detail/hint as the connect branches; (b) the bash OpenVPN validator starts rejecting repeated directives, malformed arguments, and missing essentials, exactly as the TS guard already does. Everything else must diff as pure motion.

**Tech Stack:** Electron 41 main process (TypeScript, strict), Node 25 native test runner (`node --test`, import-free test-loaded modules), bash (polkit helper), React renderer.

**Spec:** `docs/superpowers/plans/2026-08-19-refactor-findings-spec.md` (a copy of `/home/neo/.claude/plans/analyse-this-codebase-for-clever-ullman.md`). The spec argues from file:line evidence gathered 2026-08-19; re-verify a line number before editing if the file has since changed.

## Global Constraints

- **Toolchain:** the shell's `node`/`npm` functions are broken (`_load_nvm` missing). In every shell first run: `export PATH="$HOME/.nvm/versions/node/v25.9.0/bin:$PATH"`. Then `npm test` and `npm run typecheck` work.
- **Gates after every task:** `npm test` (all pass, 0 fail) and `npm run typecheck` (no output = clean). Both were verified green at plan time.
- **Never `git push`.** All commits stay local (standing user instruction). Work on a branch, e.g. `refactor/report-findings`, branched from `main`.
- **Commit style:** plain declarative sentence, no `feat:`/`fix:` prefixes, no co-author trailers (settings enforce identity `trimorneo`). Match `git log --oneline -5`.
- **No em dashes in user-visible strings** (modal copy, buttons, error text). Code comments and commits are unaffected.
- **Surgical edits only:** do not reformat neighbours, do not touch `PROVISION_SOCKS_PORT = 1081` (`src/main/vpn-manager.ts:909`, deliberately different from 1080), do not merge `desiredProtocol` (intended) with `activeProtocol` (actual).
- **Native-runner constraint:** any module a `*.test.ts` file imports directly must not gain project-relative extensionless imports (the runner can't resolve them). Cross-file agreement is asserted in tests, which import with `.ts` extensions (the `error-markers.ts` pattern).
- **Task independence:** tasks map 1:1 to spec findings and are independently committable. Recommended order is as numbered (Tasks 1 and 2 touch the same region of `vpn-manager.ts`; Task 3 is the largest). Any task can be dropped without breaking the others.
- **Money paths:** `ipc-handlers.ts` has no unit tests. Task 3's safety comes from the gates plus a mandatory greppable self-review step; its real proof is the next live connect, which this plan does not perform (it spends on-chain funds).

---

### Task 1: Delete the dead `getSocksAddr` export (Finding 3)

**Files:**
- Modify: `src/main/vpn-manager.ts:106-109`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (pure deletion). Later tasks do not reference `getSocksAddr`.

- [ ] **Step 1: Confirm it is still dead**

Run: `grep -rnw getSocksAddr src scripts --include='*.ts' --include='*.tsx'`
Expected: exactly one hit, the definition at `src/main/vpn-manager.ts:107`. If any other hit appears, STOP and report (the spec's premise is stale).

- [ ] **Step 2: Delete the function and its doc comment**

Remove these four lines from `src/main/vpn-manager.ts` (the comment is factually false today, which is the finding):

```ts
/** Where the child proxies listen — shown to the user in local-proxy mode. */
export function getSocksAddr(): string {
  return SOCKS_ADDR
}
```

- [ ] **Step 3: Gates**

Run: `npm run typecheck && npm test`
Expected: both clean. Typecheck failing with "getSocksAddr is not exported" anywhere means Step 1 was wrong; restore and report.

- [ ] **Step 4: Commit**

```bash
git add src/main/vpn-manager.ts
git commit -m "Delete the dead getSocksAddr export"
```

---

### Task 2: Single-source the SOCKS listener port and address (Finding 2)

Four independent `SOCKS_PORT = 1080` consts and five renderer hardcodes of `127.0.0.1:1080` must agree today by hand. After this task: `src/shared/socks.ts` is the source of truth; `vpn-manager.ts` and the renderer import it; the three Electron-free builders keep inline copies whose emitted configs are asserted against the shared value in their existing tests (they cannot import it: their tests load them directly under the native runner).

**Files:**
- Create: `src/shared/socks.ts`
- Modify: `src/main/vpn-manager.ts:103-104`
- Modify: `src/main/xray-config.ts:110-111`, `src/main/hysteria-config.ts:38-39`, `src/main/multihop-config.ts:75-76` (comment only)
- Modify: `src/renderer/components/ConnectionModal.tsx:566,673`, `src/renderer/components/multihop/ChainReviewModal.tsx:481,686`, `src/renderer/components/StatusBar.tsx:28`
- Test: `src/main/xray-config.test.ts`, `src/main/hysteria-config.test.ts`, `src/main/multihop-config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const SOCKS_PORT: 1080` and `export const SOCKS_DISPLAY_ADDR: string` (value `'127.0.0.1:1080'`) from `src/shared/socks.ts`. Nothing later in this plan consumes them, but future code should.

- [ ] **Step 1: Write the failing cross-check assertions**

In `src/main/xray-config.test.ts`, add to the imports:

```ts
import { SOCKS_PORT } from '../shared/socks.ts'
```

and change the existing assertion at line 31 from `assert.equal(cfg.inbounds[0].port, 1080)` to:

```ts
  // Cross-check: the inlined port in xray-config.ts must match shared/socks.ts
  // (this module is import-free for the native runner, same as error-markers).
  assert.equal(cfg.inbounds[0].port, SOCKS_PORT)
```

In `src/main/hysteria-config.test.ts`, add the same import and change line 26 from `assert.equal(cfg.socks5.listen, '127.0.0.1:1080') // the SOCKS_ADDR tun2socks dials` to:

```ts
  // the SOCKS_ADDR tun2socks dials; cross-checked against shared/socks.ts
  assert.equal(cfg.socks5.listen, `127.0.0.1:${SOCKS_PORT}`)
```

In `src/main/multihop-config.test.ts`, add the same import and, in the test asserting the chained config's inbound (after the `assert.equal(inbounds[0].listen, '127.0.0.1')` near line 94), add:

```ts
  assert.equal(inbounds[0].port, SOCKS_PORT) // cross-check vs shared/socks.ts
```

(Do NOT touch the assertions near lines 461-462: port 1081 there is `buildEntryOnlyConfig`'s provisioning port, deliberately different.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, all three suites, with `Cannot find module '.../src/shared/socks.ts'`.

- [ ] **Step 3: Create the shared constant**

Create `src/shared/socks.ts`:

```ts
// Single source of truth for the child proxies' local SOCKS5 listener.
// vpn-manager (tun2socks dial + status socksAddr) and the renderer copy import
// these. The Electron-free config builders (xray-config, hysteria-config,
// multihop-config) inline the port so the native test runner can load them
// directly; their tests assert the emitted configs match these values (the
// same arrangement as connect-errors.ts vs error-markers.ts).
export const SOCKS_PORT = 1080
export const SOCKS_DISPLAY_ADDR = `127.0.0.1:${SOCKS_PORT}`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Point vpn-manager at the shared constant**

In `src/main/vpn-manager.ts`, add `import { SOCKS_PORT } from '../shared/socks'` to the imports, and replace lines 103-104:

```ts
const SOCKS_PORT = 1080
const SOCKS_ADDR = `127.0.0.1:${SOCKS_PORT}`
```

with:

```ts
const SOCKS_ADDR = `127.0.0.1:${SOCKS_PORT}`
```

- [ ] **Step 6: Annotate the three inlined copies**

In each of `src/main/xray-config.ts` (line 111), `src/main/hysteria-config.ts` (line 39), `src/main/multihop-config.ts` (line 76), replace the bare `const SOCKS_PORT = 1080` with:

```ts
// Inlined (not imported from shared/socks.ts) so the native test runner can
// load this module directly; the test asserts the built config matches it.
const SOCKS_PORT = 1080
```

- [ ] **Step 7: Replace the five renderer hardcodes**

`src/renderer/components/ConnectionModal.tsx`: add `import { SOCKS_DISPLAY_ADDR } from '../../shared/socks'`. Line 566, change the string to a template literal:

```tsx
                    : `Runs a SOCKS5 proxy on ${SOCKS_DISPLAY_ADDR}. No admin password, but only apps you point at it are tunneled. No kill switch.`}
```

Line 673:

```tsx
                SOCKS5 proxy at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only apps
```

`src/renderer/components/multihop/ChainReviewModal.tsx`: add `import { SOCKS_DISPLAY_ADDR } from '../../../shared/socks'`. Line 481:

```tsx
                    : `SOCKS5 on ${SOCKS_DISPLAY_ADDR}. Only apps you point at it use the chain, and there is no kill switch.`}
```

Line 686:

```tsx
                SOCKS5 at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only apps
```

`src/renderer/components/StatusBar.tsx`: add `import { SOCKS_DISPLAY_ADDR } from '../../shared/socks'`. Line 28:

```tsx
            <span className="text-text-secondary font-mono">SOCKS5 {status.socksAddr ?? SOCKS_DISPLAY_ADDR}</span>
```

(The `'127.0.0.1:1080'` inside the doc comment at `src/renderer/types/index.ts:213` is an example in a comment; leave it.)

- [ ] **Step 8: Gates + sweep**

Run: `npm run typecheck && npm test`
Expected: clean.
Run: `grep -rn "127.0.0.1:1080\|= 1080" src --include='*.ts' --include='*.tsx' | grep -v test | grep -v shared/socks`
Expected: only the three annotated builder inlines and the `types/index.ts` comment remain.

- [ ] **Step 9: Commit**

```bash
git add src/shared/socks.ts src/main/vpn-manager.ts src/main/xray-config.ts src/main/hysteria-config.ts src/main/multihop-config.ts src/main/xray-config.test.ts src/main/hysteria-config.test.ts src/main/multihop-config.test.ts src/renderer/components/ConnectionModal.tsx src/renderer/components/multihop/ChainReviewModal.tsx src/renderer/components/StatusBar.tsx
git commit -m "Single-source the SOCKS listener port and address"
```

---

### Task 3: Fold the four child-proxy bring-up copies and the seven-site connect tail into helpers (Finding 1)

The v2ray/xray/hysteria2 `CONNECTION_CONNECT` branches repeat ~50 lines each; the reconnect body carries a fourth, already-diverged copy; the `desiredProtocol`/`startRootTunnelMonitor`/`startQuotaWatchdog`/`sendStateChange` tail appears 7 times. This is the drift class that shipped two live billing/connect bugs. After this task the invariants are structural: one `finalizeTunnelConnect` ends every successful bring-up, one `assertProxyChildStarted` owns the spawn-wait-check.

**Sanctioned behavior change (from the spec):** the reconnect spawn failure, previously the bare `'Proxy failed to start on reconnect'`, now reports the same `getV2RayError()` detail and saved-config hint as the connect branches. Everything else must be motion only.

**Files:**
- Modify: `src/main/ipc-handlers.ts` (reconnect body ~1930-1978; branch tails ~3002-3007, ~3028-3033, ~3050-3055; child-proxy branches ~3058-3212; new helpers inserted after `attemptReconnect` ends, ~line 1985)
- Modify: `CLAUDE.md` (three sentences whose hand-counted site lists this task makes wrong)

**Interfaces:**
- Consumes: module-level names already in scope in `ipc-handlers.ts`: `desiredProtocol`, `desiredMode`, `startRootTunnelMonitor()`, `startQuotaWatchdog()`, `sendStateChange(state: string)`, `isProxyChildAlive()`, `getV2RayError()`, `bringUpV2RayTunnel()`, `disconnect()`, `applyPostConnectSettings(protocol)`, `assertTunnelCarriesTraffic()`.
- Produces (module-local, NOT exported — no external callers):
  - `type ConnectProtocol = 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'`
  - `function finalizeTunnelConnect(protocol: ConnectProtocol, mode: 'tunnel' | 'proxy'): void`
  - `async function assertProxyChildStarted(label: 'V2Ray' | 'Xray' | 'Hysteria2', fromSavedConfig: boolean): Promise<void>`
  - `async function finishChildProxyConnect(opts: { protocol: 'v2ray' | 'xray' | 'hysteria2'; label: 'V2Ray' | 'Xray' | 'Hysteria2'; proxyOnly: boolean; fromSavedConfig: boolean }): Promise<void>`

- [ ] **Step 1: Insert the helpers**

After the closing of `attemptReconnect` (currently line 1985), insert:

```ts
// ---- Shared bring-up helpers ----------------------------------------------

type ConnectProtocol = 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'

/**
 * The invariant tail of every successful bring-up: record intent
 * (desiredProtocol/desiredMode), start the root-tunnel monitor and the quota
 * watchdog, publish 'connected'. All six protocol branches, proxy mode and the
 * reconnect success path end here — funneling the tail through one function is
 * what enforces "every tunnel bring-up calls startQuotaWatchdog()" structurally
 * instead of by hand-counted call sites.
 */
function finalizeTunnelConnect(protocol: ConnectProtocol, mode: 'tunnel' | 'proxy'): void {
  desiredProtocol = protocol
  desiredMode = mode
  // Watches the interface for the root protocols and the default route for the
  // tun2socks ones; a no-op in proxy mode, which changes no routing.
  if (mode !== 'proxy') startRootTunnelMonitor()
  startQuotaWatchdog()
  sendStateChange('connected')
}

const CHILD_PROXY_STARTUP_MS = 1500
const SAVED_CONFIG_HINT =
  '\n\nThis node may have changed its configuration or gone offline since you last connected. Remove this session and subscribe again to pick a working node.'

/**
 * Wait out core startup and throw a detailed error if the child died. Every
 * spawn-wait site goes through here, and the predicate MUST stay
 * isProxyChildAlive() — pointed at the traffic predicate this fails every
 * tunnel-mode connect while the tun-up polkit dialog is open (see CLAUDE.md).
 */
async function assertProxyChildStarted(
  label: 'V2Ray' | 'Xray' | 'Hysteria2',
  fromSavedConfig: boolean,
): Promise<void> {
  await new Promise((r) => setTimeout(r, CHILD_PROXY_STARTUP_MS))
  if (isProxyChildAlive()) return
  const errMsg = getV2RayError()
  // When replaying a saved config (reconnect), a failure to start usually means
  // the node changed its configuration (e.g. switched protocols) or went
  // offline since the config was saved — point the user at the fix.
  const hint = fromSavedConfig ? SAVED_CONFIG_HINT : ''
  throw new Error(
    `${label} process exited immediately after starting.` + hint +
    (errMsg ? `\n\n${label} error:\n${errMsg.slice(0, 500)}` : '\n\nNo error output captured.')
  )
}

/**
 * Everything after the core has been spawned, shared by the v2ray/xray/
 * hysteria2 CONNECTION_CONNECT branches: verify the child survived startup,
 * then (tunnel mode only) bring up tun2socks + post-connect settings and prove
 * the tunnel carries traffic. In local-proxy mode there is no TUN and no
 * system state to change: the kill switch and dns-set are deliberately
 * skipped, so proxy mode leaks by design (only apps pointed at the SOCKS
 * address are tunneled) and the kill-switch setting is intentionally ignored.
 */
async function finishChildProxyConnect(opts: {
  protocol: 'v2ray' | 'xray' | 'hysteria2'
  label: 'V2Ray' | 'Xray' | 'Hysteria2'
  proxyOnly: boolean
  fromSavedConfig: boolean
}): Promise<void> {
  await assertProxyChildStarted(opts.label, opts.fromSavedConfig)
  if (!opts.proxyOnly) {
    // The core is running — bring up the TUN interface. If this fails the
    // child is still running, so tear it down rather than orphan a SOCKS proxy.
    try {
      await bringUpV2RayTunnel()
    } catch (err) {
      await disconnect()
      throw err
    }
    await applyPostConnectSettings(opts.protocol)
    await assertTunnelCarriesTraffic()
  }
  finalizeTunnelConnect(opts.protocol, opts.proxyOnly ? 'proxy' : 'tunnel')
}
```

- [ ] **Step 2: Convert the three root-protocol tails**

In the `CONNECTION_CONNECT` handler, replace the WireGuard tail (currently lines 3002-3007):

```ts
        desiredProtocol = 'wireguard'
        desiredMode = 'tunnel'
        startRootTunnelMonitor()
        startQuotaWatchdog()
        sendStateChange('connected')
        return { protocol: 'wireguard' }
```

with:

```ts
        finalizeTunnelConnect('wireguard', 'tunnel')
        return { protocol: 'wireguard' }
```

Do the same for the `amneziawg` tail (lines 3028-3033) and the `openvpn` tail (lines 3050-3055), substituting the protocol literal. Keep the branches' preceding `applyPostConnectSettings(...)` / `assertTunnelCarriesTraffic()` lines exactly where they are.

- [ ] **Step 3: Convert the three child-proxy branches**

Replace the whole v2ray branch (currently lines 3058-3114) with:

```ts
      if (params.protocol === 'v2ray') {
        // Resolve the DoH resolver up front so it's injected into the v2ray config
        // (same value applyPostConnectSettings uses for resolv.conf + kill switch).
        const dohIp = effectiveV2RayResolverIp(loadSettings())
        if (activeV2ray) {
          connectV2Ray(activeV2ray, dohIp, { proxyOnly })
        } else if (params.configString) {
          connectV2RayFromConfig(params.configString, dohIp, { proxyOnly })
        } else {
          throw new Error('No V2Ray instance or config available')
        }
        await finishChildProxyConnect({
          protocol: 'v2ray', label: 'V2Ray', proxyOnly,
          fromSavedConfig: !activeV2ray && !!params.configString,
        })
        return { protocol: 'v2ray' }
      }
```

Replace the xray branch (lines 3116-3163) with:

```ts
      if (params.protocol === 'xray') {
        // Xray reuses the v2ray tunnel path (child process + tun2socks). The config
        // is the one built during the handshake (activeXrayConfig), or a saved
        // config on manual reconnect (params.configString).
        const dohIp = effectiveV2RayResolverIp(loadSettings())
        const xrayConfig = params.configString ?? activeXrayConfig
        if (!xrayConfig) {
          throw new Error('No Xray config available')
        }
        connectXRayFromConfig(xrayConfig, dohIp, { proxyOnly })
        await finishChildProxyConnect({
          protocol: 'xray', label: 'Xray', proxyOnly,
          fromSavedConfig: !activeXrayConfig && !!params.configString,
        })
        return { protocol: 'xray' }
      }
```

Replace the hysteria2 branch (lines 3165-3212) with:

```ts
      if (params.protocol === 'hysteria2') {
        // Hysteria2 reuses the v2ray tunnel path (child process + tun2socks). The
        // config is the one built during the handshake (activeHysteria2Config), or
        // a saved config on manual reconnect (params.configString). No DoH —
        // hysteria2's DNS is plaintext-through-tunnel (see connectHysteria2FromConfig).
        const hysteria2Config = params.configString ?? activeHysteria2Config
        if (!hysteria2Config) {
          throw new Error('No Hysteria2 config available')
        }
        connectHysteria2FromConfig(hysteria2Config, { proxyOnly })
        await finishChildProxyConnect({
          protocol: 'hysteria2', label: 'Hysteria2', proxyOnly,
          fromSavedConfig: !activeHysteria2Config && !!params.configString,
        })
        return { protocol: 'hysteria2' }
      }
```

Note what is deliberately preserved: the spawn calls stay un-awaited; `fromSavedConfig` keeps each branch's exact existing expression; the `throw new Error('No active VPN instance')` fallthrough and the `.finally(notifyTraySettled)` stay untouched.

- [ ] **Step 4: Convert the reconnect body**

In the reconnect timer body, replace (currently lines 1944-1948):

```ts
          await new Promise((r) => setTimeout(r, 1500))
          if (!isProxyChildAlive()) {
            throw new Error('Proxy failed to start on reconnect')
          }
          if (!proxyOnly) await bringUpV2RayTunnel()
```

with:

```ts
          // A reconnect replays a saved config, so the detailed failure + the
          // "node may have changed configuration" hint apply here too (this
          // used to say only 'Proxy failed to start on reconnect').
          await assertProxyChildStarted(
            saved.protocol === 'hysteria2' ? 'Hysteria2' : saved.protocol === 'xray' ? 'Xray' : 'V2Ray',
            true,
          )
          if (!proxyOnly) await bringUpV2RayTunnel()
```

Then replace the reconnect success tail (currently lines 1970-1978):

```ts
        desiredProtocol = saved.protocol as 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'
        // Unconditional now: the monitor watches the interface for the root protocols
        // and the default route for the tun2socks ones, and self-gates on proxy mode.
        if (desiredMode !== 'proxy') startRootTunnelMonitor()
        startQuotaWatchdog()

        console.log('[reconnect] Success')
        reconnectAttempt = 0
        sendStateChange('connected')
```

with:

```ts
        console.log('[reconnect] Success')
        reconnectAttempt = 0
        // desiredMode is replayed, not overwritten: passing it back through
        // keeps a proxy-mode session in proxy mode.
        finalizeTunnelConnect(saved.protocol as ConnectProtocol, desiredMode)
```

Do NOT move the epoch check (`if (connectionEpoch !== myEpoch)`) or the reconnect body's own `applyPostConnectSettings` + `assertTunnelCarriesTraffic` block: on reconnect those cover ALL protocols and must stay between bring-up and the tail. The reconnect body deliberately does not use `finishChildProxyConnect`.

- [ ] **Step 5: Gates**

Run: `npm run typecheck && npm test`
Expected: clean. (`ipc-handlers.ts` has no unit tests; the suite guards everything it touches indirectly.)

- [ ] **Step 6: Structural self-review (mandatory, greppable)**

Run and eyeball each:

```bash
grep -n "startQuotaWatchdog()" src/main/ipc-handlers.ts
# Expected: exactly ONE call site, inside finalizeTunnelConnect (plus the function's own definition).
grep -n "sendStateChange('connected')" src/main/ipc-handlers.ts
# Expected: exactly TWO — the quota-warning re-poll nudge inside startQuotaWatchdog's
# loop (currently line 598; not a bring-up, it stays) and finalizeTunnelConnect.
grep -n "isProxyChildAlive()" src/main/ipc-handlers.ts
# Expected: exactly ONE, inside assertProxyChildStarted.
grep -n "assertTunnelCarriesTraffic()" src/main/ipc-handlers.ts
# Expected: FIVE calls — wireguard, amneziawg, openvpn branches, finishChildProxyConnect, reconnect body.
grep -n "desiredProtocol =" src/main/ipc-handlers.ts
# Expected: finalizeTunnelConnect plus only the pre-existing non-connect writers (e.g. disconnect/stand-down resets).
```

Any deviation means a copy was missed; fix before committing.

- [ ] **Step 7: Update CLAUDE.md's hand-counted invariant language (same commit)**

Three sentences now name counts this task made wrong. In `CLAUDE.md`:

1. Replace: `Every tunnel bring-up calls \`startQuotaWatchdog()\` (all six protocols + proxy mode + the reconnect success path — 7 sites); it scores` with: `Every successful bring-up funnels through \`finalizeTunnelConnect()\` (ipc-handlers.ts), which calls \`startQuotaWatchdog()\` — all six protocols, proxy mode and the reconnect success path end there; it scores`

2. Replace: `**And the four sites that spawn the core, wait 1500 ms and ask whether it survived** (the reconnect body plus the v2ray/xray/hysteria2 connect branches) MUST use \`isProxyChildAlive()\` — pointed at the traffic predicate they fail *every* tunnel-mode connect` with: `**And the one helper that spawns-waits-and-asks whether the core survived** (\`assertProxyChildStarted\`, reached from the reconnect body and, via \`finishChildProxyConnect\`, the v2ray/xray/hysteria2 connect branches) MUST use \`isProxyChildAlive()\` — pointed at the traffic predicate it fails *every* tunnel-mode connect`

3. Replace: `\`assertTunnelCarriesTraffic()\` after **every** bring-up (6 protocol branches + the auto-reconnect body; skipped in proxy mode, which changes no routing)` with: `\`assertTunnelCarriesTraffic()\` after **every** bring-up (the WG/AWG/OpenVPN branches, \`finishChildProxyConnect\` for the three child-proxy protocols, and the auto-reconnect body; skipped in proxy mode, which changes no routing)`

- [ ] **Step 8: Optional boot smoke**

If a display is available: `env -u ELECTRON_RUN_AS_NODE npm run dev` (the VSCode shell leaks that variable), confirm the app opens and the Nodes tab loads, then quit. No connect (spends funds).

- [ ] **Step 9: Commit**

```bash
git add src/main/ipc-handlers.ts CLAUDE.md
git commit -m "Fold the four child-proxy bring-up copies and the shared connect tail into helpers"
```

---

### Task 4: One disk-cache implementation behind the three cache modules (Finding 4)

`plan-cache.ts` / `provider-cache.ts` / `nodes-cache.ts` are the same load/shape-check/atomic-save pattern three times, with comments already diverged. Extract the pattern; keep each module's public API and its on-disk JSON shape byte-compatible (the field names `plans`/`providers`/`nodes` are part of the format on users' disks).

**Files:**
- Create: `src/main/disk-cache.ts`
- Modify: `src/main/plan-cache.ts`, `src/main/provider-cache.ts`, `src/main/nodes-cache.ts` (public exports unchanged)

**Interfaces:**
- Consumes: `writeFileAtomic` from `./fs-utils` (existing).
- Produces: `makeDiskCache<T>(fileName: string, field: string): { load(): { items: T[]; fetchedAt: number } | null; save(items: T[], fetchedAt: number): void }` — module-internal to the three cache files; not consumed elsewhere in this plan.
- Unchanged public APIs callers rely on: `getCachedPlans()`, `setCachedPlans()`, `CachedPlan`; `getCachedProviders()`, `isCacheFresh()`, `setCachedProviders()`; `loadNodesCache()`, `saveNodesCache()`, `NodesCacheFile`.

- [ ] **Step 1: Create the factory**

`src/main/disk-cache.ts` (imports `electron`, so it cannot be loaded by the native test runner; correctness is carried by the unchanged wrappers plus the gates):

```ts
// The one place the userData JSON-cache pattern lives: read + shape-check on
// load (null on any failure — a corrupt or missing cache is just a cold
// start), atomic best-effort write on save. plan-cache, provider-cache and
// nodes-cache are thin wrappers over this.
import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './fs-utils'

/**
 * A JSON array cache at `userData/<fileName>` with the on-disk shape
 * `{ [field]: T[], fetchedAt: number }`. `field` is part of the existing
 * on-disk format ('plans' / 'providers' / 'nodes') — keep it stable, or every
 * user's cache silently cold-starts on upgrade.
 */
export function makeDiskCache<T>(fileName: string, field: string) {
  const cachePath = () => join(app.getPath('userData'), fileName)
  return {
    load(): { items: T[]; fetchedAt: number } | null {
      const path = cachePath()
      if (!existsSync(path)) return null
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
        const items = parsed?.[field]
        const fetchedAt = parsed?.fetchedAt
        if (!Array.isArray(items) || typeof fetchedAt !== 'number') return null
        return { items: items as T[], fetchedAt }
      } catch {
        return null
      }
    },
    save(items: T[], fetchedAt: number): void {
      try {
        writeFileAtomic(cachePath(), JSON.stringify({ [field]: items, fetchedAt }))
      } catch {
        // best-effort: disk full / permission errors must not break the app
      }
    },
  }
}
```

- [ ] **Step 2: Rewrite the three wrappers**

`src/main/plan-cache.ts` becomes (keep the `CachedPlan` interface exactly as it is today):

```ts
import { makeDiskCache } from './disk-cache'

export interface CachedPlan {
  id: string
  provAddress: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
}

const cache = makeDiskCache<CachedPlan>('plan-cache.json', 'plans')
let memCache: { plans: CachedPlan[]; fetchedAt: number } | null = null

export function getCachedPlans(): { plans: CachedPlan[]; fetchedAt: number | null } {
  if (!memCache) {
    const disk = cache.load()
    if (disk) memCache = { plans: disk.items, fetchedAt: disk.fetchedAt }
  }
  if (!memCache) return { plans: [], fetchedAt: null }
  return { plans: memCache.plans, fetchedAt: memCache.fetchedAt }
}

export function setCachedPlans(plans: CachedPlan[]): void {
  memCache = { plans, fetchedAt: Date.now() }
  cache.save(memCache.plans, memCache.fetchedAt)
}
```

`src/main/provider-cache.ts` becomes:

```ts
import { makeDiskCache } from './disk-cache'
import type { ProviderInfo } from './provider-service'

const TTL_MS = 60 * 60 * 1000

const cache = makeDiskCache<ProviderInfo>('provider-cache.json', 'providers')
let memCache: { providers: ProviderInfo[]; fetchedAt: number } | null = null

function loadIfNeeded(): void {
  if (memCache) return
  const disk = cache.load()
  if (disk) memCache = { providers: disk.items, fetchedAt: disk.fetchedAt }
}

export function getCachedProviders(): { providers: ProviderInfo[]; fetchedAt: number | null } {
  loadIfNeeded()
  if (!memCache) return { providers: [], fetchedAt: null }
  return { providers: memCache.providers, fetchedAt: memCache.fetchedAt }
}

export function isCacheFresh(): boolean {
  loadIfNeeded()
  if (!memCache) return false
  return Date.now() - memCache.fetchedAt < TTL_MS
}

export function setCachedProviders(providers: ProviderInfo[]): void {
  memCache = { providers, fetchedAt: Date.now() }
  cache.save(memCache.providers, memCache.fetchedAt)
}
```

`src/main/nodes-cache.ts` becomes (it keeps having no memory cache, deliberately — `ipc-handlers` holds its own `nodesMemoryCache`):

```ts
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
```

- [ ] **Step 3: Gates + on-disk-shape check**

Run: `npm run typecheck && npm test`
Expected: clean.
Run: `grep -n "'plans'\|'providers'\|'nodes'" src/main/plan-cache.ts src/main/provider-cache.ts src/main/nodes-cache.ts`
Expected: each file passes its historical field name to `makeDiskCache` — the on-disk JSON key must not change.

- [ ] **Step 4: Commit**

```bash
git add src/main/disk-cache.ts src/main/plan-cache.ts src/main/provider-cache.ts src/main/nodes-cache.ts
git commit -m "Put one disk-cache implementation behind the three cache modules"
```

---

### Task 5: Bring the bash OpenVPN validator up to the TS guard it mirrors (Finding 5)

`validate_openvpn_config` in the polkit helper checks directive names only; `assertSafeOpenVpnConfig` (`config-guard.ts:567`) also rejects repeated directives (a second `remote` escapes the kill-switch whitelist), malformed arguments, and missing essentials. The bash layer is the last line of defense when the helper is invoked directly via pkexec, so it must actually mirror. This task only ever REJECTS MORE, never less, and every app flow still runs the TS guard first, which bounds the risk.

**Files:**
- Modify: `resources/linux/katacomb-vpn-helper.sh:177-228` (`validate_openvpn_config`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing new; the function keeps its name, argument (`$1` = config path) and exit-1-with-`Error:`-on-stderr contract.

- [ ] **Step 1: Extend the function**

In `validate_openvpn_config`, make three changes:

(a) extend the locals: `local line directive lc_dir value block="" tag` and `local -A seen_block=() seen_dir=()`.

(b) after the existing directive allow-list `case` block (the one ending `*) echo "Error: OpenVPN directive '$lc_dir' is not allowed" >&2; exit 1 ;;` / `esac`), insert:

```bash
    # A repeated directive is rejected even when each copy is well-formed: e.g.
    # a second `remote` (failover) that the kill switch wouldn't whitelist.
    if [[ -n "${seen_dir[$lc_dir]:-}" ]]; then
      echo "Error: OpenVPN directive '$lc_dir' is repeated" >&2; exit 1
    fi
    seen_dir[$lc_dir]=1
    value="${line#"$directive"}"
    value="${value#"${value%%[![:space:]]*}"}"
    # Argument grammar mirrors OVPN_DIRECTIVES in config-guard.ts, directive
    # for directive — keep the two tables in step.
    case "$lc_dir" in
      client|nobind|auth-nocache|tls-client|persist-key|persist-tun) [[ -z "$value" ]] ;;
      dev) [[ "$value" == "sntl-ovpn" ]] ;;
      dev-type) [[ "$value" == "tun" ]] ;;
      proto) [[ "$value" =~ ^(tcp|udp)$ ]] ;;
      remote) [[ "$value" =~ ^\[?[A-Za-z0-9.:_-]+\]?[[:blank:]]+[0-9]{1,5}$ ]] ;;
      auth) [[ "$value" =~ ^[A-Za-z0-9-]{1,32}$ ]] ;;
      data-ciphers|tls-cipher) [[ "$value" =~ ^[A-Za-z0-9:-]{1,128}$ ]] ;;
      data-ciphers-fallback) [[ "$value" =~ ^[A-Za-z0-9-]{1,64}$ ]] ;;
      tls-version-min) [[ "$value" =~ ^1\.[23]$ ]] ;;
      remote-cert-tls) [[ "$value" == "server" ]] ;;
      redirect-gateway) [[ "$value" =~ ^[A-Za-z0-9[:blank:]-]{0,64}$ ]] ;;
      topology) [[ "$value" == "subnet" ]] ;;
      explicit-exit-notify) [[ "$value" =~ ^[1-3]$ ]] ;;
    esac || { echo "Error: OpenVPN directive '$lc_dir' has a malformed value" >&2; exit 1; }
```

(c) after the existing required-blocks loop (`for tag in ca cert key tls-crypt; do ... done`), append:

```bash
  # Same essentials assertSafeOpenVpnConfig requires (OVPN_REQUIRED): without
  # these the tunnel is not a client tunnel pointed at exactly one endpoint.
  for lc_dir in client dev proto remote; do
    if [[ -z "${seen_dir[$lc_dir]:-}" ]]; then
      echo "Error: OpenVPN directive '$lc_dir' is missing" >&2; exit 1
    fi
  done
```

- [ ] **Step 2: Syntax gate**

Run: `bash -n resources/linux/katacomb-vpn-helper.sh`
Expected: no output.

- [ ] **Step 3: Build the parity harness in the scratchpad**

Fixtures (write to the session scratchpad, `$SP` below). `good.ovpn` must pass BOTH validators:

```
client
dev sntl-ovpn
dev-type tun
proto tcp
remote 203.0.113.7 443
nobind
remote-cert-tls server
tls-version-min 1.2
<ca>
-----BEGIN CERTIFICATE-----
QUFBQQ==
-----END CERTIFICATE-----
</ca>
<cert>
-----BEGIN CERTIFICATE-----
QUFBQQ==
-----END CERTIFICATE-----
</cert>
<key>
-----BEGIN PRIVATE KEY-----
QUFBQQ==
-----END PRIVATE KEY-----
</key>
<tls-crypt>
-----BEGIN OpenVPN Static key V1-----
QUFBQQ==
-----END OpenVPN Static key V1-----
</tls-crypt>
```

Bad fixtures, each derived from `good.ovpn` by one mutation, all of which the TS guard already rejects and the bash validator must now also reject:
- `bad-repeat.ovpn`: add a second line `remote 198.51.100.9 1194`
- `bad-dev.ovpn`: change `dev sntl-ovpn` to `dev tun0`
- `bad-arg.ovpn`: change `proto tcp` to `proto tcp-client`
- `bad-missing.ovpn`: delete the `remote 203.0.113.7 443` line

Extract the function and run it against each (the function `exit 1`s, so each run gets its own subshell):

```bash
sed -n '/^validate_openvpn_config()/,/^}$/p' resources/linux/katacomb-vpn-helper.sh > "$SP/vfun.sh"
for f in good bad-repeat bad-dev bad-arg bad-missing; do
  if bash -c "source '$SP/vfun.sh'; validate_openvpn_config '$SP/$f.ovpn'" 2>"$SP/$f.err"; then
    echo "$f: ACCEPT"
  else
    echo "$f: REJECT ($(cat "$SP/$f.err"))"
  fi
done
```

Expected: `good: ACCEPT`; all four `bad-*: REJECT` with the matching `Error:` message.

- [ ] **Step 4: Assert TS-guard parity on the same fixtures**

The point of the task is agreement, so run the TS guard over the identical files (config-guard.ts is import-free, so Node 25 loads it directly):

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const { assertSafeOpenVpnConfig } = await import(pathToFileURL('src/main/config-guard.ts'))
for (const f of ['good', 'bad-repeat', 'bad-dev', 'bad-arg', 'bad-missing']) {
  try {
    assertSafeOpenVpnConfig(readFileSync(process.env.SP + '/' + f + '.ovpn', 'utf-8'))
    console.log(f + ': ACCEPT')
  } catch (e) { console.log(f + ': REJECT (' + e.message + ')') }
}"
```

Expected: the same five verdicts as Step 3. Any fixture where the two validators disagree is a bug in the new bash — fix the bash, never loosen the TS.

- [ ] **Step 5: Gates**

Run: `npm run typecheck && npm test`
Expected: clean (nothing TS changed; this is a regression tripwire only).

Note for the record: the changed helper ships inside the deb via `postinstall.sh`. This change is pure validation tightening on a path the TS guard already covers in every app flow; the full `scripts/verify-deb-portability.sh` cycle is NOT triggered by it, but the next live OpenVPN connect (money-spending, out of scope here) is the true end-to-end proof.

- [ ] **Step 6: Commit**

```bash
git add resources/linux/katacomb-vpn-helper.sh
git commit -m "Validate OpenVPN directive arguments, repeats and essentials in the bash mirror too"
```

---

### Task 6: Drop the `|| ''` guards that contradict the normalizeNodes contract (Finding 6)

`normalizeNodes()` runs on every feed entry point, so `SentNode.country/city/moniker` are real strings downstream. Five leftover guards predate that contract and make it unverifiable by reading the code; worse, they'd make sorting silently cope while other components white-screen if an un-normalized entry point ever appeared, splitting symptom from cause.

**Files:**
- Modify: `src/renderer/hooks/useNodes.ts:39,42,45,144`
- Modify: `src/renderer/utils/chain-diversity.ts:115`
- Test: `src/renderer/utils/chain-diversity.test.ts` (no edits expected; its `node()` fixture always supplies `country`)

**Interfaces:**
- Consumes: the `normalizeNodes()` contract (already enforced at both feed entry points, `ipc-handlers.ts:2003,2027`).
- Produces: nothing new.

- [ ] **Step 1: Edit the five sites**

`src/renderer/hooks/useNodes.ts` line 39: `cmp = (a.country || '').localeCompare(b.country || '')` becomes:

```ts
      cmp = a.country.localeCompare(b.country)
```

Line 42: `cmp = (a.city || '').localeCompare(b.city || '')` becomes:

```ts
      cmp = a.city.localeCompare(b.city)
```

Line 45: `cmp = (a.moniker || '').localeCompare(b.moniker || '')` becomes:

```ts
      cmp = a.moniker.localeCompare(b.moniker)
```

Line 144: `nodes = nodes.filter((n) => (n.moniker || '').toLowerCase().includes(q))` becomes:

```ts
      nodes = nodes.filter((n) => n.moniker.toLowerCase().includes(q))
```

`src/renderer/utils/chain-diversity.ts` line 115: `const country = (n: SentNode) => (n.country || '').trim()` becomes:

```ts
  const country = (n: SentNode) => n.country.trim()
```

(Do NOT touch `ipc-handlers.ts:2007`'s `n.moniker || ''` — that site reads RAW pre-normalize aggregator objects typed `unknown`, not `SentNode`, and is upstream of the contract.)

- [ ] **Step 2: Gates**

Run: `npm run typecheck && npm test`
Expected: clean. If a chain-diversity test fails, fix the FIXTURE by supplying the string field; never re-add a guard.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useNodes.ts src/renderer/utils/chain-diversity.ts
git commit -m "Drop the leftover || '' guards the normalizeNodes contract forbids"
```

---

### Task 7: Unexport internal-only symbols (Finding 7)

Eighteen symbols carry `export` with zero importers (production or test). Dead exports are the repo's own named antipattern ("unexport the moment they go unused"). The `export` keyword is the dead part; every symbol stays, unexported.

**Files (one edit each — remove the leading `export ` from the declaration):**
- `src/main/binary-integrity.ts:9` — `BUNDLED_HASHES`
- `src/main/daemon-core.ts:107` — `defaultDeps`
- `src/main/node-tester.ts:246` — `probeBatch`
- `src/main/provider-console.ts:195` — `getSubscriptionStakingShare`
- `src/main/kill-switch.ts:15` — `markKillSwitchArmed`
- `src/main/kill-switch.ts:25` — `clearKillSwitchArmed`
- `src/main/chain-service.ts` — `saveSessionConfig`
- `src/main/rpc-monitor.ts` — `probeRpc`, `refreshRpcHealth`
- `src/main/multihop-config.ts:73` — `SOCKS_TAG`
- `src/main/provider-msgs.ts` — `PLAN_DENOM`, `MsgEndLeaseTypeUrl`
- `src/shared/rpc-health.ts:43,46` — `SLOW_LATENCY_MS`, `EXPECTED_CHAIN_ID`
- `src/shared/funds.ts` — `UDVPN_PER_P2P`
- `src/renderer/utils/country-normalization.ts:5` — `POLY_TO_PIN`
- `src/renderer/utils/chain-node.ts:17` — `CHAINABLE_TYPES`
- `src/renderer/components/provider/ProviderPlans.tsx:37` — `p2pToUdvpn`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (visibility narrowing only).

- [ ] **Step 1: Re-verify each symbol is import-free, INCLUDING by tests**

Several of these files are native-runner-tested (`multihop-config`, `provider-msgs`, `rpc-health`, `funds`, `chain-node`, `daemon-core`), and a symbol exported solely for a test IS the repo's deliberate pattern and must keep its export. So gate each edit:

```bash
for s in BUNDLED_HASHES defaultDeps probeBatch getSubscriptionStakingShare \
         markKillSwitchArmed clearKillSwitchArmed saveSessionConfig probeRpc \
         refreshRpcHealth SOCKS_TAG PLAN_DENOM MsgEndLeaseTypeUrl \
         SLOW_LATENCY_MS EXPECTED_CHAIN_ID UDVPN_PER_P2P POLY_TO_PIN \
         CHAINABLE_TYPES p2pToUdvpn; do
  echo "== $s"
  grep -rnw "$s" src scripts --include='*.ts' --include='*.tsx'
done
```

Expected per symbol: hits only inside its defining file. If ANY symbol shows a hit in another file (test files included), SKIP that symbol and list it in the commit message body as "kept exported: <reason>". Note Task 2 added `SOCKS_PORT` test imports — that is a different symbol; `SOCKS_TAG` must show no test hits of its own.

- [ ] **Step 2: Remove `export ` from each verified declaration**

Example shape (repeat per symbol):

```ts
// before
export const SOCKS_TAG = 'socks'
// after
const SOCKS_TAG = 'socks'
```

For `export function` declarations (`probeBatch`, `getSubscriptionStakingShare`, `markKillSwitchArmed`, `clearKillSwitchArmed`, `saveSessionConfig`, `probeRpc`, `refreshRpcHealth`, `p2pToUdvpn`), remove only the `export ` keyword; leave signatures and bodies untouched.

- [ ] **Step 3: Gates**

Run: `npm run typecheck && npm test`
Expected: clean. `noUnusedLocals` failing on a just-unexported symbol means it was not used in-file after all; that symbol is genuinely dead code — restore the export, skip it, and note it in the commit body for a separate decision (deletion is a different change than visibility).

- [ ] **Step 4: Commit**

```bash
git add -A src
git commit -m "Unexport internal-only symbols"
```

---

## Post-plan notes for the executor

- The findings report (the spec) also contains a compliance sweep asserting many CLAUDE.md invariants held at analysis time. Task 3 changes what three of those sentences count; no other task touches any policed invariant.
- Per the project docs policy, this plan and the spec copy are deleted once the work ships (invariants live in CLAUDE.md, git history is the archive).
- Left deliberately undone (out of scope, spec-consistent): TOFU pinning, any live connect verification, deletion of the genuinely-dead-code candidates Step 3 of Task 7 might surface.
