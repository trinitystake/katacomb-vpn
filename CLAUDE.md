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
- `node-normalize.ts`: the aggregator sends `null` for unknown text fields (`moniker`,
  `country`, `city`, `version`, `api`, `asn` — ~40 nodes each) while `SentNode` types them
  as `string`. `normalizeNodes()` runs on **every** way the feed enters the app
  (`fetchNodes`, `bootstrapNodesCache`) so that type is true downstream — don't re-add
  `|| ''` guards at read sites, and don't add a fourth entry point that skips it. A
  renderer `node.country.toLowerCase()` on a raw entry white-screens the app.
  It also owns `parseNodesPage()`, the **envelope** reader: on 2026-08-01 the feed's
  `data` went from a flat array of every node to `{nodes, pagination}`, **200 per page,
  ~10 pages** — and no `limit`/`perPage`/`pageSize` override is honoured, so the full
  list is inherently N requests. `fetchNodes` reads page 1, then fans the rest out in
  parallel (sequential would outrun the 60s refresh interval); a failed page fails the
  whole refresh, deliberately — a partial list replacing the full one is worse than the
  last good cache. Both shapes parse, so an upstream revert doesn't break it again.
  **Nothing in the renderer should call `nodesFetch()` just to read the list** — that's
  the whole paginated refresh; take `useNodesContext().allNodes`, which is already
  populated from cache + `NODES_UPDATE` pushes. Only a user-driven Refresh should fetch.
- `price-service.ts`: P2P→USD rate from CoinGecko (`ids=sentinel`), 15-min memory cache,
  **display only** — no transaction figure is ever derived from it, and failure returns the
  last value or null so the "≈ $x" hint just disappears.

### Privilege Escalation

VPN operations require root. Instead of raw `pkexec wg-quick`, the app uses a polkit helper:
- `resources/linux/katacomb-vpn-helper.sh` — installed to `/usr/local/bin/katacomb-vpn-helper`
- `resources/linux/com.katacomb.vpn.policy` — polkit policy for cached auth
- `resources/linux/postinstall.sh` — deb postinstall that deploys the helper + policy
- Helper commands: `up <config>`, `down`, `awg-up <config> <bindir>`, `awg-down`, `ovpn-up <config>`, `ovpn-down`, `tun-up <bin> <socks> <remote> <gw> <iface>`, `tun-down`, `killswitch-on <iface> <host> [dns]`, `killswitch-off`, `dns-set <ip>`, `dns-restore`
- WireGuard/AmneziaWG interface: `sntl0`. tun2socks: `sntl-tun`. OpenVPN: `sntl-ovpn`.

### Privileged daemon (deb) vs. pkexec fallback (AppImage/dev)

The `.deb` installs a **persistent root daemon** (systemd `katacomb-vpn-daemon`,
run via `ELECTRON_RUN_AS_NODE` on the bundled Electron) so connect/disconnect
**never prompt for a password**. The GUI (as the user) sends JSON ops over a Unix
socket at `/run/katacomb-vpn/daemon.sock`, owned `root:katacomb-vpn` **mode 0660**
— members of the group the postinst creates, not every local user
(`secureSocketPermissions`; the 0666 world-accessible fallback is dev-only, for when
the group doesn't exist). Group membership only applies to **new login sessions**, so
a fresh `.deb` install needs one log-out/log-in before the password-free path works —
until then the GUI can't open the socket and silently falls back to `pkexec`. The
AppImage and `npm run dev` have no daemon, so they fall back to the per-op `pkexec`
helper (one cached prompt).

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
- **Quota is METERED, never wall-clock.** The chain accrues a session's `duration` from
  the node's usage proofs, so a session bought and left idle accrues *nothing* — mainnet
  #53647217 sat 53 minutes at `duration: 0`. Both caps are therefore scored the same way,
  "what the chain settled before this connect + what this tunnel has done since":
  `baselineDurationSeconds + connectedSeconds` and `baselineBytes + liveRxBytes`.
  `connectedAtMs` (set in `startQuotaWatchdog`, before its timer guard) is the second
  half of the time sum and is surfaced as `ConnectionStatus.connectedAt` so the Sessions
  card draws the identical number. **Never reintroduce `Date.now() - startAt` as a usage
  measure** — it reads an untouched paid hour as spent and the watchdog then destroys it.
- **Watch the paid quota.** Nothing else does: `startRootTunnelMonitor` polls whether the
  INTERFACE exists, and a node that has stopped forwarding leaves it up, so an exhausted
  session used to sit on a dead tunnel. Every tunnel bring-up calls `startQuotaWatchdog()`
  (all six protocols + proxy mode + the reconnect success path — 7 sites); it scores
  `evaluateQuota` (pure, in `connect-decisions.ts`) every 15 s and hands expiry to
  `handleQuotaExpiry`, which repeats `performDisconnect`'s epoch-bump-before-the-lock
  stand-down so the reconnect timer can't resurrect a session the chain has closed.
  Teardown is unconditional; the **kill-switch setting** decides whether the DROP-all
  chain stays armed afterwards (`trafficBlocked` is read back off `isKillSwitchArmed()`,
  never off the setting). Never auto-renew — expiry always ends in a disconnect.
  That "expired, traffic blocked" state deliberately does NOT survive a restart:
  `healStrandedKillSwitch()` reverts it at next launch and must not be weakened to
  preserve it.
- **A session row is not necessarily live.** `getActiveSessions()` returns `'active'` AND
  `'inactive_pending'` — the state a session enters on its own when its quota runs out —
  so it can be labelled rather than vanishing mid-error. `decodeSession` maps the real
  enum (1/2/3), not `=== 1 ? 'active' : 'inactive'`. Anything offering a per-session
  action must gate on `status === 'active'`: `MsgCancelSession` only accepts status 1, and
  `endSession` swallows exactly that guard (`isSessionNotActive`) for the poll-vs-click
  race. Anything **counting** sessions must gate on it too (the Sessions header and the
  tab badge do) — a settling row is not an active session.

### Session lifecycle (verified against live mainnet, not inferred)

- **Ending a session is two phases, and cancel/expiry are ONE path.** `x/session` has only
  `MsgCancelSession` / `MsgUpdateSession` (the node's proofs) / `MsgUpdateParams` — there
  is no settle or refund message. Phase 1 (the user's End, or the quota running out) sets
  `active → inactive_pending` and stamps `inactiveAt = now + statusTimeout`; phase 2 is
  the EndBlocker settling it there (`EventEnd`). **So End is NOT an instant refund** —
  it just performs phase 1 by hand. Don't word it as one.
- **`statusTimeout` is 7200s (2h)** on mainnet — a governance param, so read it rather
  than hardcoding if it ever matters numerically.
- **`inactiveAt` means two different things by status.** On an `inactive_pending` row it
  is fixed at `statusAt + statusTimeout` — when the chain settles it. On an `active` row
  it is a **sliding idle deadline that rolls forward as the node reports**: #53647217 was
  watched moving 74.5 min in an hour, landing at `startAt + 3.24h`, so it is emphatically
  NOT `startAt + statusTimeout`. Stop using a session and it is reaped 2h later. Since
  quota is metered, that is the only clock running on an idle session — the card shows it
  as "Expires in X if unused".
- **The chain DELETES settled sessions.** `sessionsForAccount` returned
  `pagination.total = 2` for an account with a long purchase history, so nothing
  accumulates and `getActiveSessions`' `limit: 20` is in no danger of being crowded out.
  Expired rows leave the list on their own; the app deletes nothing.
- Settlement pays the node for actual usage and returns only the remainder, so an
  **expired** session (quota fully consumed by definition) refunds ~nothing. The card
  deliberately promises no refund.

### Vite Bundling (Critical)

`electron.vite.config.ts` must bundle the entire CosmJS/dVPN SDK dependency tree (listed in `DEPS_TO_BUNDLE`). Electron loads main process output as CJS, but these deps have ESM-only transitive dependencies (`@scure/base`, `@noble/*`). Only `bufferutil` and `utf-8-validate` are externalized (ws optional native deps that gracefully no-op).

**If you add a new `@cosmjs/*` or dVPN SDK dependency, add it to `DEPS_TO_BUNDLE` or the build will fail at runtime with `ERR_REQUIRE_ESM`.**

### Renderer Conventions

- Hooks in `src/renderer/hooks/`: `useWallet` (balance polling 300s), `useNodes` (node fetch + filter/sort, 60s refresh), `useConnection` (status polling 3s). Polling intervals are hardcoded per-hook — not user-tunable.
- Node table uses `@tanstack/react-virtual` for virtualized rendering (5000+ nodes).
- **The node list is NOT chain data** — it comes from `api.sentnodes.com` over plain
  HTTPS, so a bad `rpcEndpoint` never explains an empty node table (and picking a
  faster RPC never fixes one). `NodesContext` must stay *active*, not passive: it
  subscribes to `NODES_UPDATE` before its first read and fetches for itself when
  `nodesGetCached()` comes back empty. It used to do one cached read and then wait
  for a push, so a broadcast that landed before the listener existed — main's first
  fetch fires at startup, racing window creation — stranded the "Loading nodes…"
  spinner until the app was restarted. Its `error` surfaces as a Retry pane, but
  only when there is no list at all; a failed refresh over a cached list just makes
  it stale, and blanking the table would be worse.
- BIP-39 validation lives in `src/shared/mnemonic.ts` (`checkMnemonic`, pure + unit-tested):
  word list, word count and **checksum**, re-run on every keystroke so the Import button
  only enables on a phrase that will actually import. It uses `@scure/bip39` — the package
  main generates seeds with — never the `bip39` package's `validateMnemonic`, whose dynamic
  require fails in Vite's renderer bundle. `MnemonicInput` imports `check.phrase` (NFKD,
  lowercase, single-spaced), not the raw textarea value: that is the form the checksum was
  verified against and the only one CosmJS's `EnglishMnemonic` accepts.
- **Dark-only** — bg `#16181d`, accent `#e1bc99`. There is deliberately no theme switch:
  `tokens.css` `:root` holds the only semantic tokens, and components read those (never
  primitives, never a `dark:` variant). Don't reintroduce a `.dark` selector.
- **The palette is derived from the app icon** (`build/icons/1024x1024.svg`) and both
  primitive ramps are sampled from it: `gunmetal-*` extends the icon's charcoal at its own
  hue (`gunmetal-850` IS `#1e2127` verbatim), `bronze-*` is its gradient stops verbatim.
  Regenerate the PNGs with `node scripts/build-icons.mjs` after editing the SVG, and keep
  `AppLogo.tsx` (the same paths, inlined) in step.
  - **Every fill in this palette is a light colour**, so filled controls take
    `text-text-on-accent` (dark) — `text-white` on the accent is 1.8:1. That's why
    `.btn-primary`/`.btn-danger` set a dark label and `Spinner` just inherits `currentColor`.
  - Accent and status hues are separated by **saturation, not hue**: the accent is the only
    pale/desaturated colour, the status hues are vivid. The tightest pair (accent vs danger)
    is ΔE 43, so `danger` must keep its slightly cool cast — warming it toward terracotta
    collapses it into the bronze.
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

**All six protocols are connectable: WireGuard (1), V2Ray (2), OpenVPN (3), XRAY (4),
AmneziaWG (5), Hysteria2 (6).** Only type 0 (unknown) is not. The main-process IPC
guards (`nodeType` not in `{1,2,3,4,5,6}` → throw) plus `isProtocolSupported` in the
connect UI are the enforcement. Any *future* protocol needs its own binary, config
generation/validation, and (for root-run ones) a privileged daemon op.

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
  **Never build these natively** — they are the only shipped binaries we compile,
  so they are the only ones that can inherit the maintainer's glibc. A native
  build on Ubuntu 24.04 rewrites `strtoul`/`strtoll` into `__isoc23_*`, pinning
  `awg` to GLIBC_2.38 and making it fail to load on Debian 12 (2.36) and Ubuntu
  22.04 (2.35) — with no fallback, per the fail-closed rule above. The script
  therefore builds `amneziawg-go` with `CGO_ENABLED=0` (fully static) and `awg`
  inside `debian:bullseye` (glibc 2.31), then asserts the resulting floor so a
  toolchain bump can't regress it silently.
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

**OpenVPN** (type 3) also rides the **root/privileged path** (`isChildProxy` must never
include it). The wire shape is identical at go-sdk master and the commit node v8.3.1
pins, so one implementation covers the whole network:
- Handshake request is `{uuid}` as a **16-BYTE ARRAY** (node field is v2fly
  `uuid.UUID` = `[16]byte`) — the opposite of hysteria2's string field. The uuid is
  only the peer id: the node's PKI *issues the client certificate*, so the response is
  `{metadata:[{port, protocol:"tcp"|"udp", ca:b64(DER), tls:b64(256-byte tls-crypt)}],
  cert:b64(DER), key:b64(DER PKCS#8)}`. There is **no `addrs`** in the body (the
  OpenVPN server pushes the tunnel IP) — the endpoint comes from `result.addrs`.
- `src/main/openvpn-config.ts` (`buildOpenVpnConfig`, pure + unit-tested) emits ONE
  self-contained `.ovpn` with **inline `<ca>/<cert>/<key>/<tls-crypt>` blocks** — not
  the go-sdk's config-plus-four-PKI-files layout. That is what lets it live in
  `SavedSessionConfig.configString` (reconnect works) and be shipped to the daemon as
  content. Every blob is base64-**decoded and re-armored by us**, so no node byte can
  become a directive; `ca`/`cert` must parse as X.509 and `key` as a private key
  (node:crypto), and the tls-crypt key must be exactly 256 bytes — all throw → refund.
  The endpoint is IPv4-pinned (a hostname `remote` would deadlock on reconnect with the
  kill switch armed). `management 127.0.0.1 2323` from the upstream template is dropped.
- **The security boundary is the directive allow-list**, not a blocklist:
  `up`/`down`/`route-up`/`ipchange`/`client-connect`/`tls-verify`/
  `auth-user-pass-verify`/`learn-address`/`plugin`/`script-security` all run code as
  root and are rejected by omission (`assertSafeOpenVpnConfig`, mirrored in bash by
  `validate_openvpn_config`). It also **requires** `client` + all four PKI blocks and
  rejects a repeated `remote` (the kill switch only whitelists the first).
  Operational flags are deliberately NOT allowed in the file — the helper passes
  `--script-security 0 --dev sntl-ovpn --daemon --writepid --log --connect-*` on the
  command line *after* `--config` (openvpn is last-one-wins), so they can only come
  from us. **Invariant: anything the guard rejects is supplied by the helper.**
- **Distro binary, not bundled**: `deb.depends` gains `openvpn`, resolved from an
  absolute allow-list (`/usr/sbin/openvpn`, …) — never `$PATH` under root. This is the
  plain-WireGuard model (system `wg-quick`), chosen over vendoring because openvpn is a
  TLS client and distro packaging ships the OpenSSL CVE fixes.
- **Own interface `sntl-ovpn`** (not sntl0): a userspace AWG sntl0 is already
  `type tun`, so a third tun there would make adoption/teardown ambiguous
  (`awg-down` ≠ `ovpn-down`). Costs only `traffic-stats`' third fallback,
  `daemon-core.checkStatus`'s `ovpnUp`, the `detectOtherVpn` exclusion and the
  `vpnIface` ternary — all two-way, no new discriminator.
- **openvpn stays resident** (wg-quick/awg-quick exit), so `ovpn-up` daemonizes it and
  then **waits for proof**: `sntl-ovpn` present AND "Initialization Sequence Completed"
  in the log, else it kills the pid and returns the log tail (that text reaches the
  connect modal). `ovpn-down` kills the pid, waits, then deletes the link. Liveness is
  interface polling (`startRootTunnelMonitor`, shared with WG/AWG) — there is no child
  process to watch, since root owns it.
- Helper verbs `ovpn-up <config>` / `ovpn-down`; daemon ops `openvpn_up` /
  `openvpn_down` (additive — no protocol-version bump).
- **DNS is ours, not the tunnel's.** Applying the server's pushed DNS would need an
  `--up` script (the LPE vector), so OpenVPN joins the `dns-set` group with
  v2ray/xray/hysteria2 — plaintext-through-tunnel, and NOT the DoH group (that
  transform is v2ray-JSON-shaped). Consequently there is **no `DNS_PROVISION_FAILED`
  path**: `dnsFallback`/`stripDnsLines` stay WG/AWG-only.

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
`renewSubscription` / `updateSubscriptionPolicy` behind `SUBSCRIPTION_*` IPC, surfaced
as "Manage subscriptions" in the Plans tab. `RenewalPricePolicy` 0 (UNSPECIFIED) is the
hub's own "never renew" (`Subscription.RenewalAt()` returns the zero time for it; cancel
sets it to 0); 7 (ALWAYS) stays the default. Cancel marks the subscription
inactive-pending — it is NOT an instant refund, so don't word it as one. Renew is
plan-only (a node subscription has no plan price to charge). `SubscriptionManager` takes
an `onSubscriptionsChanged` callback: it must refresh `usePlans().allocations` too, or
the allocations footer and `ConnectionModal` keep offering a cancelled subscription for
up to the 120 s poll. `subscriptionShare` exists in the SDK and is deliberately unwired.

### Provider console (acting AS a provider)

The Plans tab is the consumer side; the **Provider** tab (5th, hidden unless the
ACTIVE wallet's `providerMode` is set or that wallet already has a provider on
chain — see `useProvider().visible`) is the producer side. `provider-console.ts`
holds the ops, `provider-msgs.ts` the pure/unit-tested message builders,
`lease-query.ts` + `protobuf-query.ts` the queries the SDK doesn't provide.

**`providerMode` is per-wallet, on the `WalletEntry` in `wallets-index.json` — NOT
an app setting.** As one global boolean it followed the user onto every seed they
imported after first switching it on, offering a provider console to wallets that
have none. Written only via `PROVIDER_MODE_SET` (which targets the active wallet)
and read back off the wallet entry, so there is no getter; `migrateProviderModeToWallet()`
in `settings.ts` carries the old global value onto the active wallet once and
deletes the key. Don't re-add it to `AppSettings` — the chain half of `visible`
was always per-wallet and correct, and the global flag was the only leak.

**Chain facts (verified against sentinelhub v12 + live mainnet, not inferred):**
- Provider address = the account's 20 bytes re-encoded with the `sentprov` prefix
  (`toProviderAddress`). Every provider/plan/lease msg's `from` is that address, but
  `GetSigners()` converts back, so `signAndBroadcast(accountAddress, …)` still signs.
  `MsgRegisterProviderRequest` is the ONE exception — its `from` is the account address.
- The registration deposit goes to the **community pool** (`FundCommunityPool`), so it
  is spent, not escrowed. It is `0udvpn` on mainnet today but is a governance param —
  read it live, never hardcode.
- Provider and plan both land **INACTIVE**; activation is a second tx, and a plan can't
  activate under an inactive provider.
- **`MsgLinkNode` requires an active lease** (`HasAnyLeaseForNodeByProvider`). Adding a
  node to a plan is always lease-then-link. `MsgStartLease` escrows
  `hourlyPrice × maxHours` (live params: min 1 h, max 720 h), pays the node hourly, and
  `MsgEndLease` refunds the remainder and unlinks. Set the lease's renewal policy to 7
  so it doesn't silently expire and drop the node — that's why there's no manual renew.

**SDK 2.0.4 defects worked around here — do NOT "simplify" back onto the SDK:**
- `planCreate()` sends `{gigabytes, hours}`; the v3 msg wants `{bytes, duration}`. Both
  fields are dropped at encode time. `buildCreatePlanMsg` builds the EncodeObject by
  hand; `provider-msgs.test.ts` asserts the round-trip AND asserts the SDK is still
  broken, so the guard fails loudly once upstream fixes it. (`nodeRegister`'s
  `remoteUrl` vs `remoteAddrs` has the same bug — irrelevant, node registration is
  signed by the node's own key on the dvpnx host, never by this wallet.)
- **`x/lease` has no SDK module** — protobufs ship under `dist/protobuf/sentinel/lease/v1/`
  but `SentinelRegistry` omits the type URLs. `PROVIDER_REGISTRY` spreads
  `SentinelRegistry` and adds them; it MUST be passed to `connectWithSigner`, whose
  `Object.assign({registry: default}, options)` *replaces* rather than merges.
- **`provider.params()` targets `sentinel.provider.v2.QueryService`, which the chain does
  not implement** ("Unimplemented: unknown request"). `getProviderDeposit` goes through
  the v3 service via `withProtobufQuery`. v2 *does* still serve QueryProvider/QueryProviders,
  which is why the SDK's other provider queries work.
- `plansForProvide` (sic) never sends a status, so it defaults to `STATUS_UNSPECIFIED` —
  which the hub treats as "no filter". That is exactly what "my plans" needs, since a
  freshly created plan is inactive. Confirmed live: it returns statuses 1 and 3.
- Deep SDK imports need the `.js` extension (no `exports` map; Node's native test runner
  resolves them as ESM).

**A missing record is THROWN, not empty.** A single-address lookup (`provider.provider`,
`node.node`) for something that doesn't exist fails with gRPC NotFound (code 22), which
CosmJS raises as an Error — so "I haven't registered a provider yet", the normal state
for nearly every wallet, arrives as a crash unless translated. `isChainNotFound`
(`tx-utils.ts`, unit-tested against the real error text) is the narrow matcher; anything
else must keep throwing, or an unreachable RPC gets reported as "you have no provider".
Don't assume a chain read returns undefined for a missing key — check it live against an
address that really is absent, not just one that exists.

**Per-plan counters** (`getPlanSubscriberStats`, `PROVIDER_PLAN_STATS`): the subscription
total is the chain's own `pagination.total` (one `countTotal` request — exact and cheap),
but the ACTIVE count has no counter and must be scanned page by page, so it stops at
`SUBS_MAX_SCAN` and reports `truncated` — mainnet plan 36 has 800k+ subscriptions from a
single account. The node count reuses `listNodesForPlan`, whose 10-minute cache is
invalidated (`invalidatePlanNodes`) after our own link/unlink so the console doesn't
re-read the pre-link answer.

**Design invariant:** the console is a **stateless view over chain state**. Every action
is one tx and the multi-step flows (register→activate, create→activate, lease→link) are
resumable because the middle state lives on chain — a failed link leaves the node under
"Leased, not linked" with a Link button. Don't add a local wizard that tracks progress.
Money figures (deposit, lease total) are computed in main from on-chain values and never
taken from the renderer, the same rule `cachedPlanCost` follows.

v9.0.0 nodes expose a `service_metadata` array on `/info` (Xray Reality keys,
Hysteria2 obfs, transport variants) that the SDK's `NodeInfo` type lacks — the xray
and hysteria2 paths read the equivalent from the handshake response, not `/info`.
The amneziawg and openvpn paths likewise read everything from the handshake response.
(The only two OpenVPN nodes on the network are v8.3.1 and don't expose it at all; one
reports `service_type: "openvpn"` at its ROOT path, which is what the preflight needs.)

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

`electron-builder.yml` targets Linux only (AppImage + deb). Bundled binaries live in
`resources/linux/v2ray/` and are copied wholesale to `extraResources`.

**Every custom key in `electron-builder.yml` REPLACES its default, never merges.**
This cost three of the four defects in the portability audit: `deb.depends` dropped
all nine of Chromium's GUI libraries, `deb.recommends` dropped `libappindicator3-1`,
and `afterInstall` dropped electron-builder's own postinst (the AppArmor profile and
the chrome-sandbox SUID logic — `resources/linux/postinstall.sh` now begins with that
generated block verbatim, then appends ours). Each site says so inline; if you add a
custom key, re-add whatever the default supplied.

**The AppImage runs UNSANDBOXED on Ubuntu 24.04+ — this is known, documented, and not
to be "fixed" in code.** With `kernel.apparmor_restrict_unprivileged_userns=1`,
electron-builder's `AppRun` probes `unshare -Ur true`, fails, and appends
`--no-sandbox` rather than crashing (verified live, both sysctl states: flag present at
1, absent at 0). An AppImage can't install an AppArmor profile and can't use a SUID
`chrome-sandbox` (squashfs is `nosuid`), so it has neither mechanism Chromium accepts.
The `.deb` is unaffected — its profile makes the probe succeed. The README steers
Ubuntu users to the deb; don't patch `AppRun` (diverges from upstream) and don't add
`--no-sandbox` anywhere yourself.

**Verify packaging by installing, not by reading config** —
`scripts/verify-deb-portability.sh` (interactive, needs root, pauses for GUI steps)
does the full install/launch/connect/upgrade/remove cycle, plus an `appimage` phase for
the sandbox check above; re-run it after touching
`electron-builder.yml`, either maintainer script, or the systemd unit. The AppArmor defect was
invisible in development because Linux Mint ships
`/etc/sysctl.d/20-apparmor-mint.conf` setting `kernel.apparmor_restrict_unprivileged_userns=0`,
while stock Ubuntu 24.04+ leaves it at 1. With it at 1 and no profile installed, the
app dies with `FATAL … chrome-sandbox … mode 4755` before a window ever appears.
Flip the sysctl to reproduce stock behaviour on this hardware.

Licensing (required for any public distribution): the app is **GPL-3.0-or-later**
(`LICENSE`, `package.json` `license` → the deb's `License:` field). All six bundled
binaries carry their upstream text as `resources/linux/v2ray/LICENSE.<name>`, and
`THIRD-PARTY-LICENSES.md` records each one's pinned version/commit plus the GPL-2.0
source offer for `awg`/`awg-quick` (the only copyleft binary — `tun2socks` v2.6.0 is
MIT, despite the v1 series having been GPL-3.0). `LICENSE` and `THIRD-PARTY-LICENSES.md`
ship via explicit `extraResources` entries so the notices travel with the binaries.
**When bumping a bundled binary, re-check its LICENSE at the new tag** — it can change
between versions.
