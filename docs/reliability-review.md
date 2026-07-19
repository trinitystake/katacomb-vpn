# Reliability & Robustness Review — Sentinel dVPN Client

**Scope:** Electron main process (~5,800 LOC) plus the preload bridge, renderer
hooks/components, and the bundled Sentinel JS SDK handshake path. Six axes:
blockchain error handling, component failure modes, network/timeout management,
sensitive-data lifecycle, process separation/IPC, and dependency health.

**Method:** static read of the full implicated code paths (no app launch, no root
prompts, no on-chain spend). Every finding below was re-verified by direct read of
the current source at the cited `file:line`. Candidates that did not survive
verification are listed in [Checked, not a bug](#checked--not-a-bug) so the review
is auditable.

**Baseline (all green):** `npm run typecheck` → exit 0 · `npm test` → 79/79 pass ·
`npm audit` → 16 advisories, all in the dev/build tree (see [WS6](#ws6--dependency-health--test-coverage)).

**Severity rubric:** **Critical** = fund loss or security exposure · **High** =
connectivity loss / stranded kill-switch / stuck state requiring restart ·
**Medium** = degraded UX, leaks, hangs with a workaround · **Low** = hygiene, drift
risk.

---

## Findings at a glance

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| H1 | High | Paid session orphaned on any non-policy failure after session creation | `ipc-handlers.ts:199-231, 800-825` |
| H2 | High | No inclusion-timeout handling on session-creating broadcasts (`TimeoutError` + no `timeoutHeight`) | `sentinel-service.ts:176`, `plan-service.ts:284,324` |
| H3 | High | Node handshake POST has no timeout — a dead/silent node hangs the paid connect flow forever | SDK `utils.js:88-94` via `sentinel-service.ts:267,293` |
| H4 | High | Reconnect race: in-flight reconnect body never re-checks `isIntentionalDisconnect` — user disconnect silently undone | `ipc-handlers.ts:383-426` |
| M1 | Medium | No connect/disconnect concurrency guard — overlapping connects orphan a v2ray child | `ipc-handlers.ts`, `vpn-manager.ts:330-345` |
| M2 | Medium | `WALLET_END_SESSION` has no `isVpnActive` guard/timeout — ending a session while connected hangs | `ipc-handlers.ts:644-653` |
| M3 | Medium | `net.fetch` node-list & public-RPC calls have no `AbortSignal` — can hang; refresh timer piles up | `ipc-handlers.ts:430,485` |
| M4 | Medium | v2ray partial-connect orphan: `bringUpV2RayTunnel()` throw leaves child running, no state broadcast | `ipc-handlers.ts:943-951` |
| M5 | Medium | Generated mnemonic copied to clipboard is never cleared | `MnemonicInput.tsx:76-78` |
| M6 | Medium | `killswitch-off` failure swallowed & not surfaced (self-heals next launch) | `kill-switch.ts:44-53` |
| L1 | Low | RPC client leaks on query error (`getBalance`, `getActiveSessions`, `subscribeToNode`) | `wallet.ts:186-189,261-283`, `sentinel-service.ts:148-151` |
| L2 | Low | No connect timeout on CosmJS connects outside `provider-service` | multiple |
| L3 | Low | Cache writes bypass `writeFileAtomic` (repo invariant) | `plan-cache.ts:41`, `provider-cache.ts:34` |
| L4 | Low | Session credential files accumulate — no startup sweep | `sentinel-service.ts:82-85` |
| L5 | Low | Root-side runtime residue not cleaned (`/run/.../sntl0.conf`, tmp dir) | `daemon-core.ts:100-104`, `vpn-manager.ts:24` |
| L6 | Low | Private-key bytes not zeroed on wallet switch/restore; no logout-on-quit | `wallet.ts:110-136`, `ipc-handlers.ts:1281-1289` |
| L7 | Low | Renderer polling hooks silent-catch, no stale/error state (except `IpDisplay`) | `useConnection.ts:20`, `useWallet.ts:36` |
| L8 | Low | `activeProtocol` duplicated in `vpn-manager` and `ipc-handlers` (drift risk) | `vpn-manager.ts:68`, `ipc-handlers.ts:119` |
| C1 | Coverage | Highest-risk modules (reconnect machine, vpn-manager, wallet) have zero tests | see WS6 |

---

## WS1 — Blockchain error handling

### H1 — Paid session orphaned on any non-policy failure after session creation *(High)*

**Location:** `ipc-handlers.ts:199-231` (`handshakeWithPolicy`), sinks at
`:800-825` (`CONNECTION_SUBSCRIBE`), `:1146-1167` (`PLAN_SUBSCRIBE`),
`:1200-1220` (`PLAN_START_SESSION_FROM_SUB`).

**Sequence.** `CONNECTION_SUBSCRIBE` does, in order: `subscribeToNode()` (creates
the session on-chain, **locking a deposit** — `:800`), then
`resolveNodeRemoteUrl()` (`:810`), then `handshakeWithPolicy()` (`:814`).
`handshakeWithPolicy` auto-cancels the session (`endSession` = refund) **only** for
`V2RayPolicyError` (`:213`); every other throw is re-raised untouched at `:228`.

Concrete failure inputs that leave a paid session with no refund attempt:
- `resolveNodeRemoteUrl` throws (`isSafeNodeApiUrl` rejects the node's API field, or
  "Cannot resolve node remote address") — this is *outside* `handshakeWithPolicy`
  entirely, so not even the policy refund applies.
- The WireGuard handshake fails (node offline, `JSON.parse` of a garbage
  base64 body at `sentinel-service.ts:274`, `wg.parseConfig` rejects).
- The V2Ray handshake fails for any reason other than all-cleartext.
- H2/H3 below (broadcast timeout, handshake hang) surface here as generic throws.

**Impact.** The deposit is locked in an orphaned on-chain session. It is
*recoverable* — the session appears in the Session tab (`getActiveSessions`) and the
user can cancel it via `WALLET_END_SESSION` — but the app neither cancels it nor
tells the user which session to cancel; it shows a generic connect error. An
hours-based session bleeds the deposit against elapsed time while it sits active, so
prolonged inattention escalates lock → partial loss. `PLAN_SUBSCRIBE` /
`PLAN_START_SESSION_FROM_SUB` have the same gap against a prepaid allocation
(`isDeposit:false`).

**Remediation direction.** Generalize the existing refund: wrap everything from
`subscribeToNode`/`subscribeToPlan` onward (including `resolveNodeRemoteUrl`) in one
try/catch that calls `endSession` on **any** failure, not only `V2RayPolicyError`,
and surfaces the session id in the error so manual recovery is possible when the
auto-cancel itself fails (the wording branch at `:225` already models this).

### H2 — No inclusion-timeout handling on session-creating broadcasts *(High)*

**Location:** `sentinel-service.ts:176` (`subscribeToNode`), `plan-service.ts:284`
(`subscriptionStartSession`), `:324` (`planStartSession`); also
`sentinel-service.ts:217` (`endSession`).

`signAndBroadcast`/`*StartSession` broadcast then poll for inclusion with CosmJS's
default ~60s timeout and throw `TimeoutError` if the tx isn't mined in time. No
`timeoutHeight` is set on any of these messages, so the transaction can still land
**after** the client has given up.

**Failure scenario.** Chain congestion delays inclusion past 60s → `signAndBroadcast`
throws → the app reports failure and the money-spending tx lands moments later. For
`subscribeToNode` the app never learns the session id, so it cannot even auto-cancel
(worse than H1). The session is still visible in the Session tab afterward, so it is
manually recoverable, but silently.

**Remediation direction.** Set an explicit `timeoutHeight` on the broadcast so a tx
that misses the window is rejected by the chain rather than landing late; treat
`TimeoutError` distinctly from a hard failure (poll `getActiveSessions` to detect a
late-landed session and offer to cancel it).

### L1 — RPC client leaks on query error *(Low)*

- `subscribeToNode` (`sentinel-service.ts:148-151`): `Promise.all([connectWithSigner, queryNodeOnChain])`.
  If `queryNodeOnChain` rejects, the already-resolved signing client is never
  disconnected (the `try/finally` at `:153/196` is only entered *after* `Promise.all`
  resolves).
- `getBalance` (`wallet.ts:186-189`): `client.disconnect()` runs only if
  `getAllBalances` resolves; on rejection the client leaks and the error propagates.
- `getActiveSessions` (`wallet.ts:261-283`): `disconnect()` at `:273` is inside the
  `try`; a rejecting query jumps to the `catch` (`:280`) and skips it.

**Impact.** One leaked CometBFT/WebSocket client per failed RPC attempt. Low —
bounded by user-driven retries, reclaimed on process exit. Note the `plan-service.ts`
functions all use `try/finally` correctly and are the model.

**Remediation direction.** `try/finally` around each `connect … disconnect` (mirror
`plan-service`); for the `Promise.all`, disconnect the signing client in a `catch`.

---

## WS2 — Component interaction & failure modes

### H4 — Reconnect race undoes an intentional disconnect *(High)*

**Location:** `ipc-handlers.ts:383-426` (`attemptReconnect` timer body),
`:337-357` (`performDisconnect`).

The reconnect timer callback awaits `connectWireGuardFromConfig` /
`connectV2RayFromConfig` + `bringUpV2RayTunnel` and then unconditionally sets
`activeProtocol`, starts the monitor, and broadcasts `'connected'` (`:414-421`). It
**never re-checks `isIntentionalDisconnect` after those awaits.**

**Failure scenario.** A tunnel drop schedules a reconnect; the timer fires and enters
its async body (a privileged bring-up round-trip takes seconds). During that window
the user clicks Disconnect (or the tray "Disconnect"). `performDisconnect` sets
`isIntentionalDisconnect=true`, calls `clearTimeout` (a no-op — the timer already
fired), tears the tunnel down, resets `isIntentionalDisconnect=false` at `:355`, and
broadcasts `'idle'`. Meanwhile the still-running reconnect body finishes bringing the
tunnel **back up** and broadcasts `'connected'`. Net result: the user's disconnect is
silently reversed — traffic is tunneling again and the UI says connected.

**Impact.** Security-relevant state divergence: the user believes they disconnected
but the tunnel is live (or vice-versa). Requires no unusual input — just a disconnect
that overlaps an active reconnect attempt, which is exactly when a user is most likely
to intervene.

**Remediation direction.** Re-check `isIntentionalDisconnect` after each await in the
reconnect body and bail (tear down) if it flipped; or gate the whole body on a
generation/epoch counter that `performDisconnect` bumps. Related latent issues in the
same function: no `clearTimeout` at the top of `attemptReconnect` before scheduling a
new timer (a second trigger — e.g. `onV2RayUnexpectedExit`, which unlike the WG
monitor does not check `reconnectAttempt>0` — can orphan a timer), and the recursive
retry is floated un-awaited at `:424`.

### M1 — No connect/disconnect concurrency guard *(Medium)*

**Location:** `ipc-handlers.ts` connect/subscribe/disconnect handlers;
`vpn-manager.ts:330-345` (v2ray exit handler), `:392-395/486-489` (`activeChild` set).

Nothing serializes `CONNECTION_CONNECT`, `CONNECTION_SUBSCRIBE`, and
`CONNECTION_DISCONNECT` against each other or against the autonomous reconnect path.
`spawnV2Ray`'s exit handler guards with `if (activeChild === child)` (`:331`) — so if
a second connect overwrites `activeChild`, the **first** child's exit handler sees the
mismatch and skips all cleanup (TUN teardown, the reconnect callback), leaving an
orphaned v2ray process running.

**Failure scenario.** User clicks Connect while a WG-monitor/exit-triggered reconnect
is mid-flight (or double-clicks Connect). Two `connectV2RayFromConfig` calls spawn two
children; `activeChild` points at the second; the first runs forever unreaped. For
WireGuard, two overlapping `connectWireGuardFromConfig` calls race
`bringDownAllWireGuard` against `bringUpWireGuard`.

**Remediation direction.** A single in-flight "connection operation" promise/mutex in
`ipc-handlers` that connect/subscribe/disconnect/reconnect all await, so operations
serialize instead of interleaving.

### M2 — `WALLET_END_SESSION` hangs when the VPN is active *(Medium)*

**Location:** `ipc-handlers.ts:644-653`.

Unlike `WALLET_GET_BALANCE` (`:596`), `WALLET_SESSIONS` (`:611`), and the plan
handlers, `WALLET_END_SESSION` has **no `isVpnActive()` guard**. `endSession` opens a
signing client to the RPC (`sentinel-service.ts:207`) with no connect timeout. While
our own tunnel is up, RPC routes to the node and is unreachable.

**Failure scenario.** User ends a session from the Session tab while connected →
`connectWithSigner` hangs on the CometBFT connect → the `invoke` promise never
resolves → the button stays in its pending state indefinitely.

**Remediation direction.** Either guard on `isVpnActive()` (disconnect first), or wrap
the connect in the `provider-service` `withTimeout` pattern so it fails fast with a
clear "disconnect before ending a session" message.

### M4 — v2ray partial-connect orphan *(Medium)*

**Location:** `ipc-handlers.ts:943-951` (`CONNECTION_CONNECT`, v2ray branch).

After the 1500 ms liveness check passes, `await bringUpV2RayTunnel()` (`:944`) can
throw (no default route, tun2socks missing, privileged failure). The v2ray child is
already running (`activeChild` set in `vpn-manager`), but `activeProtocol` (ipc side)
is never set, no `applyPostConnectSettings` runs, and no `'connected'` broadcast
fires. `getConnectionStatus()` then reports `connected:true` (child alive) while the
app treats the connect as failed and there is no TUN routing.

**Impact.** Inconsistent state: a live v2ray SOCKS process with no tunnel. Recoverable
(next `performDisconnect` kills it) but confusing, and `isVpnActive()` will start
short-circuiting RPC handlers even though nothing is tunneled. The hard-coded 1500 ms
sleep as a liveness proxy (`:926`, and `:405` on reconnect) is the same fragility: a
node that binds then dies at ~2 s passes the check.

**Remediation direction.** On any post-spawn failure in the v2ray branch, tear the
child down before rethrowing so state stays consistent.

### M6 — `killswitch-off` failure swallowed and not surfaced *(Medium)*

**Location:** `kill-switch.ts:44-53`, caller `ipc-handlers.ts:282-297`.

`disableKillSwitch` catches all errors and — correctly, by design — leaves the armed
marker so the next launch's `healStrandedKillSwitch` retries. But the caller
(`revertPostConnectSettings`) gets no signal, so if teardown truly fails (daemon dead
**and** pkexec unavailable/cancelled), the DROP-all chain persists and the user has no
internet after "disconnect" with **no warning**, until they relaunch the app.

**Impact.** Medium, and partially mitigated: the chain self-heals on next launch, and
`runPrivileged` already falls back from daemon to pkexec. The gap is purely the
missing in-session user feedback.

**Remediation direction.** Surface a warning to the renderer when teardown fails
(mirror the existing `killSwitchFailed` flag used for the *arm* path at `:276`).
**Do not** add a systemd `OnFailure` teardown — the marker + startup-heal design is
deliberate and must not be regressed.

### Daemon-path edges — verified, mostly solid

`isDaemonAvailable()` is `existsSync` not liveness (`daemon-client.ts:12-14`), but this
is handled downstream: `daemonRequest` distinguishes a pre-connect failure
(`ECONNREFUSED`/timeout → `DaemonUnreachableError`) from a post-connect stuck op, and
`runPrivileged` falls back to pkexec only for the former — never retrying a *rejected*
op as root. The one residual cost: a daemon that is listening but unresponsive blocks a
privileged op for the full 60 s (`daemon-client.ts:58-63`) before erroring, with the UI
spinner stuck. Low probability; noted, not separately ranked.

---

## WS3 — Network requests & timeout management

### H3 — Node handshake POST has no timeout *(High)*

**Location:** SDK `@sentinel-official/sentinel-js-sdk/dist/utils.js:88-94`, invoked
from `sentinel-service.ts:267` (WG) and `:293` (V2Ray).

```js
const response = await axios.default.post(httpsUrl, body, {
  headers: { … },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});   // no `timeout` → axios default 0 → waits forever
```

**Failure scenario.** A node in this app's threat model is adversarial. A node that
completes the TLS handshake but never sends an HTTP response wedges
`await sdkHandshake(...)` **indefinitely** — this runs *after* the session was created
on-chain (H1), so the paid connect flow both hangs forever (renderer stuck on
"Performing handshake with node…") and orphans the deposit. The response is also
consumed unvalidated: `JSON.parse(Buffer.from(result.data,'base64'))` at
`sentinel-service.ts:274,300` throws on a garbage body, and `response.data.result`
(SDK `:95`) may be `undefined`, feeding the H1 no-refund path.

> TLS verification is disabled by design (Sentinel nodes use self-signed certs) — not
> re-litigated here. The finding is the missing request timeout and unvalidated shape,
> not the TLS posture.

**Remediation direction.** The timeout lives in the SDK, which the app doesn't own —
wrap `sdkHandshake` on the app side in the `provider-service` `withTimeout` helper (a
bounded `Promise.race`) so a silent node fails fast into the H1 refund path, and
validate `result`/`result.data` before `JSON.parse`.

### M3 — `net.fetch` node-list & public-RPC calls lack `AbortSignal` *(Medium)*

**Location:** `ipc-handlers.ts:430` (`fetchNodes`), `:485` (`fetchPublicRpcs`).

Both omit `signal`, unlike the sibling fetches that do it right — `RPC_CHECK` (`:1010`,
`AbortSignal.timeout(10000)`) and `NETWORK_GET_IP` (`:1075,1091`, 15 s). A stalled TCP
connection to `api.sentnodes.com` hangs the promise. `fetchNodes` runs on a 60 s
`setInterval` (`:471`) whose `tick()` does not await the previous call, so a hang
accumulates overlapping in-flight fetches; `NODES_FETCH` (`:744`) called directly by
the renderer hangs that `invoke`.

**Remediation direction.** Add `{ signal: AbortSignal.timeout(…) }` to both, matching
the existing sibling handlers.

### Renderer polling & connect-timeout pattern — L2, L7

**L2 (Low):** Every CosmJS `SentinelClient.connect` / `connectWithSigner` outside
`provider-service` has no connect timeout (`wallet.ts`, `sentinel-service.ts`,
`plan-service.ts`). Most are guarded by `isVpnActive()` so they only run with RPC
reachable, but a *slow public RPC* (not our tunnel) still hangs them. `provider-service`
(`:37-75`, `withTimeout` on connect **and** query) is the model to propagate.

**L7 (Low):** `useConnection` (`:16-23`) and `useWallet` (`:30-39`) catch poll errors
silently with no "stale" or "error" surface, so a persistently failing RPC is
indistinguishable from "loading". They also don't guard overlapping in-flight ticks
(harmless — the reads are idempotent). `IpDisplay` (`:16,31,40`) is the counter-example
done well (`ipStale` + `loading` + bounded retries) and is the pattern to lift.
`provider-service`'s `sharedClient` heals only reactively (`:135-141` resets on a failed
query), which is acceptable given the VPN-active guard upstream.

---

## WS4 — Sensitive-data lifecycle

### M5 — Generated mnemonic left in the clipboard *(Medium)*

**Location:** `MnemonicInput.tsx:76-78`.

```tsx
function handleCopy() { navigator.clipboard.writeText(generatedMnemonic) }
```

The full BIP-39 seed is written to the OS clipboard and **never cleared**. Clipboard
managers and history tools (and any other app that reads the clipboard) capture it; it
persists across the wallet-creation flow and beyond.

**Impact.** Seed exposure — the one secret whose compromise is total and irreversible.

**Remediation direction.** Auto-clear after a short delay (and on unmount/navigation),
and/or warn the user the phrase is on the clipboard. Consider dropping the copy button
entirely for a write-it-down-only flow given the value at risk.

### L4 — Session credential files accumulate *(Low)*

**Location:** `sentinel-service.ts:47-85`.

`sessions/session-<id>.json` holds the WG `PrivateKey` / V2Ray UUID (encrypted via
`safeStorage`, 0600) and is deleted **only** by `endSession` → `deleteSessionConfig`
(`:82-85,223`). Any other exit — disconnect without ending, quit while connected,
server-side expiry — leaves the file behind. There is no startup sweep.

**Impact.** Low: encrypted credentials for defunct sessions pile up (unbounded disk
growth; historical key material exposed if the keyring is later compromised).

**Remediation direction.** Sweep on startup — drop session files whose id is no longer
in `getActiveSessions()`.

### L5 — Root-side runtime residue not cleaned *(Low)*

**Location:** `daemon-core.ts:100-104` (`writeWgConfig`), `vpn-manager.ts:24`
(`SECURE_TMPDIR`), plus SDK `writeConfig()` temp files.

The daemon writes `/run/sentinel-dvpn/sntl0.conf` (root-owned 0600, contains the WG
private key) and **never unlinks it** — it persists until reboot (it is on tmpfs) or
the next connect overwrites it. On the GUI side, `V2RAY_CONFIG` and the WG conf are
unlinked on disconnect (`vpn-manager.ts:511,127`), but the `SECURE_TMPDIR` directory
itself is never removed, and the SDK's own `v2ray.writeConfig()` temp files
(`sentinel-service.ts:318`, `vpn-manager.ts:375`) — which contain the V2Ray UUID — are
not tracked for cleanup.

**Remediation direction.** Unlink the daemon WG conf on `wireguard_down`; remove
`SECURE_TMPDIR` on quit; delete the SDK-written temp config after reading it.

### L6 — Key bytes not zeroed on wallet switch; no logout-on-quit *(Low)*

**Location:** `wallet.ts:68,94,127` (reassign `state.privKey` without zeroing the
prior `Uint8Array`) vs `:285-299` (`logout` correctly `fill(0)`s); quit path
`ipc-handlers.ts:1281-1289` + `index.ts:284-302` never calls `logout()`.

Switching/restoring wallets abandons the previous private-key bytes to the GC without
scrubbing. `logout()` is the only scrubbing path and isn't wired into quit.

**Impact.** Low and partly moot: on quit the process dies and the OS reclaims the
pages (the comment at `wallet.ts:286-290` already documents the mnemonic-string limit
honestly). The switch-without-zero is the more real of the two — the old key lingers
in-heap during a long-running session.

**Remediation direction.** Zero `state.privKey` before reassigning it in
`switchWallet`/`restoreWallet`/`importWallet`/`deriveSubaccount`.

### L3 — Cache writes bypass the atomic-write invariant *(Low)*

**Location:** `plan-cache.ts:41`, `provider-cache.ts:34` — raw `writeFileSync`.

CLAUDE.md and `fs-utils.ts` require `writeFileAtomic` for all persisted state
"never `writeFileSync` directly." These two caches violate it. Contents are
non-sensitive (plan/provider metadata) and both loaders defend with `try/catch → null`
(`plan-cache.ts:34`, `provider-cache.ts:27`), so a torn write degrades to a cache miss
+ re-fetch rather than a crash.

**Impact.** Low — hygiene/drift from the repo's own rule; the risk is a future
sensitive field added to one of these caches inheriting the non-atomic write.

**Remediation direction.** Switch both `saveToDisk` calls to `writeFileAtomic`.

### `loadSessionConfig` plaintext fallback — checked, acceptable

`sentinel-service.ts:66-76` tries `safeStorage.decryptString` then falls back to
`JSON.parse(raw.toString('utf-8'))`. This is a **read** path; the write side is
correctly gated so it never *produces* plaintext (the H1-storage fix,
`saveSessionConfig:52-55` + `settings.isSecureStorageAvailable`). For genuine
ciphertext the fallback just fails and returns `null`; it only "helps" a legacy
plaintext file that predates the fix. Not a weakening — though a one-time
re-encrypt-or-delete sweep of legacy files would close it fully.

---

## WS5 — Process separation & IPC (mostly clean)

- **`isTrustedSender` (`ipc-handlers.ts:535-541`)** gates every handler via the
  `handle()` wrapper (`:548-555`) — good defense-in-depth. It uses prefix matching:
  `startsWith('file://')` in prod, `startsWith(ELECTRON_RENDERER_URL)` in dev. The
  prefix form is slightly loose (dev: `http://localhost:5173.evil` would prefix-match
  `http://localhost:5173`; prod: any `file://`), but it is backstopped by the
  navigation locks in `index.ts` (`setWindowOpenHandler` denies all `:130-138`;
  `will-navigate` blocks cross-origin `:146-155`) plus `sandbox:true` /
  `contextIsolation:true` / `nodeIntegration:false`. Acceptable; a stricter
  `=== rendererOrigin` / exact-URL compare would remove the sharp edge. **Note only.**
- **Error-serialization collapse — checked, not a bug.** `ipcMain.handle` flattens a
  thrown error to `message`. The two custom classes never cross IPC carrying meaning:
  `V2RayPolicyError` is caught in `handshakeWithPolicy` and re-thrown as a plain
  `Error` with a complete user-facing message (`:222-226`); `DaemonUnreachableError` is
  consumed inside `runPrivileged`. User-facing text survives.
- **Fire-and-forget `send()` inventory (7 channels):** `CONNECTION_PROGRESS`,
  `NODES_UPDATE`, `CONNECTION_STATE_CHANGE`, `CONNECTION_RECONNECTING`,
  `NODE_TEST_PROGRESS`, `PLAN_DISCOVER_PROGRESS`, `CONNECTION_TRAY_CONNECT`. Lost-event
  windows (event emitted before the renderer subscribes) are backstopped by
  `useConnection`'s mount fetch + 3–15 s poll and the tray's `getConnectionInfo()`
  seed. The only un-backstopped one-shot is `CONNECTION_TRAY_CONNECT` (`index.ts:50`) —
  a tray "Connect" fired before the renderer's listener is ready is silently dropped;
  low impact since the app has been running in the tray. **Low.**
- **Preload unsubscribe closures** (`preload/index.ts`) each return a
  `removeListener` cleanup and the hooks call it on unmount — correct, no listener
  leak.

---

## WS6 — Dependency health & test coverage

### `npm audit` — 16 advisories, all dev/build-only

| Package | Sev | Where | Ships in app? |
|---|---|---|---|
| `tar` ≤7.5.15 (7 advisories) | high | `electron-builder` → `@electron/rebuild`/`app-builder-lib`/`dmg-builder` → `node-gyp` → `tar`; also `cacache` | **No** — packaging toolchain |
| `vite` ≤6.4.2 (2 advisories) | high | dev server (`launch-editor` NTLM, `server.fs.deny` bypass) | **No** — dev-only, **Windows-only** bugs |

None are in the runtime bundle. The `vite` fix is non-breaking (`npm audit fix`) and
worth taking; the `tar` chain requires `electron-builder@26` (breaking —
`npm audit fix --force`) and should be scheduled deliberately, not rushed, since it
only affects local packaging. On a Linux-only target the Windows-specific `vite`
advisories are low real-world risk even in dev.

### Framework currency

- **Electron 33 (EOL).** Known-blocked — the app code compiles on Electron 41, but the
  upgrade needs an `electron-builder.yml` migration, a native `secp256k1` ABI rebuild,
  and GUI QA (see the standing `electron-upgrade-blocker` note). Reported as known; not
  re-litigated here.
- **React 18 / Vite 6 / Tailwind 3** are each one major behind — hygiene, no forcing
  function.
- **CosmJS pinned at 0.38.x** — deliberate for Sentinel SDK peer-compat. Not a finding.

### C1 — Coverage gap on the highest-risk modules *(the standout WS6 finding)*

The 79 passing tests cover the pure helpers well (`config-guard`, `fs-utils`,
`traffic-stats`, `v2ray-connection`). **Zero tests** exist for the modules that carry
the reliability risk in this report: `ipc-handlers.ts` (the reconnect state machine —
H4), `vpn-manager.ts`, `kill-switch.ts`, `privileged.ts`, `wallet.ts`, `settings.ts`,
`sentinel-service.ts`.

**Recommendation.** The two decisions most worth extracting into pure, testable
functions are exactly the two highest-severity findings:
1. **The reconnect decision** (H4/M1): a pure function of
   `(attempt, isIntentionalDisconnect, autoReconnect, savedConfig?)` → `retry(delay)` |
   `give-up` | `abort`, including the post-await intentional-disconnect re-check. This
   is currently entangled with timers and I/O in `attemptReconnect`.
2. **The refund-on-failure decision** (H1): a pure predicate over the failure type →
   "attempt endSession + which message", generalizing `handshakeWithPolicy`.

Both are decision logic that can be unit-tested without Electron, sockets, or the
chain, and both guard money/connectivity.

---

## What's solid

This codebase shows real defensive discipline; the findings above are refinements, not
a system in trouble. Verified strengths:

- **Node-trust invariant holds at every sink.** `assertSafeWireguardConfig` /
  `assertSafeV2RayConfig` run before `wg-quick`/spawn in `vpn-manager` (`:422,445,384,478`)
  **and are re-validated at the daemon trust boundary** in `daemon-core.handleRequest`
  (`:137,149-152`) — node-supplied data never reaches root unchecked.
- **Daemon is a proper trust boundary.** All validation in `handleRequest` (not the
  injected deps), socket group-restricted to `sentinel-dvpn` 0660 (`:62-74`),
  tun2socks SHA-pinned server-side with client paths ignored (`:105-112,155`), config
  **content** (not a path) sent over the socket, no `electron` import, 256 KB message
  cap (`:207`).
- **Privileged fallback is correct.** `DaemonUnreachableError` cleanly separates
  "daemon gone → safe to pkexec" from "daemon rejected → never retry as root"
  (`privileged.ts:16-35`, `daemon-client.ts:47-88`).
- **Kill-switch self-heal.** Marker written *before* arming, idempotent unconditional
  teardown, startup heal gated on `armed && !connected` (`kill-switch.ts:31-53`,
  `ipc-handlers.ts:308-312`) — a crash mid-teardown can't strand the user permanently.
- **Strict `safeStorage` write-gating.** `isSecureStorageAvailable()` rejects the
  reversible `basic_text` backend and the app refuses to persist seeds/session creds
  under it (`settings.ts:42-52,117-119`, `sentinel-service.ts:52-55`) — no silent
  plaintext fallback on the write path.
- **Correct RPC client discipline in `plan-service`** (every function `try/finally`
  disconnects) — the model L1 should follow.
- **`provider-service` timeout model** (`withTimeout` on connect + query) — the model
  H3/L2/M2/M3 should propagate.
- **Atomic writes** via `writeFileAtomic` for settings, wallet index, `.enc` files, and
  session configs (the L3 caches are the only stragglers).
- **IPC hardening:** `handle()` wrapper + `isTrustedSender` on every channel, sandboxed
  renderer, external-navigation locks, and a balance pre-check before subscribe
  (`ipc-handlers.ts:787-796`).

---

## Checked — not a bug

- **Error-serialization collapse across `invoke`** — user-facing messages are
  re-thrown as plain `Error`s before crossing IPC; nothing meaningful is lost (WS5).
- **`isDaemonAvailable` is `existsSync`, not liveness** — the stale-socket case is
  handled downstream by `DaemonUnreachableError` + pkexec fallback (WS2).
- **`loadSessionConfig` plaintext read fallback** — write side is gated; the fallback
  only serves legacy files and returns `null` on real ciphertext (WS4).
- **`rejectUnauthorized:false` on node connections** — deliberate (self-signed node
  certs); the H3 finding is the missing *timeout*, not the TLS posture.
- **CosmJS 0.38 pin** — intentional peer-compat with the Sentinel SDK (WS6).
- **Renderer overlapping in-flight polls** — reads are idempotent; no guard needed
  beyond the L7 stale/error UX note (WS3).

---

*Read-only review — no source files were modified. This report is the only artifact.*
