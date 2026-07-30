# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run dev          # Start Electron + Vite dev server with HMR
npm run build        # Production build (outputs to out/)
npm run preview      # Preview production build
npm run dist         # Build + package for Linux (AppImage + deb)
npm run dist:deb     # Build + package deb only
npm run dist:appimage # Build + package AppImage only
npm test             # Run unit tests (Node's built-in TS test runner, zero deps)
npm run typecheck    # tsc --noEmit on both projects (must pass clean)
```

Tests use Node's native `--test` runner against `src/**/*.test.ts` (no Vitest/Jest,
no extra dependency — Node 22+ strips TS types and runs the tests directly). Cover
the pure security/IO helpers (`config-guard.ts`, `fs-utils.ts`). Test files are
excluded from the build tsconfigs and import the module-under-test with a `.ts`
extension (required by the native runner). No linter is configured; `tsc` is
`strict` with `noUnusedLocals`/`noUnusedParameters` on.

## Architecture

Katacomb VPN desktop client: Electron 41 + React 18 + TypeScript + Vite + Tailwind CSS 3. Connects to the Sentinel blockchain (Cosmos SDK) to subscribe to decentralized VPN nodes and establish WireGuard/V2Ray tunnels. Linux-only target.

### Naming: the product vs. the chain (do not "finish the job")

The product was renamed **Sentinel dVPN → Katacomb VPN**. The word "Sentinel" is
gone from everything the app owns. What remains is the **blockchain**, not the
brand, and removing it breaks the build or makes a comment unverifiable:

- the npm dep `@sentinel-official/sentinel-js-sdk`, its deep protobuf import paths,
  and its API surface (`SentinelClient`, `SigningSentinelClient`, `sentinelQuery`)
- protobuf type URLs the chain returns: `/sentinel.node.v3.Session`,
  `/sentinel.subscription.v3.Session`, `sentinel.types.v1.RenewalPricePolicy`
- hostnames `rpc.sentinel.co`, `api.sentnodes.com`; the `sent` prefix; `udvpn`
- upstream citations naming `sentinel-official/sentinel-go-sdk`, `sentinel-dvpnx`,
  `sentinel-dvpncli` (binary pins + metadata field provenance)

Also deliberate: the tunnel interfaces stayed **`sntl0` / `sntl-tun`**. They are
opaque tags, and renaming them would touch the AmneziaWG type-tun discriminator,
traffic stats, the liveness monitor and awg-quick's filename-derived iface.

**userData moved** with `package.json` `name` (`~/.config/sentinel-dvpn-app` →
`~/.config/katacomb-vpn`). `settings.migrateLegacyUserData()` (called first in
`whenReady`) copies settings/wallets/sessions across. `safeStorage`'s libsecret key
is keyed by app name, so pre-rename `.enc` seeds **cannot** be decrypted —
verified, not assumed. `getWalletMnemonic` turns that failure into a re-import
instruction; the wallet index is copied so the name/address stay visible.

### Process Separation

Strict Electron security isolation with three process boundaries:

- **Main process** (`src/main/`): Node.js context. Wallet crypto, blockchain RPC, VPN tunnel management, OS-level operations. All sensitive operations live here.
- **Preload** (`src/preload/index.ts`): contextBridge exposing `window.api` — the only IPC channel between main and renderer. Channel constants in `src/shared/ipc-channels.ts`.
- **Renderer** (`src/renderer/`): Browser context with React. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. No Node.js access.

### Key Modules (Main Process)

- `wallet.ts`: BIP-39 mnemonic import, `DirectSecp256k1HdWallet` derivation with `sent` prefix, `safeStorage` encryption (OS keyring via libsecret on Linux), balance/session queries via `SentinelClient`.
- `settings.ts`: Multi-wallet store (`wallets/` dir with encrypted `.enc` files + `wallets-index.json`), app settings (`settings.json`), old single-wallet migration. Wallet entries have `id` (UUID), `name`, `address`.
- `chain-service.ts`: `SigningSentinelClient` for on-chain tx (node subscription via `nodeStartSession`), session ID extraction from tx events, cryptographic handshake with nodes (WireGuard/V2Ray branching). Session configs saved to disk for reconnect.
- `vpn-manager.ts`: V2Ray child process lifecycle, WireGuard via polkit helper, tun2socks TUN routing for V2Ray, connection status monitoring. Bundled binaries (v2ray, tun2socks) verified via SHA-256 before use, with system PATH fallback.
- `ipc-handlers.ts`: all IPC channels (registered via a `handle()` wrapper that rejects calls from any frame that isn't our own renderer), pre-connect balance validation, node list fetch from `api.sentnodes.com/v2/nodes` via `net.fetch`, auto-reconnect + a WireGuard liveness monitor. Caches balance/sessions/nodes when VPN is active (RPC unreachable through tunnel).
- `config-guard.ts`: **pure validators for untrusted-node data** — `assertSafeWireguardConfig` (allow-list keys, reject `PostUp`/`PreUp`/… so a node config can't run shell as root via `wg-quick`), `assertSafeV2RayConfig`, `isAllowedBypassCidr`/`sanitizeBypassRoutes` (reject `0.0.0.0/x` split-tunnel routes), `extractWireguardEndpointHost`. Unit-tested; see the node-trust invariant below.
- `fs-utils.ts`: `writeFileAtomic(path, data, mode=0o600)` (temp + rename). Use it for all settings/wallet/session/cache writes — never `writeFileSync` directly for persisted state.
- `kill-switch.ts`: iptables-based kill switch (helper `killswitch-on`/`killswitch-off`); `traffic-stats.ts`, `node-tester.ts`, `plan-service.ts`/`provider-service.ts` and their `*-cache.ts`, `nodes-cache.ts` round out the main process.
- `async-utils.ts` (`withTimeout`), `connect-decisions.ts` (pure refund-message + reconnect/backoff decisions, `serviceTypeToNodeType` for the preflight, `isDnsProvisionError`/`stripDnsLines` for the DNS fallback), `tx-utils.ts` (`broadcastOrTimeout`): the **Electron-free, unit-tested** reliability helpers. Keep new pure decision logic here rather than inline in the Electron-coupled modules, so it stays testable under the native runner.

### Privilege Escalation

VPN operations require root. Instead of raw `pkexec wg-quick`, the app uses a polkit helper:
- `resources/linux/katacomb-vpn-helper.sh` — installed to `/usr/local/bin/katacomb-vpn-helper`
- `resources/linux/com.katacomb.vpn.policy` — polkit policy for cached auth
- `resources/linux/postinstall.sh` — deb postinstall that deploys the helper + policy
- Helper commands: `up <config>`, `down`, `tun-up <bin> <socks> <remote> <gw> <iface>`, `tun-down`, `killswitch-on <iface> <host> [dns]`, `killswitch-off`, `dns-set <ip>`, `dns-restore`
- WireGuard interface name: `sntl0`. TUN interface: `sntl-tun`.

### Privileged daemon (deb) vs. pkexec fallback (AppImage/dev)

The `.deb` installs a **persistent root daemon** (systemd `katacomb-vpn-daemon`,
run via `ELECTRON_RUN_AS_NODE` on the bundled Electron) so connect/disconnect
**never prompt for a password**. The GUI (as the user) sends JSON ops over a Unix
socket at `/run/katacomb-vpn/daemon.sock` (mode 0666 — any local user, Mullvad
model). The AppImage and `npm run dev` have no daemon, so they fall back to the
per-op `pkexec` helper (one cached prompt).

- `daemon-core.ts`: socket server + op dispatch — **all validation lives here**,
  since the socket is unauthenticated it's the trust boundary. `daemon.ts`: the
  `ELECTRON_RUN_AS_NODE` entry, bundled standalone by `scripts/build-daemon.mjs`
  (esbuild) → `out/daemon/index.js`, shipped **outside the asar** to
  `resources/daemon/index.js`. The daemon must NOT import `electron`.
- `daemon-client.ts` (`isDaemonAvailable`/`daemonRequest`) + `privileged.ts`
  (`runPrivileged` routes to the daemon if its socket exists, else `pkexec`).
  The privileged call tree (`vpn-manager`, `kill-switch`, `ipc-handlers`) is
  **async** because of the socket round-trip.
- Packaging: `postinstall.sh` installs+enables the unit and a space-free
  `/opt/katacomb-vpn` → `/opt/Katacomb VPN` symlink (the unit ExecStart uses it
  + the `katacomb-vpn` binary name). `postrm.sh` tears down any tunnel then
  removes everything. **If you change the package `name`, fix the unit ExecStart
  binary.** Verify packaging by building + extracting the deb (`dpkg-deb -x`),
  not just by reading config.

### Node-trust invariant (critical — do not regress)

**VPN node operators are adversaries in this app's threat model.** Their handshake
data becomes WireGuard/V2Ray configs and split-tunnel routes that the polkit helper
runs as **root** (`wg-quick`, `iptables`, `ip route`). A `wg-quick` config with a
`PostUp = …` directive executes shell as root — so any code path that turns
node-supplied (or renderer-supplied) data into a `.conf` / spawn / route MUST pass it
through `config-guard.ts` first. `vpn-manager.ts` enforces this at the sinks
(`connectWireGuard*`, `connectV2Ray*`, `bringUpTun`); never add a path that writes
node-derived data to disk or hands it to the helper without a `config-guard` check.
Likewise, tunnel credentials are only persisted when `safeStorage` is available —
never fall back to writing them in plaintext.

### Reliability invariants (do not regress)

The connect path spends real on-chain funds, so these are enforced and must hold:
- **Refund on any failure.** Any flow that creates an on-chain session
  (`subscribeToNode` / `subscribeToPlan` / `startSessionWithExistingSubscription`)
  MUST run its resolve-endpoint + handshake through `establishSessionOrRefund`
  (`ipc-handlers.ts`), which auto-cancels (refunds) the just-created session on *any*
  failure. Never create a session and then handshake without that wrapper.
- **Serialize tunnel ops.** `CONNECTION_CONNECT`, `performDisconnect`, and the reconnect
  timer body run inside `withConnectionLock` (a mutex) and are guarded by
  `connectionEpoch` (bumped on disconnect, so an in-flight reconnect can't resurrect a
  tunnel the user tore down). Never add a tunnel bring-up/tear-down that bypasses both.
  Note `ipc-handlers`' `desiredProtocol` (intended) is deliberately distinct from
  `vpn-manager`'s `activeProtocol` (actual, cleared on interface drop) — don't merge them.
- **Bound every wait.** RPC connects go through `withTimeout`; session-creating broadcasts
  go through `broadcastOrTimeout` and set a `timeoutHeight`. `provider-service.ts` is the
  reference for the timeout pattern. (`node-tester.ts`'s `nodeFetch` timeout does NOT
  cover the TCP connect — a blackholed node hangs past it — so wrap its callers.)
- **Preflight before paying.** The three session-creating handlers call
  `preflightConnect(nodeType, apiField)` BEFORE the tx: `protocolRuntimeError()`
  (binaries present + SHA-verified; WG/AWG also need `canEscalatePrivileges()`), then
  the node's own `service_type` — fetched from its ROOT path, `/info` 404s — mapped via
  the pure `serviceTypeToNodeType()` and required to match the aggregator's type.
- **Retry, don't re-buy.** A failed bring-up leaves the paid session's config stashed in
  main (cleared only by `performDisconnect`), so the connect modals offer "Retry
  connection" (`connectionConnect` alone) instead of resetting to the subscribe form.
  Shared UI: `ConnectErrorActions.tsx`.
- **One instance.** `src/main/index.ts` takes `requestSingleInstanceLock()` and the loser
  exits via `app.exit(0)` — `app.quit()` would fire before-quit and tear down the
  *primary's* tunnel.

### Vite Bundling (Critical)

`electron.vite.config.ts` must bundle the entire CosmJS/dVPN SDK dependency tree (listed in `DEPS_TO_BUNDLE`). Electron loads main process output as CJS, but these deps have ESM-only transitive dependencies (`@scure/base`, `@noble/*`). Only `bufferutil` and `utf-8-validate` are externalized (ws optional native deps that gracefully no-op).

**If you add a new `@cosmjs/*` or dVPN SDK dependency, add it to `DEPS_TO_BUNDLE` or the build will fail at runtime with `ERR_REQUIRE_ESM`.**

### Renderer Conventions

- Hooks in `src/renderer/hooks/`: `useWallet` (balance polling 300s), `useNodes` (node fetch + filter/sort, 60s refresh), `useConnection` (status polling 3s). Polling intervals are hardcoded per-hook — not user-tunable.
- Node table uses `@tanstack/react-virtual` for virtualized rendering (5000+ nodes).
- BIP-39 validation uses direct JSON wordlist import + Set lookup (not `bip39.validateMnemonic` — that function's dynamic require fails in Vite's renderer bundle).
- Cypherpunk dark theme: bg `#0a0a0f`, accent green `#00ff88`.
- `@` alias maps to `src/renderer/`.
- Types for renderer in `src/renderer/types/index.ts` — includes `ElectronAPI` interface matching preload bridge and `declare global` for `window.api`.

### Node protocol types

`SentNode.type` is a **numeric** protocol tag from the `api.sentnodes.com/v2/nodes`
feed: `0`=unknown, `1`=WireGuard, `2`=V2Ray, `3`=OpenVPN, `4`=XRAY, `5`=AmneziaWG,
`6`=Hysteria2. **Each node runs exactly ONE protocol** — a node's own `/info`
endpoint reports a single `service_type` (verified against dvpnx master + live
v9.0.0 nodes). The v9.0.0 "six protocols" marketing means six protocol *types*
exist across the network, NOT six per node; multi-protocol operators register
several separate nodes. Do not build a per-node "protocols array" model — there's
no aggregator field for it.

`src/renderer/utils/protocols.ts` is the **single source of truth** for protocol
label / short badge / semantic color / `supported` flag — use `protocolMeta(type)`
and `isProtocolSupported(type)` instead of inline `type === 1 ? …` ternaries (which
assume a two-protocol world). The Nodes-tab protocol filter is a single-select
`<select>` in `NodeFilters.tsx` driven by `PROTOCOL_FILTER_OPTIONS`; `NodeFilter.type`
is `'all' | ProtocolType`.

**Connectable: WireGuard (1), V2Ray (2), XRAY (4), AmneziaWG (5), Hysteria2 (6).**
OpenVPN (3) is identify-and-filter only — the connect UI disables it
(`isProtocolSupported`) and the main-process IPC guards (`nodeType` not in `{1,2,4,5,6}`
→ throw) are the enforcement. Each additional protocol needs its own pinned binary,
config generation/validation, and (for root-run ones) a privileged daemon op. OpenVPN
is a root protocol, so it DOES need the privileged-daemon path (like AmneziaWG, unlike
the unprivileged xray/hysteria2 pilots).

**XRAY** is the VLESS+Reality protocol and reuses almost the entire V2Ray path: it's
a v2ray-core fork that reads the **same JSON config**, so it runs through the same
`config-guard` transforms (`pinV2RayNodeAddresses`/`withV2RayDiagnosticLog`/
`assertSafeV2RayConfig`/`withV2RayDoH`), the same tun2socks routing (`bringUpTun`),
and the same child-process lifecycle (`spawnV2Ray` — generalized to take a
bin/args/logName; `isChildProxy()` narrows v2ray+xray together at the branch sites).
What differs:
- The bundled JS SDK **cannot** build Reality configs — its `V2RayMetadata`
  type has no `flow`/`reality_*` fields and `V2Ray.parseConfig` ignores them — so
  `src/main/xray-config.ts` (`buildXRayConfig`, pure + unit-tested) builds the xray
  VLESS+Reality JSON from the node's handshake metadata. Enum decode confirmed via the
  aggregator: `proxy_protocol 1=vless`, `transport_protocol 1=tcp`, `transport_security
  1=none/2=tls/3=reality`, `flow 2=xtls-rprx-vision`. It only ever selects reality/tls
  entries (never `none`), which is what keeps an xray tunnel from being cleartext.
- The handshake reuses the generic `sdkHandshake(sid, { uuid }, …)` (VLESS peer
  material is a UUID, same as V2Ray); `performHandshake`'s `nodeType === 4` branch
  generates the uuid from an SDK `V2Ray` instance purely for that.
- A separate **`xray`** binary is bundled in `resources/linux/v2ray/` (Xray-core
  official release, SHA-pinned in `binary-integrity.ts` — vendor + verify checksum +
  update the pin when upgrading). `extraResources` ships everything under that dir.

**Hysteria2** (type 6) is a QUIC protocol — NOT a v2ray-core fork — but it still reuses
the child-process + tun2socks tunnel path because the `hysteria` client exposes a local
SOCKS5 listener (`isChildProxy()` narrows v2ray+xray+hysteria2 together). What differs:
- Its own bundled **`hysteria`** binary (apernet/hysteria, SHA-pinned in
  `binary-integrity.ts`; CLI `hysteria client -c <file>`, JSON config via viper by `.json`
  ext) in `resources/linux/v2ray/`.
- The SDK has no Hysteria2 class at all, so `src/main/hysteria-config.ts`
  (`buildHysteria2Config`, pure + unit-tested) synthesizes the whole client config from a
  few handshake-metadata scalars: `server`/`auth`(=uuid)/`tls{insecure:true,pinSHA256}`/
  `socks5{listen:127.0.0.1:1080}`/`lazy:true` (+ optional salamander `obfs`). Fields taken
  verbatim from the go-sdk `hysteria2/` package (metadata = `{port, tls_pin, obfs_password}`).
- **Its config shape has no `outbounds`/`vnext`,** so `assertSafeV2RayConfig` and the v2ray
  DoH/pin transforms DON'T apply — it has its own `assertSafeHysteria2Config` (require
  `server` host:port, loopback socks5, a valid `tls.pinSHA256`; reject `acl`/`outbounds`),
  and `extractV2RayRemoteHost` was generalized to also read hysteria2's `server` field (for
  the tun2socks bypass route AND the kill-switch whitelist — the kill switch's
  `-d host -j ACCEPT` is protocol-agnostic, so QUIC/UDP works with no helper change).
- **Security gate = the TLS pin** (hysteria2's Reality analog): self-signed cert, safe only
  when pinned via `tls.pinSHA256`; a pin-less node → `buildHysteria2Config` throws → refund.
- Hysteria2 gets the `dns-set` (tun2socks needs a tunnel-routed resolver) but NOT the
  in-config DoH injection (v2ray-shaped only) → its DNS is plaintext-through-tunnel, like WG.
- **UUID-format gotcha (cost a live 500):** the SDK's `V2Ray.getKey()` returns the uuid as a
  16-BYTE ARRAY, which v2ray/xray's node field (`uuid.UUID`) accepts but hysteria2's
  (`UUID string`) rejects (JSON array → Go string = unmarshal error → HTTP 500). The
  hysteria2 handshake mints a `randomUUID()` STRING and reuses it as the config `auth`. Only
  use `getKey()` for protocols whose node peer field is `uuid.UUID`.

**AmneziaWG** (type 5) is a WireGuard fork with DPI-evasion params and rides the WG
**root/privileged path** (helper + daemon), NOT the tun2socks child-proxy path
(`isChildProxy` must never include it). What differs from plain WG:
- The SDK can't emit the obfuscation keys, so `src/main/amneziawg-config.ts`
  (`buildAmneziaWgConfig`, pure + unit-tested) builds the awg INI from handshake
  metadata (go-sdk `amneziawg/metadata.go`: `{port, public_key, s1..s4, h1..h4,
  i1..i5?}`). The handshake payload is the same `{public_key}` as WG — the SDK
  `Wireguard` class is used for keygen only. **Nodes never send `Jc/Jmin/Jmax`** —
  the client generates them (Jc [3,10], Jmin [64,256], Jmax [512,1024], the SDK's
  own defaults). Constraint re-checks (S1+56≠S2; H1-H4 all-zero or all distinct >4;
  I1-I5 tag grammar) throw → refund.
- Three bundled binaries in `resources/linux/v2ray/` — **`amneziawg-go`, `awg`,
  `awg-quick`** — built from source by `scripts/build-amneziawg.sh` at the exact
  commits the upstream node pins (no prebuilt amneziawg-go exists anywhere), SHA-pinned incl.
  the root-run awg-quick bash script. **No system-PATH fallback — root-run binaries
  fail closed** (both `vpn-manager.resolveAmneziaWgBinDir` and the daemon's).
- Helper verbs `awg-up <config> <bindir>` / `awg-down`; daemon ops `amneziawg_up` /
  `amneziawg_down` (additive — no protocol-version bump); `validate_awg_config` is
  the bash mirror of `assertSafeAmneziaWgConfig` (allow-list = WG keys + jc/jmin/
  jmax/s1-s4/h1-h4/i1-i5; PostUp/PreUp still rejected — awg-quick executes them as
  root identically).
- **The tunnel reuses iface `sntl0`** (awg-quick derives it from the config
  filename) so kill switch, `/proc/net/dev` traffic stats, the WG liveness monitor
  and daemon status work unchanged — BUT a userspace AWG `sntl0` is `type tun`, not
  `type wireguard`, so every "sntl0 ⇒ kernel WG" assumption branches on
  `sntl0IsKernelWireGuard()` (teardown via `ensureSntl0Down`, adoption, status,
  `detectOtherVpn` exclusion). DNS is owned by awg-quick (resolvconf) like wg-quick
  — no `dns-set`, no DoH.

**Connection modes.** `ConnectParams.mode` is `'tunnel'` (default, routes the whole
device) or `'proxy'`. Local-proxy mode applies ONLY to the child-proxy protocols
(v2ray/xray/hysteria2 — the ones with a local SOCKS5 listener at `127.0.0.1:1080`):
it spawns the core and stops there — no tun2socks, no root, no password prompt. The
branches skip `bringUpV2RayTunnel()` AND `applyPostConnectSettings()`, so **proxy mode
leaks by design** (only apps pointed at the SOCKS address are tunneled) and the
kill-switch setting is deliberately ignored. WG/AWG + `mode:'proxy'` throws. Keep
`isVpnActive()` meaning "system traffic is redirected" — it returns FALSE in proxy
mode, because routing is untouched and callers must not fall back to cached chain
data. The mode is runtime-only (never in `SavedSessionConfig`): auto-reconnect replays
`desiredMode`, a session-tab reconnect is always full-tunnel.

**DNS fallback.** wg-quick/awg-quick fail the whole bring-up when `resolvconf` is
missing. Those catch paths rethrow with the `DNS_PROVISION_FAILED` marker
(`src/shared/error-markers.ts`), and `CONNECTION_CONNECT`'s `dnsFallback` retries the
same config through `stripDnsLines()`. User consent only — auto-reconnect never strips
DNS, and the renderer states that system DNS then leaves the tunnel.

**Subscriptions.** `plan-service.ts` has `querySubscriptions` / `cancelSubscription` /
`updateSubscriptionPolicy` behind `SUBSCRIPTION_*` IPC, surfaced as "Manage
subscriptions" in the Plans tab. `RenewalPricePolicy` 0 (UNSPECIFIED) is the hub's own
"never renew" (`Subscription.RenewalAt()` returns the zero time for it; cancel sets it
to 0); 7 (ALWAYS) stays the default. Cancel marks the subscription inactive-pending —
it is NOT an instant refund, so don't word it as one.

v9.0.0 nodes expose a `service_metadata` array on `/info` (Xray Reality keys,
Hysteria2 obfs, transport variants) that the SDK's `NodeInfo` type lacks — the xray
and hysteria2 paths read the equivalent from the handshake response, not `/info`.
The amneziawg path likewise reads everything from the handshake response.

## Working Principles (for LLM contributors)

This codebase follows Karpathy-style discipline. Apply these in order of precedence:

1. **Think before coding.** State assumptions. If a simpler approach exists, say
   so. When multiple interpretations of a request exist, ask — don't pick silently.

2. **Simplicity first.** No code beyond what was asked. No abstractions for
   single-use callers. No configurability that wasn't requested (especially
   user-tunable knobs — defaults are a feature). No error handling for situations
   that can't happen given the IPC bridge's typing.

3. **Surgical changes.** Touch only what the task requires. Don't reformat
   adjacent code, don't "improve" comments, don't refactor neighbours. If you
   notice pre-existing dead code, mention it — don't delete it unless asked.

4. **Goal-driven execution.** Define how you'll verify success (build passes,
   feature works in app, specific commands), then loop until it does. "It should
   work" isn't a verification.

5. **Rule-of-three before extracting.** Two similar blocks: leave them. Three:
   then a helper is warranted. Premature abstraction is worse than duplication.

**Concrete antipatterns this repo has burned on** (extend as new ones surface):
- Settings keys for things only one user tunes. Hardcode the constant; if it
  needs to change, change the constant.
- Exported helpers without callers — dead exports drift over time and get
  imported by mistake. Unexport (or delete) the moment they go unused.
- Defensive per-key validation behind an already-typed IPC bridge. Validate
  shapes at the trust boundary; trust the types past it.
- Module-level mutable state used as a side channel between files (e.g. a
  setter exported from one module, called from another). Thread the value
  through a hook/prop instead.
- Single-use components extracted into their own files just because the parent
  file feels "long." Keep them inline until a second caller appears.
- Graceful degradation that silently weakens security — supply-chain integrity
  failures should throw, not fall back to less-trusted sources.

### Blockchain Details

- RPC endpoint: `https://rpc.sentinel.co:443` (configurable via settings)
- Address prefix: `sent`
- Gas price: `0.2udvpn`
- `Long` type (from `long` package) required for session IDs, gigabytes, hours — use `Long.fromNumber(n, true)` (unsigned)
- CosmJS pinned at 0.38.x for peer compatibility with the JS SDK

### Packaging

`electron-builder.yml` targets Linux only (AppImage + deb). The deb declares `wireguard-tools` and `policykit-1` as dependencies. Bundled v2ray/tun2socks binaries are in `resources/linux/v2ray/` and copied to `extraResources`.
