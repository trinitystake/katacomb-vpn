# Sentinel dVPN — Codebase Audit & Modernization Report

> **Audit run:** 2026-06-03 · Electron 33 + React 18 + TypeScript 5.9 + Vite 6 + Tailwind 3, Linux-only desktop client.
> The original reusable audit prompt was moved to [`audit-electron-react-ts.md`](audit-electron-react-ts.md) so this file can hold the results, per the prompt's own instruction.
> **Status: Phases 0, 0.5, 1 (read-only) complete + Phase 2 plan proposed. No code has been changed. Phase 3 awaits your approval.**

---

## Phase 0 — Confirmed stack & orientation

The stack matches the prompt's assumptions. Exact versions from `package-lock.json`:

| Component | Version | Notes |
|---|---|---|
| Electron | **33.4.11** | Chromium 130 / Node 20 era. npm-audit flags it (fix = major bump to 42). |
| React / react-dom | **18.3.1** | Not 19. Context-only state (3 contexts), no Redux/Zustand/router lib. |
| TypeScript | **5.9.3** | `strict: true`. **`tsc --noEmit` passes clean on all 3 projects.** |
| Vite | **6.4.2** | via electron-vite **3.1.0**. |
| Tailwind | **3.4.19** | v3 idioms throughout (no v4). |
| electron-builder | **25.1.8** | Linux AppImage + deb only. **No auto-updater configured.** |
| CosmJS | 0.38.1 | proto-signing + stargate. Bundled (DEPS_TO_BUNDLE) due to ESM-only transitives. |
| Sentinel SDK | 2.0.4 | `@sentinel-official/sentinel-js-sdk`. |
| three / react-globe.gl | 0.184.0 / 2.38.0 | 3D country globe. |
| axios | 1.15.0 | transitive (cosmjs/sdk), **bundled into main**, many high CVEs. |

**Build/run commands:** `npm run dev | build | preview | dist | dist:deb | dist:appimage`.
**Missing scripts:** there is **no `typecheck`, `lint`, or `test` script, and no test framework or linter at all** — for code that runs `wg-quick`/`iptables` as root and handles a crypto seed phrase, this is a notable gap.

**Architecture (verified):** strict 3-process isolation. Main (`src/main/`, 14 modules) does wallet crypto, blockchain RPC, VPN tunnels, OS ops. Preload (`src/preload/index.ts`) exposes exactly 50 allow-listed `window.api` methods via `contextBridge`. Renderer (`src/renderer/`) is sandboxed (`contextIsolation:true`, `nodeIntegration:false`, `sandbox:true` — all correct). Privilege escalation goes through a polkit helper (`/usr/local/bin/sentinel-vpn-helper`, `auth_admin_keep`). WG iface `sntl0`, TUN `sntl-tun`.

> **CLAUDE.md is stale:** it documents ~5 main modules; there are **14**. Undocumented: `kill-switch.ts`, `node-tester.ts`, `plan-service.ts`, `provider-service.ts`, `traffic-stats.ts`, `nodes-cache.ts`, `plan-cache.ts`, `provider-cache.ts`. The kill-switch and DNS-override subsystem (a privacy-critical feature) isn't mentioned at all.

---

## Executive summary

The codebase is **mechanically strong**: `strict` TypeScript type-checks clean, zero `any`/`@ts-ignore`, the IPC surface is fully type-aligned and runtime-validated with hand-rolled asserts, Tailwind has no purge hazards, no secrets/sourcemaps leak into the shipped bundle, and the bundled-binary SHA-256 integrity check is done correctly (fails closed). The renderer's virtualization, memoization of hot list/sort paths, and event-listener cleanups are mostly right.

The serious problems are concentrated in the **threat model the generic checklist under-weighted: the app trusts VPN node operators, and node-controlled data flows into commands run as root.** The two Critical findings are both "untrusted node → root or traffic control" via unsanitized WireGuard/V2Ray configs. The High tier is dominated by **VPN-leak / kill-switch correctness** (the kill switch is effectively broken for WireGuard), **Electron navigation hardening gaps**, **SSRF + disabled-TLS node probing**, a **WebGL context leak** that black-screens the globe after enough tab switches, and **23 npm vulnerabilities** (1 critical, 13 high) with no update mechanism to ever patch them on user machines.

**Counts:** 2 Critical · 11 High · 13 Medium · ~16 Low.

---

## Findings table (sorted by severity)

| # | Sev | Title | Location |
|---|-----|-------|----------|
| C1 | 🔴 Critical | Untrusted-node WireGuard config → `wg-quick` `PostUp` runs as **root** (RCE/LPE chain) | `sentinel-vpn-helper.sh:60-73`, `vpn-manager.ts:405-436`, `ipc-handlers.ts:630-647`, `sentinel-service.ts:240-242` |
| C2 | 🔴 Critical | Untrusted-node V2Ray config spawned with no structural validation (route hijack + proxy control) | `sentinel-service.ts:266-274`, `vpn-manager.ts:172,454-456` |
| H1 | 🟠 High | 23 npm vulnerabilities ship/build (protobufjs critical, axios high, electron high) | `package-lock.json` |
| H2 | 🟠 High | WireGuard kill switch whitelists `0.0.0.0`, not the real endpoint → reconnect handshake dropped, switch ineffective | `ipc-handlers.ts:127`, `sentinel-vpn-helper.sh:182` |
| H3 | 🟠 High | `splitTunnelRoutes` CIDR regex unbounded → `0.0.0.0/0` bypass swallows default route (silent VPN leak) | `ipc-handlers.ts:484` |
| H4 | 🟠 High | Node probe disables TLS verification (`rejectUnauthorized:false`) + fetches attacker-controlled URLs (SSRF) | `node-tester.ts:7,14,90` |
| H5 | 🟠 High | After reconnect "give up", kill switch + DNS override are left engaged (silent network blackhole) | `ipc-handlers.ts:163-167` |
| H6 | 🟠 High | No WireGuard drop detection — auto-reconnect/leak-recovery exists only for V2Ray | `ipc-handlers.ts:997-1003`, `vpn-manager.ts:324-339` |
| H7 | 🟠 High | `setWindowOpenHandler` opens **any** URL scheme via `shell.openExternal`; no `will-navigate` lock-down | `index.ts:97-100` |
| H8 | 🟠 High | WebGL context never released on tab switch → GPU-context exhaustion black-screens the globe | `CountryGlobe.tsx` + `App.tsx:100` |
| H9 | 🟠 High | `safeStorage`-unavailable fallback writes tunnel credentials (WG privkey / V2Ray UUID) in **plaintext**, silently | `sentinel-service.ts:50-52,65-68`, `settings.ts:169` |
| H10 | 🟠 High | No auto-update mechanism → shipped CVEs (incl. Electron, protobufjs, axios) never get patched on user machines | `electron-builder.yml` (no `publish`/updater) |
| H11 | 🟠 High | `useConnection` / `useNodeTest` are per-call-site hooks → ~4× / 2× duplicated IPC subscriptions + poll timers | `useConnection.ts:26-53`, `useNodeTest.ts:12-41` |
| M1 | 🟡 Medium | CSP allows `'unsafe-inline'` for `script-src` | `index.html:6` |
| M2 | 🟡 Medium | No `senderFrame`/origin check on any IPC handler (defense-in-depth) | `ipc-handlers.ts` (repo-wide) |
| M3 | 🟡 Medium | `settings.json` / `wallets-index.json` / `.enc` written non-atomically and world-readable (no `mode`) | `settings.ts:46,86,96,179` |
| M4 | 🟡 Medium | Old-wallet migration on hot path swallows errors → orphan `.enc` accumulation | `settings.ts:158-190` |
| M5 | 🟡 Medium | `apiField` (renderer-controlled) becomes the handshake endpoint, validated only as non-empty string | `ipc-handlers.ts:521,866,921`, `sentinel-service.ts:102-121` |
| M6 | 🟡 Medium | RPC/WS clients leak on error paths (no `try/finally` around `disconnect`) | `sentinel-service.ts:94-100,135-138,181` |
| M7 | 🟡 Medium | 3 context `value` objects recreated every render (no `useMemo`) → re-render storms | `SettingsContext.tsx:31`, `NodesContext.tsx:71`, `NavigationContext.tsx:43` |
| M8 | 🟡 Medium | `darkMatte` three.js material never disposed (GPU leak, compounds H8) | `CountryGlobe.tsx:184-187` |
| M9 | 🟡 Medium | No focus trap / Escape / `aria-modal` in any of the 5 modals (a11y) | `ConnectionModal.tsx:216`, `Settings.tsx:176`, `PlanDiscovery.tsx:1493,1772` |
| M10 | 🟡 Medium | `traffic-stats` prev counters never reset → wrong speed for ≥1 interval after every reconnect | `traffic-stats.ts:11-13,67-77` |
| M11 | 🟡 Medium | `PlanDiscovery.tsx` is a 1953-line god component with two ~95%-identical modals | `PlanDiscovery.tsx:201-940,1402,1670` |
| M12 | 🟡 Medium | `extractV2RayRemoteHost` resolves a node-controlled host via a shell pipeline (mitigated, fragile) | `vpn-manager.ts:186` |
| M13 | 🟡 Medium | `nodes-cache.ts` writes world-readable + persists unbounded untrusted JSON | `nodes-cache.ts:28` |
| L1 | ⚪ Low | 5 dead exported consts/types (`CHAIN_ID`,`DENOM`,`DENOM_DISPLAY`,`DENOM_EXPONENT`,`IPCChannel`) | `chain-constants.ts:1-4`, `ipc-channels.ts:79` |
| L2 | ⚪ Low | 3 unused imports (`readdirSync`, `mkdirSync`, `app`) | `settings.ts:2`, `vpn-manager.ts:3,6` |
| L3 | ⚪ Low | Unused asset `assets/icon.png` (build uses `build/icons`) | `src/renderer/assets/icon.png` |
| L4 | ⚪ Low | No React error boundary → one bad IPC payload white-screens the app | `main.tsx:6-10` |
| L5 | ⚪ Low | three.js + globe eagerly imported into initial chunk (no `React.lazy`) | `MapView.tsx:5` |
| L6 | ⚪ Low | Generated/imported mnemonic left in component state + DOM after success | `MnemonicInput.tsx:16,42` |
| L7 | ⚪ Low | `speedTest` external `AbortSignal` bypasses the 30s hard timeout | `node-tester.ts:206` |
| L8 | ⚪ Low | `nodeFetch` has no response body-size cap (untrusted node, TLS off) | `node-tester.ts:15-22` |
| L9 | ⚪ Low | `bookmarkToggle`/`bookmarkedNodes` unbounded, no address validation | `ipc-handlers.ts:478-480,730-742` |
| L10 | ⚪ Low | `prod sourcemap` not explicitly disabled (relies on Vite default) | `electron.vite.config.ts` |
| L11 | ⚪ Low | `WalletPanel` runs a 3rd independent 30s balance/session poller | `WalletPanel.tsx:19-31` |
| L12 | ⚪ Low | `useSessions` double-fires `refresh()` on mount + no out-of-order race guard | `useSessions.ts:27-38` |
| L13 | ⚪ Low | `HELPER_PATH` constant triplicated across 3 main files | `index.ts:10`, `kill-switch.ts:4`, `vpn-manager.ts:11` |
| L14 | ⚪ Low | `noUnusedLocals`/`noUnusedParameters` not enabled (let the 3 dead imports drift in) | tsconfigs |
| L15 | ⚪ Low | 436 KB GeoJSON re-`fetch`+`JSON.parse` on every Map-tab mount | `CountryGlobe.tsx:106-119` |
| L16 | ⚪ Low | `usePlans` leaves stale `progress` after discovery completes | `usePlans.ts:33-61` |

---

## Critical findings (detail)

### C1 — Untrusted-node WireGuard config → `wg-quick` `PostUp` as root
**Chain:** A VPN node operator is an **adversary** in this app's threat model. On connect, `sentinel-service.performHandshake` builds a WireGuard config purely from node-supplied handshake bytes (`sentinel-service.ts:240-242`, `wg.parseConfig(handshakeData, …)` → `buildConfigString()`), persists it, and `vpn-manager.connectWireGuard/FromConfig` writes it verbatim to `sntl0.conf` (`vpn-manager.ts:405,425`) and runs `wg-quick up` via the root helper. The helper (`sentinel-vpn-helper.sh:60-73`) validates only that the path ends in `sntl0.conf` and has no shell metacharacters — **it never inspects the file contents.** `wg-quick` honors `PostUp`/`PreUp`/`PostDown`/`PreDown` directives that execute arbitrary shell **as root**. The renderer can also reach this directly: `CONNECTION_CONNECT` accepts `params.configString` checked only with `typeof === 'string'` (`ipc-handlers.ts:637`).

**Impact:** (a) a malicious/compromised node can land a `PostUp = …` directive → **root code execution on the client**; (b) any renderer compromise (e.g. via the `'unsafe-inline'` CSP, M1) → local privilege escalation to root, since the IPC path performs zero content validation. The `auth_admin_keep` policy (`com.sentinel.dvpn.policy:16`) widens the window.

**Fix:** Sanitize at ingestion in `performHandshake`, before persisting: parse the built config and **reject** (throw, abort connect) any `PostUp`/`PreUp`/`PostDown`/`PreDown`/`Table`/`FwMark` directive and any key not in a strict allow-list (`PrivateKey, Address, DNS, MTU, [Peer], PublicKey, PresharedKey, AllowedIPs, Endpoint, PersistentKeepalive`), with value-shape validation. Add the same allow-list check in the helper's `up` branch as defense-in-depth. Drop the raw-`configString` fallback in `CONNECTION_CONNECT` — connect off the server-held `activeWg` instance only.

### C2 — Untrusted-node V2Ray config spawned with no structural validation
`v2ray.parseConfig(handshakeData, …)` (`sentinel-service.ts:266-274`) turns untrusted node bytes into a config; `connectV2RayFromConfig` only does `JSON.parse()` to confirm it's JSON (`vpn-manager.ts:444-456`) then spawns v2ray on it. A node controls arbitrary fields: most dangerously `outbounds[].settings.vnext[].address`, which `extractV2RayRemoteHost()` (`vpn-manager.ts:172`) feeds into the **privileged** `tun-up` call to add a host route bypassing the tunnel (attacker-chosen IP), plus `inbounds`/`log` file paths / routing rules that v2ray will honor.

**Fix:** Validate the parsed V2Ray config against an allow-list before persisting/spawning: exactly one expected outbound protocol, `inbounds` = the local SOCKS listener only, no `log` file paths, no unexpected routing rules. Cross-check `vnext.address` against the on-chain `remoteAddrs` rather than trusting the node.

---

## High findings (detail — condensed)

- **H1 — npm vulnerabilities.** `npm audit`: **23 total (1 critical, 13 high, 5 moderate, 4 low)**. Critical **protobufjs** (RCE / prototype-pollution) and high **axios 1.15.0** (≈17 advisories) both **ship in the bundled main process**. **electron** itself is high (fix = major bump to 42; many advisories are macOS/Windows-only, so lower real risk for this Linux app — but not zero). Most electron-builder-tree highs (`app-builder-lib`, `tar`, `dmg-builder`, `node-gyp`) are **build-time only**. Run `npm audit fix` for the safe ones (postcss→XSS, follow-redirects, brace-expansion); evaluate axios/protobufjs bumps against CosmJS/SDK peer ranges; treat the Electron major separately (see Phase 2).
- **H2 — WG kill switch whitelists `0.0.0.0`.** `applyPostConnectSettings` sets `remoteHost = getV2RayRemoteHost() || '0.0.0.0'` (`ipc-handlers.ts:127`); `getV2RayRemoteHost()` returns `null` for a WireGuard session, so the helper installs a useless `-d 0.0.0.0/32 -j ACCEPT` rule (`helper:182`). A dropped WG tunnel can never re-handshake while the switch is on (fresh UDP flow isn't `ESTABLISHED`, so it's `DROP`ped). **Fix:** parse `Endpoint = <ip>:<port>` from the WG config and pass that as `remoteHost` for `protocol==='wireguard'`.
- **H3 — split-tunnel `0.0.0.0/0` leak.** `SETTINGS_SET` validates routes with `/^\d+\.\d+\.\d+\.\d+\/\d+$/` (`ipc-handlers.ts:484`) — no octet ≤255 / prefix ≤32 bound, and `/0` is allowed. A renderer can persist `0.0.0.0/0` as a "bypass route"; on next connect the helper installs a default route through the **real** gateway → traffic leaks around the tunnel. **Fix:** parse-validate octets/prefix, reject `/0` and `0.0.0.0/x`, cap array length.
- **H4 — node probe SSRF + TLS off.** `node-tester.ts:7` uses `new https.Agent({rejectUnauthorized:false})` for every probe, and `probeNode` fetches `remoteUrl` derived from blockchain/`apiField` (attacker-controllable) with no scheme/host allow-list and no RFC1918/link-local block (`node-tester.ts:14,90`). A node can make the client GET internal/localhost services, and disabled TLS lets an on-path attacker MITM the "health/latency" ranking. **Fix:** reject non-https, require explicit port, block private/loopback IPs after resolution, treat probe results as untrusted hints.
- **H5 — kill switch left on after give-up.** On `reconnectAttempt > MAX`, the code does `sendStateChange('idle'); return` without `revertPostConnectSettings()`/`disconnect()` (`ipc-handlers.ts:163-167`), stranding the user behind a DROP-all iptables chain (worsened by H2's `0.0.0.0` whitelist) with no UI indication. **Fix:** revert post-connect settings on every terminal failure path.
- **H6 — no WG drop detection.** Only `onV2RayUnexpectedExit` triggers reconnect (`ipc-handlers.ts:997`); nothing watches `wg show sntl0` handshake age, so a silently-dead WG tunnel never reconnects and (kill switch off by default) can leak in clear while the UI shows "connected." **Fix:** add a periodic main-process WG-liveness monitor mirroring the V2Ray exit callback.
- **H7 — window-open / navigation.** `setWindowOpenHandler` calls `shell.openExternal(details.url)` for any scheme (`index.ts:97-100`); no `will-navigate` handler exists. **Fix:** allow-list `https:`/`http:`/`mailto:` only; add `webContents.on('will-navigate', …)` to block in-renderer navigation away from the app origin.
- **H8 — WebGL context leak.** `App.tsx:100` renders `{mainTab==='map' && <MapView/>}`, so `CountryGlobe` fully unmounts/remounts per tab switch. The library calls `renderer.dispose()` but never `forceContextLoss()`, so each remount allocates a new WebGL context; after ~16 round-trips Chromium drops the oldest → black/dead globe + growing GPU memory. **Fix:** keep the globe mounted (toggle visibility with CSS) **or** call `globeRef.current.renderer()?.forceContextLoss()` and dispose the owned `darkMatte` material (M8) in an unmount cleanup.
- **H9 — plaintext credential fallback.** `saveSessionConfig` writes the session config (WG `PrivateKey` / V2Ray UUID) in **plaintext** when `safeStorage` is unavailable (`sentinel-service.ts:50-52`), and `loadSessionConfig` transparently reads it back (`:65-68`); `migrateOldWallet` silently `return`s on unavailability (`settings.ts:169`). This is exactly the "graceful degradation that silently weakens security" antipattern CLAUDE.md warns against. **Fix:** require `safeStorage` consistently (throw, as `addWalletEntry` already does) or surface a loud warning — never silently write tunnel credentials in cleartext.
- **H10 — no auto-update.** `electron-builder.yml` configures no `publish` target / electron-updater. Combined with H1, every shipped CVE (Electron, protobufjs, axios) stays unpatched on installed machines until a manual reinstall. **Fix:** decide on an update strategy (electron-updater over HTTPS with signed artifacts, or document a package-manager channel).
- **H11 — duplicated hook subscriptions.** `useConnection` (4 call sites: `App.tsx:23`, `ConnectedBar.tsx:8`, `NodeTable.tsx:39`, `ActiveSessions.tsx:53`, plus via `useSessions`) and `useNodeTest` (2 call sites) each run their own IPC subscription + poll timer, so one logical state fans out to ~4 listeners and ~4 `connectionStatus()` round-trips. Cleanups are correct (no unbounded leak) but it's a standing 4× cost + split-brain hazard. **Fix:** promote both to context-backed singletons.

---

## Quick wins (low risk, high value, fast)

1. **Add `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.web.json --noEmit"`** to scripts (it already passes), and enable `noUnusedLocals`/`noUnusedParameters`. (L14)
2. **Delete dead code:** 5 dead exports (L1), 3 unused imports (L2), `assets/icon.png` (L3) — all verified zero-reference. ~10-line, behavior-neutral.
3. **Harden window/navigation:** scheme allow-list on `setWindowOpenHandler` + add `will-navigate` block. (H7)
4. **Memoize the 3 context `value` objects** with `useMemo`. (M7)
5. **Dispose `darkMatte` material** + add the globe context-loss cleanup. (M8/H8)
6. **Add `{mode:0o600}` + atomic temp-rename** to settings/index/`.enc`/cache writes. (M3, M13)
7. **Reset `traffic-stats` counters on connect.** (M10)
8. **`npm audit fix`** for the non-breaking advisories (postcss XSS, follow-redirects, brace-expansion). (H1, partial)
9. **Add a single `ErrorBoundary`** around the app root. (L4)
10. **Set `build.sourcemap:false`** explicitly on renderer + main. (L10)

---

## Prompt gaps & added scope (Phase 0.5)

The generic checklist under-weighted what matters most for *this* app. Added/elevated dimensions:

- **Adversarial-node threat model + privilege escalation** — the single most important axis here. Node operators are untrusted, and their data reaches `wg-quick`/`iptables`/`ip route` run **as root** through the polkit helper. The checklist mentions `child_process` generically but not "untrusted remote data → root-executed config" (C1, C2). **This deserved, and got, dedicated scrutiny.**
- **VPN-leak / kill-switch correctness (fail-closed semantics)** — not in the checklist at all, yet for a privacy tool it's existential. Found a broken WG kill switch (H2), a default-route bypass (H3), no WG drop detection (H6), and a stranding bug (H5).
- **WebGL/three.js resource lifecycle** — not in the generic "performance" section; found a real GPU-context leak (H8/M8).
- **Wallet seed-phrase + at-rest encryption (`safeStorage`)** — elevated beyond generic "secrets"; found the plaintext fallback (H9) and the migration/atomicity issues (M3/M4). *Strength:* `MnemonicInput` handling is clean (no logging, `autoComplete=off`, offline validation).
- **Supply-chain binary integrity** — *strength worth recording:* bundled `v2ray`/`tun2socks` are SHA-256-verified and **fail closed** (`vpn-manager.ts:24-57`), exactly as CLAUDE.md prescribes.
- **No tests / lint / CI** — for root-privileged + crypto code, the total absence is itself a risk finding.
- **Instructions dropped as N/A:** macOS/Windows **code signing & notarization** (Linux-only app); **ASAR/native-module rebuild** specifics (no native modules ship beyond optional `ws` deps). **Auto-update** was *not* dropped — its absence is finding H10.

---

## Phase 2 — Proposed remediation plan (awaiting approval)

Batches are ordered by priority. Each notes **risk**, **effort**, **behavior change**. **No code changes until you approve** — and per the prompt's deletion rules, the dead-code list (L1–L3) will be presented for explicit sign-off before removal.

**Batch A — Critical node-trust hardening** · risk: med-high (touches connect path) · effort: M · behavior: stricter (rejects malformed/hostile configs)
- C1: allow-list-sanitize WG config in `performHandshake` before persist; reject `PostUp`-family directives; mirror the check in the helper `up` branch; drop the raw-`configString` IPC fallback.
- C2: allow-list-validate V2Ray config before spawn; cross-check `vnext.address` vs on-chain `remoteAddrs`.
- *Verification:* connect to a real node still works (WG + V2Ray); a config with an injected `PostUp` is rejected.

**Batch B — VPN-leak & kill-switch correctness** · risk: med · effort: M · behavior: fixes silent leaks
- H2 (WG endpoint in kill switch), H3 (CIDR validation, reject `/0`), H5 (revert on give-up), H6 (WG drop monitor).
- *Verification:* kill switch blocks egress on tunnel drop; WG reconnect succeeds with switch on; `0.0.0.0/0` bypass rejected.

**Batch C — Electron & dependency hardening** · risk: low-med · effort: S-M · behavior: minimal
- H7 (window/navigation), M1 (CSP nonce for the theme script), M2 (senderFrame checks), H1 (`npm audit fix` + evaluate axios/protobufjs/Electron bumps), H10 (decide update strategy). **The Electron major bump (33→42) is called out separately — it's higher-risk and I'd do it on its own branch with launch/IPC smoke tests.**

**Batch D — At-rest secrets & I/O robustness** · risk: low-med · effort: S-M · behavior: stricter on broken keyrings
- H9 (no plaintext fallback), M3 (atomic + `0600` writes), M4 (one-shot migration, surface errors), M6 (`try/finally` RPC disconnect), M5 (validate `apiField` as https URL).

**Batch E — Renderer perf & correctness** · risk: low · effort: M · behavior: none (internal)
- H8/M8 (WebGL lifecycle), H11 + M7 (context-ize `useConnection`/`useNodeTest`, memoize contexts), M10 (traffic reset), M9 (shared `useModal` a11y hook), M11 (split `PlanDiscovery`, unify the two modals), L5/L15 (lazy-load globe, cache GeoJSON).

**Batch F — Dead code, DX & docs** · risk: very low · effort: S · behavior: none
- L1-L3 deletion (after sign-off), L13 (`HELPER_PATH` dedup), L14 (`noUnusedLocals`), L4 (error boundary), L10 (sourcemap), plus add `typecheck` script and a minimal test scaffold for the new config-sanitizers (Batch A) and CIDR validator (Batch B).
- **Update CLAUDE.md** to document all 14 main modules, the kill-switch/DNS subsystem, and the node-trust sanitization invariants from Batch A.

---

### How I verify (Phase 3, once approved)
New git branch, focused commits, never on `master`/`main`. After each change: `tsc --noEmit` clean, `npm run build` succeeds, and for connect-path changes a manual launch + WG/V2Ray connect/disconnect/kill-switch smoke test. Behavior changes flagged loudly. Deletions only via git, only after the sign-off list.
