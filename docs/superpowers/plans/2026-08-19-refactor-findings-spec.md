# Refactor-candidate report (analysis only, no changes)

## Context

Requested: analyse the codebase for refactor candidates, report only, change nothing.
A candidate qualifies only with file:line evidence and a named breakage (actual or
plausible today). Every documented "all N sites must do X" invariant in CLAUDE.md was
verified against the code; the compliance sweep is at the bottom. Ranked findings
first, strongest evidence first.

---

## Finding 1 — The child-proxy connect branches are 3 near-verbatim ~50-line copies, plus a 4th divergent copy in the reconnect body

**Category:** rule-of-three duplication, with two documented shipped bugs in exactly this drift class.

**Evidence:**
- v2ray branch: `src/main/ipc-handlers.ts:3058-3114`
- xray branch: `src/main/ipc-handlers.ts:3116-3163`
- hysteria2 branch: `src/main/ipc-handlers.ts:3165-3212`
- 4th copy (reconnect body): `src/main/ipc-handlers.ts:1923-1950`

Each of the three branches repeats, in order: pick config → spawn → `setTimeout 1500`
→ `isProxyChildAlive()` → build a failure message → `bringUpV2RayTunnel()` in a
try/catch that calls `disconnect()` → `applyPostConnectSettings` →
`assertTunnelCarriesTraffic` → the shared tail (`desiredProtocol`/`desiredMode`/
`startRootTunnelMonitor`/`startQuotaWatchdog`/`sendStateChange`). The 9-line user-facing
hint string ("This node may have changed its configuration or gone offline…") is
verbatim-identical three times: `ipc-handlers.ts:3078-3080`, `3132-3134`, `3181-3183`.
The shared tail additionally appears in the WG (`3002-3007`), AWG (`3028-3033`) and
OpenVPN (`3050-3055`) branches and the reconnect success path (`1972-1982`) — 7 copies.

**Already diverged:** the reconnect copy checks the same spawn the same way but reports
only `'Proxy failed to start on reconnect'` (`ipc-handlers.ts:1946`) with none of the
`getV2RayError()` detail the other three attach.

**What breaks:** this is the exact drift class that has shipped twice, per CLAUDE.md's
own history: the quota watchdog missing from the auto-reconnect-off abort path (billed
wall-clock against dead tunnels), and the four spawn-check sites once pointing at the
wrong predicate (failing every tunnel-mode connect). CLAUDE.md polices it by hand with
site-count lists ("7 sites", "the four sites", "6 protocol branches") that must be
re-counted on every change; the next protocol or edit adds another copy to keep in sync
manually. All counts verified compliant **today** — the finding is the standing cost and
recurrence risk, evidenced by two prior live failures.

---

## Finding 2 — `SOCKS_PORT = 1080` is hand-agreed across 4 independent consts plus 5 renderer hardcodes, with no cross-check

**Category:** hand-enforced cross-file invariant / rule-of-three duplication.

**Evidence — four independent definitions that must agree:**
- `src/main/vpn-manager.ts:103` (`SOCKS_ADDR` handed to tun2socks, and the status
  `socksAddr` at `vpn-manager.ts:1152`)
- `src/main/xray-config.ts:111` (port the xray config listens on)
- `src/main/hysteria-config.ts:39` (port the hysteria2 config listens on)
- `src/main/multihop-config.ts:76` (port a chained config listens on)

**Plus five renderer hardcodes of `127.0.0.1:1080` in user-facing copy:**
`src/renderer/components/ConnectionModal.tsx:566`, `:673`,
`src/renderer/components/multihop/ChainReviewModal.tsx:481`, `:686`, and the fallback in
`src/renderer/components/StatusBar.tsx:28`.

**What breaks:** tun2socks dials `vpn-manager`'s copy while each builder emits its own;
change any one and that protocol's tunnel-mode bring-up fails (tun2socks pointed at a
dead port), or the modals tell the user a proxy address that is no longer real. Nothing
asserts the four agree — no shared constant, no test. The repo already has the
established pattern for exactly this constraint (Electron-free modules that must inline
a value get a test asserting it matches the shared source: `connect-errors.ts` /
`wallet-errors.ts` vs `shared/error-markers.ts`). Related: `vpn-manager.ts:909`'s
`PROVISION_SOCKS_PORT = 1081` is deliberately different and its comment identifies 1080
as "the live listener" — a fifth site that knows the number.

---

## Finding 3 — `getSocksAddr` is a fully dead export with a false doc comment

**Category:** exported helper with no remaining callers (the repo's own named antipattern).

**Evidence:** `src/main/vpn-manager.ts:107-109`. Project-wide word search (src, scripts,
tests): zero callers, zero mentions outside its definition. It was superseded by the
inline `socksAddr: SOCKS_ADDR` in `getConnectionStatus()` (`vpn-manager.ts:1152`) and by
`getActiveProxyPort()` (`vpn-manager.ts:1210-1214`).

**What breaks:** its doc comment — "shown to the user in local-proxy mode" — is false
today (the UI hardcodes the string, see Finding 2), so the comment actively misleads.
CLAUDE.md: "dead exports drift over time and get imported by mistake. Unexport (or
delete) the moment they go unused." This is the only fully dead export found.

---

## Finding 4 — Three cache modules are near-identical and have already diverged

**Category:** rule-of-three duplication, copies diverged.

**Evidence:** `src/main/plan-cache.ts`, `src/main/provider-cache.ts`,
`src/main/nodes-cache.ts`. plan-cache and provider-cache are structurally identical
(`cachePath`/`loadFromDisk` with the same two-field shape check/`saveToDisk`/get/set,
same mem-cache pattern); provider-cache adds `TTL_MS`+`isCacheFresh`
(`provider-cache.ts:12,47-51`). nodes-cache is a third variant with **no** memory cache
and a different API shape (`nodes-cache.ts:15-33`). The catch-comments have already
diverged: "best-effort" (`plan-cache.ts:44`, `provider-cache.ts:37`) vs "silent — disk
full / permission errors must not break the app" (`nodes-cache.ts:30`).

**What breaks:** a hardening change to one (corrupt-file recovery, schema validation,
write-error reporting) silently misses the other two; the divergence has already begun
in the smallest possible way (comments), which is how the copies stop being comparable.
Low urgency — each file is ~55 lines and stable — but the rule of three is met.

---

## Finding 5 — The bash OpenVPN validator is a weaker mirror than the TS guard it claims to mirror

**Category:** hand-enforced mirror where one site has drifted (scope-limited).

**Evidence:** `assertSafeOpenVpnConfig` rejects any repeated directive
(`src/main/config-guard.ts:616`) — the repeated-`remote` case exists specifically
because the kill switch whitelists only the first remote — and regex-validates every
directive's argument (`config-guard.ts:529-549`, e.g. `dev` must be exactly
`sntl-ovpn`). The self-described mirror `validate_openvpn_config`
(`resources/linux/katacomb-vpn-helper.sh:177-229`) checks directive **names** only: no
repeated-directive check outside inline blocks, no argument validation.

**Scope honestly stated:** every app flow runs the TS guard at the sink first; the bash
layer only stands alone when the helper is invoked directly via pkexec (its stated "last
line of defense" role, `helper.sh:172-176`). In that role it currently accepts configs
the TS guard rejects (two `remote` lines; arbitrary arguments to allowed directives).
The WG and AWG bash mirrors were checked key-for-key and match exactly
(`config-guard.ts:17-24,435-444` vs `helper.sh:87-170`).

---

## Finding 6 — `|| ''` guards at node read sites contradict the normalizeNodes contract

**Category:** sites drifted from a documented invariant (leftovers, not re-additions).

**Evidence:** `src/renderer/hooks/useNodes.ts:39,42,45,144` and
`src/renderer/utils/chain-diversity.ts:115` guard `country`/`city`/`moniker` with
`|| ''`. CLAUDE.md: `normalizeNodes()` runs on every feed entry point "so that type is
true downstream — don't re-add `|| ''` guards at read sites." `git log -L` dates the
useNodes guards to the first commit, i.e. they predate the contract and were never
removed when it was established.

**What breaks:** nothing today (both files sit downstream of `NodesContext`, which is
normalized). The cost is diagnostic: if a fourth un-normalized entry point ever appears,
these guards make sorting/filtering silently cope while other components white-screen,
splitting the symptom from the cause; and their presence makes the documented contract
unverifiable by reading the code.

---

## Finding 7 — Internal-only symbols carrying `export` for no caller

**Category:** exported helpers without external callers (lowest priority; the export
keyword is the dead part, not the code).

Verified used only inside their own file, with zero external importers (production or
test): `BUNDLED_HASHES` (`src/main/binary-integrity.ts:9`), `defaultDeps`
(`src/main/daemon-core.ts:107`), `probeBatch` (`src/main/node-tester.ts:246`),
`getSubscriptionStakingShare` (`src/main/provider-console.ts:195`),
`markKillSwitchArmed`/`clearKillSwitchArmed` (`src/main/kill-switch.ts:15,25`),
`saveSessionConfig` (`src/main/chain-service.ts`), `probeRpc`/`refreshRpcHealth`
(`src/main/rpc-monitor.ts`), `POLY_TO_PIN`
(`src/renderer/utils/country-normalization.ts:5`), `CHAINABLE_TYPES`
(`src/renderer/utils/chain-node.ts:17`), `p2pToUdvpn`
(`src/renderer/components/provider/ProviderPlans.tsx:37`), `EXPECTED_CHAIN_ID`
(`src/shared/rpc-health.ts:46`), `SLOW_LATENCY_MS` (`src/shared/rpc-health.ts`),
`UDVPN_PER_P2P` (`src/shared/funds.ts`), `SOCKS_TAG` (`src/main/multihop-config.ts:72`),
`PLAN_DENOM`/`MsgEndLeaseTypeUrl` (`src/main/provider-msgs.ts`).

Symbols exported solely so the native test runner can import them (prod=0 but a test
file imports them) are the repo's deliberate pattern and were excluded. Scan covered
`export function/const/class/let` declarations; `export {…}` lists were not swept.

---

## Compliance sweep — documented invariants verified, no drift found

Checked site-by-site against the code; all comply today:

- `startQuotaWatchdog()`: 7 call sites (`ipc-handlers.ts:1974,3005,3031,3053,3111,3160,3209`) — matches "7 sites".
- `assertTunnelCarriesTraffic()`: 7 sites (6 branches + reconnect `:1967`), always after `applyPostConnectSettings`.
- `isProxyChildAlive()` at all four spawn-wait sites (`:1945,3072,3129,3178`); `isChildProxy` = v2ray/xray/hysteria2 only (`vpn-manager.ts:124`).
- `checkTunnelStalled()` on the shared quota loop (`ipc-handlers.ts:582`).
- `pinWireguardEndpoint` in all three WG/AWG paths (`vpn-manager.ts:639,667,716`); `pinV2RayNodeAddresses` at all four v2ray-shaped sinks (`:597,854,894,950`).
- All 3 `lastKnownSessions` writers use `readAllSessions()` + `decorateSessionRow` (`ipc-handlers.ts:2243/2250, 2580/2582, 2720/2722`).
- `normalizeNodes()` on both feed entry points (`ipc-handlers.ts:2003,2027`); renderer reads the context, no stray `nodesFetch()`.
- `onChainPathChanged()` at all three path-changing sites (`ipc-handlers.ts:954,2497`, `index.ts:403`).
- `preflightConnect` in all five buying paths (`:1456,2542,2660,3556,3615`); `establishSessionOrRefund`/`establishChainOrRefund` wrap all session-creating flows (`:2562,2702,3568,3626`).
- Every `signAndBroadcast` goes through `broadcastOrTimeout` (chain-service, plan-service, provider-console).
- All persisted state uses `writeFileAtomic`; the raw `writeFileSync` calls are ephemeral tunnel configs in `SECURE_TMPDIR` (vpn-manager) and the root daemon's own config drops (daemon-core), which the rule does not cover.
- `handle()` wrapper is the only `ipcMain.handle` registration point (`ipc-handlers.ts:2165`).
- `traffic-stats` reads all three interfaces (`traffic-stats.ts:71,83`); daemon and helper both reject `0.0.0.0` (`daemon-core.ts:252`, `helper.sh:590`); WG/AWG bash allow-lists match TS exactly.
- Session counting and per-session actions gate on `status === 'active'` (`App.tsx:186`, `ActiveSessions.tsx:177,249`); Connect additionally gates on `quotaUsedUp` (`ActiveSessions.tsx:391,460`).
- Connect-flow errors reach the UI through `ConnectErrorActions`/`displayConnectError` (which unwrap internally), including ChainReviewModal and ConnectionModal; `useReconnect` wraps at `:36`.
- No em dashes in user-visible strings (all hits are comments, console logs, or the bare `'—'` empty-value glyph); `ErrorBoundary` has two callers and the non-root one has a `fallback` (`MapView.tsx:86`).

**Categories with nothing to report:**
- *Module-level mutable side channels:* none found. The only renderer module-level `let`s are single-file caches (`MapView.tsx:22`, `CountryGlobe.tsx:81`); `onV2RayUnexpectedExit` (`vpn-manager.ts:1245`) is a single callback registration, not smuggled state.
- *Defensive per-key validation behind the typed bridge:* none found. Validation sits at the two real trust boundaries (the `handle()` wrapper's per-handler asserts; `daemon-core`), and renderer pre-validation is the documented defense-in-depth.
- *Single-user settings keys:* none. Every `AppSettings` key (`settings.ts:51-75`) backs a real UI feature.

## Verification

This was a read-only analysis; nothing to run. If any finding is later acted on,
`npm run typecheck` and `npm test` are the gates, plus the specific live checks
CLAUDE.md attaches to the touched area.
