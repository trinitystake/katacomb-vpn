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
- `multihop-config.ts`: pure builder + grader for two-hop chains (`buildMultihopConfig`,
  `selectHopEntry`, `classifyHopEligibility`, `normalizeTlsPin`). Electron-free and
  unit-tested; see the multihop section below for the invariants it enforces.
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
  **async** because of the socket round-trip — and the `pkexec` fallback must stay
  async too. It was `execFileSync`, which blocks the Electron main process for the
  whole call, and on that path the call is a polkit dialog: nothing in main runs
  until the user answers it or the 60 s timeout fires (measured: zero event-loop
  ticks over a bare `sleep 2`). Live symptom, 2026-08-16: Disconnect froze the
  entire app, then reported the kill switch could not be turned off, leaving no
  internet and no way to retry. Never make a privileged call synchronous.
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

**And the channel that delivers a node's keys authenticates nothing.** The SDK's
handshake POST and `node-tester.ts` both set `rejectUnauthorized: false`, so the TLS pin,
the Reality public key, the port and `addrs` all arrive over a connection that accepts any
certificate — and those are precisely what the tunnel's confidentiality then rests on. An
on-path attacker (the ISP) can answer the handshake with its own metadata and become the
node; `normalizeTlsPin` and the config builders will faithfully pin the attacker's
certificate. There is **nothing on chain to verify against**: `sentinel/node/v3/node.proto`
gives `Node` only `{address, gigabyte_prices, hourly_prices, remote_addrs, inactive_at,
status, status_at}` — no certificate, fingerprint or public key. Trust-on-first-use
pinning is therefore the only option that exists, and it is deliberately **not
implemented** (it changes the failure mode of every connect and can't be validated without
live nodes). So never write UI copy implying that the TLS/Reality wrapping defeats the
local network; multihop's threat-model block states the limit instead.

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
- **Pin every node endpoint to an IPv4 literal, for EVERY protocol.** Nodes advertise
  themselves by hostname on chain (`remoteAddrs: ["helen.busur.cc:63115"]`), and two
  separate things break on that: the tunnel re-resolves it *through itself* (the v2ray
  DNS deadlock), and the kill switch has no IP to whitelist. v2ray/xray go through
  `pinV2RayNodeAddresses`, hysteria2/openvpn pin inline, and WireGuard/AmneziaWG go
  through `pinWireguardEndpoint` (pure, unit-tested) in all three connect paths —
  pin BEFORE the config-guard assert, so what is validated is what gets written.
  **The kill switch is never armed without a real endpoint IP**: `-d 0.0.0.0/32 -j ACCEPT`
  matches nothing, so the DROP-all rule swallows the tunnel's own outer UDP and the
  connection dies with the interface still up and the UI still saying "connected". That
  `|| '0.0.0.0'` fallback is what caused it; `applyPostConnectSettings` now skips arming
  and sets `killSwitchFailed`, and both the daemon and the bash helper reject `0.0.0.0`
  outright. Symptom to recognise: bytes out, ~zero bytes in, no DNS, IP unchanged.
- **A node's DNS list is untrusted input, and its FIRST entry is the one that bites.**
  Nodes push a list (`DNS = 10.8.0.1, 1.0.0.1, 1.1.1.1`), wg-quick hands the whole thing
  to resolvconf, and systemd-resolved starts at entry one. When that entry is the node's
  own in-tunnel resolver and it never answers, every uncached lookup costs the glibc
  ceiling of 10s (`timeout:5` x `attempts:2`) until resolved fails over and PINS a working
  server. Measured live 2026-08-19: ~34s of dead DNS after connect, then instant forever,
  because resolved's server choice is sticky for the life of the link — which is why it
  reads as a one-time glitch, is blamed on "the first page being slow", and returns on the
  next connect to the same node. `tcp-noDNS` stayed flat throughout, so routing was never
  involved. The fix is `replaceDnsLines` (pure, unit-tested), applied on the WG/AWG connect
  paths when `dnsResolver !== 'system'`: the chosen resolver REPLACES the node's list
  rather than being appended or reordered, because the node's resolver sees every name the
  user looks up. Do NOT "simplify" this into the `dns-set` path — wg-quick owns
  resolv.conf for this family, and overriding it there strands DNS on the node resolver
  after disconnect. `wireguardResolverIp()` is deliberately NOT
  `effectiveV2RayResolverIp()`: 'system' keeps the node's list, since the kill switch
  accepts everything out the tunnel interface and needs no public substitute. The rewrite
  happens BEFORE the config-guard assert, and `config-guard.test.ts` pins that the
  rewritten shape still passes both guards.
- **`wg-quick down` ALWAYS fails for our tunnel, so its cleanup is ours to do.** It
  resolves an interface name against `/etc/wireguard`, and our config lives in
  `SECURE_TMPDIR` — so the helper's `down` verb falls through to `ip link delete` on every
  disconnect (and `awg-down` only ever did that). That removes the interface and leaves
  wg-quick's policy-routing rule PAIR behind (`not from all fwmark 0xca6c lookup 51820` +
  `from all lookup main suppress_prefixlength 0`), one pair leaked per connect: measured
  three pairs against a single live `sntl0`. `cleanup_wg_rules` in the helper repairs it,
  and its scoping is the load-bearing part — it runs only once NO tunnel that could own
  the rules is left, deletes a fwmark table only inside wg-quick's own allocation range
  (so another VPN's table is untouched), and bounds every loop. Anything else that tears
  a tunnel down by deleting the link inherits this obligation.
- **Preflight before paying.** The three session-creating handlers call
  `preflightConnect(nodeType, apiField)` BEFORE the tx: `protocolRuntimeError()`
  (binaries present + SHA-verified; WG/AWG also need `canEscalatePrivileges()`), then
  the node's own `service_type` — fetched from its ROOT path, `/info` 404s — mapped via
  the pure `serviceTypeToNodeType()` and required to match the aggregator's type.
- **The connect flow rides ONE RPC connection, and its handshake retries a 404 —
  nothing else.** `chain-clients.ts` owns the speed path: `resolveRpcBase` follows the
  endpoint's 307/308 redirect once per launch (the default rpc.sentinel.co redirects
  EVERY request to another host, ~100ms each; fail-open, never persisted, never shown
  in the UI), and `openChainFlow` builds the query + signing clients over a single
  CometBFT connection with a 1s broadcast poll (blocks are ~3.6s measured, and CosmJS
  sleeps a full poll interval before its FIRST getTx — the 3s default discovered every
  committed tx late). Ownership rule: the handler that opens a flow disconnects it in
  its `finally`, and anything handed a flow client (`subscribeToNode`, `subscribeToPlan`,
  `startSessionWithExistingSubscription`, `getBalance`, `getActiveSessions`,
  `queryNodeOnChain`) must never disconnect a client it was given. The purchase resolves
  the handshake endpoint from the node row it already fetched for prices, BEFORE the tx
  (an unresolvable node now costs nothing instead of a refund), so
  `establishSessionOrRefund` only queries when no `remoteUrl` was passed. Its handshake
  retries on HTTP 404 ONLY (`shouldRetrySessionHandshake`, bounded at 2 x 2s): dvpnx's
  handler validates the session against the chain LIVE, so a 404 moments after our tx
  commits is the node's own RPC lagging ours, not a verdict — while every other status
  refunds immediately, and the RECONNECT path's handshake semantics (409 = normal,
  404 = session gone) are deliberately untouched. All three session-creating broadcasts
  now really do set a `timeoutHeight` (the plan paths used to skip it).
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
  session used to sit on a dead tunnel. Every successful bring-up funnels through
  `finalizeTunnelConnect()` (ipc-handlers.ts), which calls `startQuotaWatchdog()` — all
  six protocols, proxy mode and the reconnect success path end there; it scores
  `evaluateQuota` (pure, in `connect-decisions.ts`) every 15 s and hands expiry to
  `standDownSession`, which repeats `performDisconnect`'s epoch-bump-before-the-lock
  stand-down so the reconnect timer can't resurrect a session the chain has closed.
  Teardown is unconditional; the **kill-switch setting** decides whether the DROP-all
  chain stays armed afterwards (`trafficBlocked` is read back off `isKillSwitchArmed()`,
  never off the setting). Never auto-renew — expiry always ends in a disconnect.
  That "expired, traffic blocked" state deliberately does NOT survive a restart:
  `healStrandedKillSwitch()` reverts it at next launch and must not be weakened to
  preserve it.
- **An interface is not a tunnel — prove it carries traffic.** `wg-quick up` reports
  success whether or not the node ever answers a handshake, so nothing about a live
  `sntl0` implies a working tunnel. Mainnet #53647217 was verified dead by sending a
  well-formed WireGuard initiation with its own saved keys and getting silence, hours
  after the node stopped reporting usage — while the app said "Connected" and the
  watchdog billed the paid hour against it. Two enforcement points, both required:
  - `assertTunnelCarriesTraffic()` after **every** bring-up (the WG/AWG/OpenVPN
    branches, `finishChildProxyConnect` for the three child-proxy protocols, and the
    auto-reconnect body; skipped in proxy mode, which changes no routing). It runs
    AFTER `applyPostConnectSettings` on purpose — the kill switch is one of the things
    that can strangle a tunnel — and passes on **either** a successful probe fetch
    **or** inbound bytes on the interface, because the probe host being down is not
    the tunnel's fault. Failure tears down and throws, leaving the stashed config
    intact so "Retry connection" still works.
    **Two things that check costs, both learned from a dead chain that reported
    "connected":** the probe must include an **IP-literal** target
    (`TUNNEL_PROBE_IP_URL`), because the hostname one resolves THROUGH the tunnel and
    a dead tunnel breaks DNS — so its failure is indistinguishable from the probe host
    being down; and the byte fallback needs a real floor
    (`TUNNEL_PROBE_MIN_RX_BYTES`), because `rx > before.rx` is not a test: when xray
    cannot reach the exit hop it fails each relay locally and tun2socks writes the
    resets back into the tun, so rx climbs while nothing works (~92 KB out / ~28 KB
    back over two minutes, none of it real).
  - `checkTunnelStalled()` on the quota loop (all six protocols, unlike the root-only
    interface monitor), via the pure `isTunnelOneWay`. **Both** a tx floor and a
    silence window are required: an idle tunnel also receives nothing, and that is
    not a fault. It stands down through `standDownSession('stalled')` rather than
    `attemptReconnect` — with auto-reconnect off, that gate returns silently and
    leaves the dead tunnel up, which is the state being detected.
- **…and a live child proxy is not a tunnel either. Two predicates, two questions.**
  `getConnectionStatus().connected` means *traffic is being carried*;
  `isProxyChildAlive()` means *the spawned core survived startup*. They were one
  predicate, and that is a lie in exactly one window. In PROXY mode the core is the
  whole connection, but in TUNNEL mode the redirection **is** tun2socks, and
  `connectV2Ray`/`connectXRay`/`connectHysteria2` spawn the core and only THEN await
  `tun-up` through polkit. So for as long as the password dialog stands open the child
  is alive, no TUN exists, and every packet still leaves by the physical NIC. Live on
  1.0.0: green "Connected" banner, session card badged live, and the user's real home
  IP on screen, before the password was typed. `IpDisplay` made it stick — it refetches
  1.5 s after `connected` flips and then stops polling while connected, so it cached the
  untunneled answer until a manual refresh. The pure `isChildProxyCarryingTraffic`
  (`connect-decisions.ts`, unit-tested) is the gate; `isVpnActive()` keeps its
  documented meaning, "system traffic is redirected", which is FALSE in that window.
  **It was invisible until `runPrivileged` went async** (the fix for the disconnect
  freeze): while it was `execFileSync` the main process could not turn the event loop
  during the dialog, so the 3 s status poll never observed the gap. WireGuard was never
  affected, its branch checks for the interface. **And the one helper that
  spawns-waits-and-asks whether the core survived** (`assertProxyChildStarted`, reached
  from the reconnect body and, via `finishChildProxyConnect`, the v2ray/xray/hysteria2
  connect branches) MUST use `isProxyChildAlive()` — pointed at the traffic predicate it
  fails *every* tunnel-mode connect with "process exited immediately after starting",
  which is worse than the bug.
- **Reconnect re-handshakes first, and a 409 back means the node kept the RECORD —
  it says nothing about the PEER.** `CONNECTION_RECONNECT` calls `performHandshake`
  for the session before falling back to `SavedSessionConfig.configString`. Read
  against the node's source (`sentinel-dvpnx`), what that buys is narrower than it
  looks: `api/handshake/handlers.go` looks the node's own database up by session id
  **first** and answers **409 Conflict** if a record exists (error codes 1 "maximum
  peer limit", 3 "session already exists in database", 4 "same peer request" — all
  409). It never re-issues a peer. And `workers/session.go` drops the **peer** on four
  triggers (max bytes, max duration, `session == nil`, chain status not active) but
  deletes the **record** on `session == nil` alone. So "record present, peer gone" is
  an ordinary state — and a **permanent** one: the node's entire API is `GET /` and
  `POST /`, with no route that clears a stale record, so nothing the client does
  brings the peer back while the chain session lives. Every session the UI offers a
  reconnect for is chain-active, so **409 is the normal outcome** and the renewal only
  wins when the node lost its own record (reset/rebuilt DB). Keep it — it is one HTTPS
  call. **Do not read a 409 as proof the peer survives** (this doc said so for one
  commit; mainnet #53670474 disproved it — a WireGuard initiation built from the saved
  config's own keys drew no reply while the node's API was up serving four peers).
  What the fallback path must do instead is clear `nodeIssuedFreshPeer`, so that if
  `assertTunnelCarriesTraffic` then finds nothing coming back, `deadTunnelMessage`
  tells the user the session is finished rather than sending them round the
  reconnect loop that just failed. Log the conflict as information;
  `console.error(err)` on an AxiosError prints ~600 lines of socket internals and
  reads like a crash (`describeNodeApiError` in `connect-decisions.ts` reduces any
  node failure to status + the node's own message, which lives at
  `response.data.error.message` — go-sdk `types.Response`).
  Deliberately NOT wrapped in `establishSessionOrRefund`: there is no new session to
  refund, and cancelling the user's live session over a briefly unreachable node is
  the opposite of the intent.
- **Usage time accrues only while the tunnel is alive.** `connectedSecondsAlive()`,
  not `Date.now() - connectedAtMs`, feeds both the quota watchdog and
  `rememberSessionUsage` — it clamps at `aliveUntilMs`, the last confirmed sign of
  life. The chain meters `duration` from node proofs and a stalled node submits none,
  so counting wall-clock past that point bills the user for time they were never
  charged for, and (being a floor under the gauge) would end a session with paid time
  left. `lastSessionUsage` is **persisted** (`session-usage.json`) so the gauge
  doesn't reset to a not-yet-settled chain figure on relaunch; it is only ever a
  FLOOR, the chain overtakes it and wins, and entries are pruned once their session
  leaves `getActiveSessions()` — on a SUCCESSFUL read only, since an RPC failure
  returns no rows and must not read as "every session ended".
- **…and the clock has to be STOPPED by something. An abort is not a teardown.** The
  rule above only holds if `connectedAtMs` / `aliveUntilMs` are cleared when the tunnel
  goes away, and for a whole class of drops nothing was doing it. With auto-reconnect
  OFF, `decideReconnect` returns `abort`, and that branch used to just
  `notifyTraySettled()` — no `stopQuotaWatchdog`, no `activeSessionId` reset. So an
  interface that vanished (or a default route that moved under a tun2socks tunnel, or a
  proxy child that exited) left main believing it was connected, with the quota watchdog
  still ticking. `checkTunnelStalled` then made it worse: its `!readTunnelBytes()` branch
  set `aliveUntilMs = now`, which is right for local-proxy mode (no interface by design)
  and wrong in tunnel mode, where the interface IS the tunnel. Net effect: wall-clock
  billed against a dead tunnel, written to `lastSessionUsage` as a permanent floor, and
  `connectedAtMs ??= Date.now()` then carried that stale start into the NEXT connect —
  including a brand-new session, whose gauge read the time since some earlier tunnel came
  up. Reported live: 8 h bought, ~4 h connected, gauge showing 6 h+. Fixes: `abort` with
  reason `'auto-reconnect-off'` goes through `standDownSession('stalled')` (so the kill
  switch still follows the user's setting), and `usageAccruesWithoutTunnelInterface`
  (pure, unit-tested) gates that `aliveUntilMs = now` on proxy mode. **The node bills DURATION as
  wall-clock from `startAt` to the last activity, gaps included; only BYTES are exact.**
  Measured on #56152782: two tunnel windows totalling 646 s with a 657 s gap in between
  where no interface existed at all, and the chain settled **1306 s** — 2.02x the real
  connected time, and within 5 s of `startAt`-to-last-drop. Bytes over the same session
  agreed with our own interface counters to 0.018% (120,382,672 vs 120,360,568). Do NOT
  read #56136929 (1216 s up / 1218 s settled) or #56141731 (147 s / 148 s) as evidence
  against this — both ran as ONE continuous window, where uptime and span coincide, so
  they cannot distinguish the two. Only a session with a gap can, and n=1 so far.
  Consequences: an hourly session used intermittently is billed as if continuous, so
  per-GB is the honest product for dip-in-dip-out use; and our own floor (real connected
  time) sits BELOW what the chain settles, so once the proof lands the chain overtakes
  it and the gauge shows the larger, wall-clock figure. That is correct — the gauge must
  show what the user was CHARGED, not what we wish they had been.
- **An empty session list is NOT proof of anything, because the failure is swallowed
  a layer down.** `getSessionsForAddress` catches every error and `return []`, so
  "the RPC is unreachable" and "this account has no sessions" arrive at every caller
  as the same value — the `try/catch` around `readAllSessions()` in WALLET_SESSIONS
  never fires. The usage-floor prune read that as *every session ended* and deleted
  the store. That is not a rare race: `standDownSession` deliberately leaves the
  DROP-all kill switch armed, so the chain is unreachable at precisely the moment the
  usage has just been written. Measured live on mainnet #56152782 — 462 s of tunnel
  and 37.5 MB recorded at 18:00:37, `session-usage.json` emptied to `{}` at 18:00:55
  by the next poll, and the chain STILL reporting `duration: 0` ten minutes later, so
  the gauge had no source of truth left and read zero for a session that had genuinely
  run. **Proofs can lag by tens of minutes**: #56152782 sat at `duration: 0` with
  `inactiveAt - startAt` EXACTLY `statusTimeout` (the arithmetic proof that no proof
  had landed) for 54 minutes across two connects and ~120MB, before its first proof
  arrived 40 minutes after the last disconnect. So the floor is not a nicety that
  bridges a couple of seconds: for the best part of an hour it is the ONLY record that
  usage happened. `prunableUsageIds` (pure, unit-tested) is the
  guard: an EMPTY list prunes nothing. Don't "fix" this by making
  `getSessionsForAddress` throw — several callers rely on `[]` meaning "carry on"
  (see `chain-service.ts`, which would otherwise delete every reconnect config on a
  transient failure). Guard at the site that interprets the emptiness, and treat any
  other `[]` from that function the same way.
- **A session row is not necessarily live.** `getActiveSessions()` returns `'active'` AND
  `'inactive_pending'` — the state a session enters on its own when its quota runs out —
  so it can be labelled rather than vanishing mid-error. `decodeSession` maps the real
  enum (1/2/3), not `=== 1 ? 'active' : 'inactive'`. Anything offering a per-session
  action must gate on `status === 'active'`: `MsgCancelSession` only accepts status 1, and
  `endSession` swallows exactly that guard (`isSessionNotActive`) for the poll-vs-click
  race. Anything **counting** sessions must gate on it too (the Sessions header and the
  tab badge do) — a settling row is not an active session.
- **…and `'active'` does not mean *usable*.** The chain meters past the cap and leaves
  the row active until it is cancelled or reaped: #53647217 read `duration` 5673s against
  a paid 3600s, status 1. So a **Connect** action must additionally gate on the quota not
  being spent (`ActiveSessions`' `quotaUsedUp`) — otherwise it buys a handshake and a
  password prompt for a tunnel `startQuotaWatchdog` stands down at its next 15 s tick.
  **End** stays enabled there; it is the action that fits.
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
  The flag reaches the helper as a trailing `lan-sharing` **sentinel token** rather than a
  fourth positional argument, because `dnsIp` is optional and passing `''` for it would
  fail the daemon's `isIPv4` check. Auto-detected subnets and reusing `splitTunnelRoutes`
  were both considered and rejected: the first goes stale on every dock or Wi-Fi roam, the
  second overloads one control with two meanings and accepts public CIDRs. `100.64.0.0/10`
  (CGNAT, Tailscale) is deliberately absent from the ranges.
- **The kill switch DROPs, and that silence is the design — so diagnose this area with
  timings, never with error messages.** Nothing on the physical NIC gets an ICMP reject
  while the chain is armed, so every failure here surfaces as an unexplained hang in
  whatever was talking (a browser, a resolver, an app socket) rather than as an error
  anyone can read. Do NOT "improve" it to REJECT: the silence is what stops the chain
  advertising itself, and a reject would tear down connections the kill switch exists to
  hold still. The consequence to plan around is diagnostic, not functional. What worked
  on 2026-08-19 was sampling four independent clocks once a second across a connect —
  DNS through the resolved stub using a FRESH RANDOM NAME each time (a cacheable name
  measures the cache, not the path), DNS for a real name, TCP connect to an IP with no
  DNS, and full HTTP by IP. The stall landed only in the first while the TCP clock stayed
  flat at ~0.02s, which is what separated "DNS is broken" from "routing is broken" and
  killed the plausible-but-wrong "stale sockets black-holed by the kill switch" theory.
  Log per-link `resolvectl status` on every state change alongside it.
- **`ConnectionStatus.state === 'connected'` means "traffic is redirected", and it flips
  on INTERFACE PRESENCE — deliberately. Do not add an intermediate "verifying" state.**
  For WG/AWG/OpenVPN the status is true from the moment the interface exists, which is
  BEFORE `applyPostConnectSettings` arms the kill switch and before
  `assertTunnelCarriesTraffic` finishes (that probe alone can run 36s: 3 attempts x 2 URLs
  x 6s). That reads like a bug and is not one, because the tunnel genuinely is carrying
  the user's traffic throughout that window. The renderer gates on this string in 10+
  places and two of them break immediately if it goes false while a tunnel is up:
  `ActiveSessions`' `chainFrozen` re-enables the Sessions Refresh button, which is a
  silent no-op while our own tunnel freezes the chain (the bug d41d35b fixed), and
  `useTrafficStats(vpnConnected)` stops feeding the live meter, which drives the usage
  gauge BACKWARDS against the "must never go backwards" rule above. If the connect FLOW's
  progress needs surfacing, it belongs in the connect modal's own progress channel
  (`sendChainHopProgress` is the precedent), never in the status string every consumer
  reads as "is the tunnel up".
- **The kill switch's `ESTABLISHED,RELATED` accept now scopes to the tunnel interface
  only.** Was scoped to **any** interface, so a connection opened over the physical NIC
  *before* connecting would keep running while the chain was armed — latent but not
  defended against. Fixed 2026-08-15: both IPv4 (:570) and IPv6 (:289) rules now carry
  `-o $VPN_IFACE` / `-o "$vpn_iface"`, matching the honest scope of the comment. Measured
  as latent-not-active before the fix: zero pre-connect flows were observed on the NIC.
  **The app's own pooled sockets are the observed victim of that scoping.** Chromium's
  keep-alive pool holds sockets opened while idle (the IP display's 60s poll); after a
  connect arms the chain, a reused pooled socket's packets exit the physical NIC and are
  silently dropped, and with no RST Chromium cannot detect the corpse — the request hangs
  to its abort. Seen live 2026-08-24 as the IP display taking ~6s after a Sessions-tab
  reconnect. `fetchFreshSocket` (ipc-handlers.ts) is the defence: the tunnel probes and
  IP lookups dial a fresh, unpooled socket every time. Anything else in main that fetches
  the same host on both sides of a tunnel transition inherits this hazard.

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
  it is an **idle deadline pinned at `lastNodeProof + statusTimeout`**, so it is
  emphatically NOT `startAt + statusTimeout`. Each `MsgUpdateSession` jumps it back to
  2h out; between proofs it just ticks down in real time. #53647217 read `inactiveAt`
  06:24:52Z against a single proof at 04:24:52Z — the earlier "slid 74.5 min" reading was
  that one jump, not a smooth slide. Since quota is metered, that is the only clock
  running on an idle session. **It therefore keeps falling while the UI says "connected"
  if the node isn't seeing the traffic** — which makes it a usable dead-tunnel tell, and
  is why the card says "unless the node reports usage" rather than "if unused".
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
- **Everything an IPC handler throws reaches the renderer wrapped.** `ipcRenderer.invoke`
  rejects with ``Error invoking remote method '<channel>': Error: <our message>``, so a
  `startsWith(MARKER)` test against the raw `err.message` is always false — the
  `RPC_UNREACHABLE` / `INSUFFICIENT_FUNDS` / `DNS_PROVISION_FAILED` panes in
  `ConnectErrorActions.tsx` silently never fired, and users read the wrapper as if it
  were the fault. `connect-errors.ts` strips it (`unwrapIpc`) inside all four helpers;
  route every marker check and every displayed error through them, never through
  `err.message` directly. It is import-free + unit-tested for the native runner, so its
  markers are inlined and the test asserts they match `shared/error-markers.ts` — the
  same arrangement as `wallet-errors.ts`.
- **Every async IPC call in a click handler MUST have a try/catch.** An unhandled
  promise rejection in an event handler goes to `window.onerror` as an uncaught
  exception, but Electron doesn't wire that for you — it silently vanishes. The
  user sees a button that does nothing when the main process rejects the call (bad
  input, validation failure, etc.), with zero feedback about why. Always wrap the
  IPC call and catch exceptions: show them inline, disable the button, or add a
  loading state. "Save Routes" had no catch, so invalid bypass routes caused a
  silent promise rejection and the button stayed lit. Pre-validation in the renderer
  (e.g. `parseSplitTunnelRoutes()`) prevents most rejections, but the catch is
  defense-in-depth for edge cases the main process still refuses.
- **A session's usage gauges must never go backwards.** `ActiveSessions` builds each
  row's usage from two sources that do NOT hand over at the same instant: the live
  half (`useTrafficStats` + `status.connectedAt`) disappears the moment the 3 s status
  poll reports the tunnel down, while the row carrying main's remembered figure
  (`lastSessionUsage`) is a chain round-trip behind. In that ~1–2 s gap the card fell
  back to the *pre-connect* baseline — the time gauge dropped 8m → 3m → 8m, and the
  bytes gauge did the same. Fixed by flooring every reading at the highest already
  shown for that session id (`shownUsage`, rebuilt from the rows each render so
  settled sessions prune themselves). Usage only ever increases on chain, so this
  states no more than the truth — it is main's `maxUsageBytes` rule applied to the
  view. Don't "simplify" it away by trusting a single source; both are needed (main's
  is authoritative but slow, the live one is fast but ends early).
- **`isRpcConnectivityError` must know the wording of whoever produced the status.**
  `rpc-monitor.ts` says `RPC returned N`; **@cosmjs/tendermint-rpc says
  `Bad status on response: N`**, and that is what every real chain call throws. Knowing
  only the first meant a rate-limited endpoint (429 from `as-rpc.sentineldao.com`) both
  surfaced raw and never reached `reportRpcFailure()`. Match 429/502/503/504 only — a
  400 is the chain rejecting the request and keeps its own message.
- **A probe grades the PATH, not the endpoint — so never publish a fault the path
  explains.** The probe fired the instant a tunnel drops measures routes, resolver and
  Chromium's socket pool being restored: one dropped SYN costs 1s, two cost 3s, against a
  2500ms "slow" threshold and an endpoint that answers in ~400ms. That put "RPC slow" on
  screen for the rest of the 30s poll window every time a session ended, with a banner
  offering to switch away from a healthy endpoint. Two rules in `rpc-monitor.ts` keep it
  honest, and both must hold: **`needsConfirmation`** (pure, in `rpc-health.ts`) holds a
  *new* fault for one re-probe `CONFIRM_DELAY_MS` later — good news is never delayed, and
  an endpoint already accused is not re-confirmed; **`unprobedState()`** publishes
  `suspended` / `blocked` and sends NOTHING while our own tunnel or our own kill-switch
  chain is what stops the traffic (order matters — a connected tunnel with the kill switch
  on is `suspended`). `blocked` exists because `standDownSession` deliberately leaves the
  DROP-all chain armed after expiry: reported as `down` it accused the endpoint and offered
  a switch that changes nothing. Both are `isChainUnreachable` (the query really failed and
  main returned an empty list) but neither is a fault the RpcBanner may warn about.
  **Every place that changes that path must call `onChainPathChanged()`** — `sendStateChange`,
  `reapplyFirewall`'s live kill-switch toggle, and the startup `healStrandedKillSwitch` —
  or the pill sits a full poll behind reality.
- **A panel may fail; the window may not. WebGL is the case that proved it.** The only
  `ErrorBoundary` used to sit at the app root (`main.tsx`), so anything it caught replaced
  the entire client with a full-screen "Something went wrong". `mainTab` defaults to
  `'map'`, and `CountryGlobe` builds a three.js `WebGLRenderer`, which throws
  `Error creating WebGL context.` when the browser refuses a context. Net effect: a user
  with no usable GPU could set up a wallet and never see the app again. Reported on 0.1.1
  (GitHub), reproduced on 1.0.0, both shipping the same Electron.
  **Chromium 146 (Electron 41) no longer falls back to software WebGL by itself** —
  measured, not inferred: with no GPU, `getContext('webgl2')` *and* `('webgl')` both
  return null, silently, with no console warning, and `getGPUFeatureStatus().webgl` reads
  `disabled_off`. Older Chromium auto-fell back to SwiftShader, which is why this appeared
  without anyone touching the map code. Two defences, both required:
  `main/index.ts` appends **`enable-unsafe-swiftshader`** (it only *permits* the fallback,
  a machine with a GPU still gets hardware ANGLE, verified; it must be unconditional
  because switches are set before `whenReady` while `getGPUFeatureStatus()` is only
  readable after); and `MapView` **probes for a context before mounting the globe** and
  wraps it in a scoped `ErrorBoundary fallback=...`, because a context can still be
  refused after the probe passes when Chromium drops the oldest of too many contexts
  (the case `CountryGlobe`'s `forceContextLoss` cleanup already guards against).
  The "unsafe" in the flag name is about shaders from *untrusted web content*; this
  renderer only ever loads our own bundle (`setWindowOpenHandler` denies every window,
  `will-navigate` is pinned to our own index.html, no webview). Verify with the real app,
  not a unit test: `--disable-gpu` must render a globe via SwiftShader and
  `--disable-gpu --disable-software-rasterizer` must degrade to the country list with the
  window intact. **Never give `ErrorBoundary` a new caller without a `fallback`** unless
  the whole window really is the right blast radius.
- **No em dashes in user-visible strings** (modal copy, buttons, tooltips, error text
  that reaches a pane) — the maintainer reads them as AI-written. Use commas, colons or
  full stops. Code comments and commit messages are unaffected. Note this includes
  strings built in pure helpers (`chain-diversity.ts` labels, `connect-decisions.ts`
  messages) and `throw new Error(...)` text that surfaces in the UI.
- `chain-diversity.ts` (pure, unit-tested): advisory operator-diversity checks for a
  chain — same ASN, same /24, shared endpoint domain, same country. ADVISORY with an
  explicit override, because each can be true of two genuinely independent operators;
  each issue states the observation, not a verdict.
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

### Multihop (two-hop chains) — verified live, do not regress

One xray process, two outbounds, the exit dialling **through** the entry via
v2ray-core's `proxySettings.tag`: `you → entry → exit → internet`. `multihop-config.ts`
(pure, unit-tested) builds it; a chain ALWAYS runs on the **xray** binary because
xray-core is a strict superset of what the builder emits, so it lands in
`activeXrayConfig` and needs no new connect branch. Only v2ray(2)/xray(4) can chain —
`proxySettings.tag` has no equivalent in the other protocols.

- **The builder is a TAB, not a modal**, with the same shape as Nodes: choose on
  `multihop/MultihopView.tsx` (the real `NodeFilters` + `useNodes(latencyMap, isChainable)`,
  no private picker), commit in `multihop/ChainReviewModal.tsx`; the draft and its grades
  live above the tab in `ChainDraftContext`. `utils/chain-node.ts` (pure, unit-tested) owns
  the rule that decides which rows can be clicked: **selectable only on POSITIVE evidence**,
  so ungraded, unreachable and pre-9.0.0 nodes stay visible but refuse the click.
- **Only the ENTRY is dialled directly.** `extractV2RayRemoteHost` picks the outbound
  **without** `proxySettings`, and that one IP is the only bypass route and the only
  kill-switch whitelist. Whitelisting the exit strands the tunnel. Verify a live chain
  with `ip route get <exitIP>` (must be `dev sntl-tun`) — `ss` alone is NOT enough under
  tun2socks, where app sockets look direct because interception is at the IP layer.
- **The EXIT must be plain TCP** (`EXIT_TRANSPORTS`). Measured against xray 26.3.27 with
  two local servers: entry tcp→exit grpc FAILS, →exit ws FAILS, entry grpc→exit tcp
  WORKS. Both work as a DIRECT hop, so it is chaining: only plain TCP delegates dialing
  to xray's detour dialer. The ENTRY may use any transport we can emit.
- **BOTH hops require TLS or Reality** (`isChainGradeSecurity`) — stricter than the
  single-hop rule, which still accepts VMess-without-TLS. VMess has its own AEAD so it
  is not cleartext, but VMess/gRPC/none is cleartext HTTP/2 on the wire: the entry hop
  announces the circuit to the user's own ISP, which is what a chain is bought to
  prevent. Cost measured: 211 of 241 healthy v9 nodes still qualify as entry, 140 as exit.
- **Grade BEFORE paying.** `assertChainEligible` reads each node's own `service_metadata`
  from its ROOT path and applies the rule. `preflightConnect` does NOT cover this — it
  only checks the node runs the protocol the directory claims. The node list cannot
  answer it either: it publishes ONE transport per node, reporting tcp for 16 nodes
  network-wide while 138 of 241 serve one. Pre-9.0.0 nodes publish nothing and are
  refused rather than bought and refunded.
- **`establishChainOrRefund` refunds BOTH sessions on any failure**, and the cancels
  MUST be sequential (`refundEachInTurn`, unit-tested): every cancel is a tx from one
  account, so parallel broadcasts collide on the account sequence number and the chain
  rejects the loser. `Promise.all` here cost a live refund — entry cancelled, exit left
  ACTIVE. Same constraint as the two purchases.
- **Per-hop wallets** (`exitWalletId`): a Session carries `accAddress`, and
  `SessionsForAccount` is public, so one wallet lets EITHER node find the other hop.
  Paying from two accounts removes that. The exit hop's purchase, handshake AND cancel
  must all sign as the owning account. `loadWalletCredentials` derives a wallet without
  making it active (`switchWallet` mutates shared state) and its privKey is tracked by
  nothing — zero it in a `finally`. The app never creates or funds the second wallet: an
  in-app transfer between them is itself a public link. A subaccount is a normal
  `WalletEntry`, so it already appears in the picker.
- **…and the funding trail is checked, not just warned about.** `findTransferBetween`
  (WALLET_LINK_CHECK) asks the chain for a transfer in either direction between the two
  accounts and the modal shows it, because topping the second wallet up from the first
  is both the obvious way to fund one and the thing that undoes the whole feature —
  confirmed on the maintainer's own wallets, which were linked by a 1000 P2P transfer.
  `checked: false` (pruned RPC, no tx index) must NEVER render as clean: a silent pass
  is the exact false assurance the check exists to prevent.
- **A foreign-owned session is invisible by default.** `sessionsForAccount(active)`
  cannot see the exit hop, so `SavedSessionConfig.walletId` +
  `listSessionsOwnedByOtherWallets` + `getSessionsForAddress` exist to merge it back in;
  without them the exit hop vanishes from the Sessions tab with a live deposit against it.
- **Every writer of `lastKnownSessions` goes through `primeSessionsCache`, fed by
  `readAllSessions()`** — never `getActiveSessions()`, and never a hand-rolled map.
  The helper exists because both halves of this rule were violated live: priming
  from the active wallet alone drops the exit hop of a per-hop-wallet chain for
  exactly as long as the chain is connected (entry #55268780 shown, exit #55268795
  on the second wallet not, both ACTIVE on chain throughout), and a writer that
  skipped `decorateSessionRow` omitted `chainPeerSessionId`/`chainRole`, so the tab
  forgot it was a chain and "End" on one hop killed the tunnel and stranded the
  other's deposit. `WALLET_SESSIONS` returns the cache verbatim while a tunnel is
  up, which is why one bad writer poisons the whole connected session.
- **Ending a chain hop leaves a TOMBSTONE** (`retireSessionConfig`): credentials cleared,
  pairing kept, so the two rows stay grouped for the ~2h they take to settle. A record
  with an empty `configString` must never be reconnected.
- **`nodeType` is the NODE's protocol, never the runtime.** A chain of two V2Ray nodes
  runs on xray; hardcoding 4 on the reconnect path put "XRAY" in the connected bar.
- Reconnect replays the SAVED chained config and re-applies **no** policy, deliberately:
  a chain bought under older rules still reconnects, because the money is already spent.
- Dual quota: both hops meter the same stream, so **worst verdict wins** — but they
  settle independently and can land far apart, so the Sessions card scores off the worse
  hop and the sooner expiry. `currentQuotaVerdict` returns WHICH session lost, so the
  expiry banner names the right node. **`startQuotaWatchdog` must repair BOTH quotas**
  from `lastKnownSessions`: a Sessions-tab reconnect restores `activeExitSessionId` with
  no quota behind it, and scoring the entry alone leaves an exhausted exit to be caught
  only by `checkTunnelStalled`, 64 KB and 90 s later.
- **In practice the EXIT hop meters NOTHING, so a chain has a hard ~2 h life from the
  exit's purchase.** Measured 2026-08-15 by pushing 30 MB through a live chain and polling
  both sessions for an hour: the entry reported `1201s / 58 371 970 B` (matching `sntl-tun`
  plus overhead, ending exactly at disconnect) while the exit reported `0s / 0 B`. Its
  `inactiveAt - startAt` was **exactly** `statusTimeout`, which is the arithmetic proof that
  no proof ever landed. Three chains, three different exit nodes, all zero, while the entry
  proved correctly — it tracks the ROLE, not the operator. Not our bug: metering is entirely
  node-side (`SessionUsageSyncWithDatabase` reads the node's own core via `StatsService`
  `user>>>id>>>traffic>>>uplink|downlink`, and `SessionUsageSyncWithBlockchain` skips the tx
  when usage is unchanged), and the identical client code path proves fine on the entry.
  **The consequence is ours, though:** on an active row `inactiveAt` is
  `lastNodeProof + statusTimeout`, so an exit that never proves has a deadline pinned at
  purchase + 2 h that never moves. The chain then reaps the exit while the entry still has
  hours and most of its quota, and the tunnel dies with the UI saying connected.
  `evaluateQuota` scores duration and bytes, NOT `inactiveAt`, so it cannot see this
  coming — only `checkTunnelStalled` catches it, after the fact. Anything that wants to
  warn before a chain dies has to read `inactiveAt` on the worse hop, not the quota.
- **Progress is per hop AND per phase.** A chain runs the purchase sequence TWICE, so the
  shared 1/5..3/5 steps replay from the start halfway through and read as a restart.
  `sendChainHopProgress` emits `hop:<role>:<phase>` (buy | handshake) and the modal maps
  the four markers to a monotonic per-hop stage. The phase is load-bearing: both hops are
  bought before either is handshaked, so keying off the role alone drove each hop's state
  BACKWARDS at the halfway point.
- **The EXIT hop is provisioned THROUGH the entry, and must stay that way.** Its
  eligibility gate, its preflight and its handshake are all session-bound and are
  followed seconds later by the user's traffic, so an exit that logs who asked could
  join the two — which is the one thing a chain is bought to prevent. So
  `establishChainOrRefund` runs: buy entry → handshake entry → `startProvisioningProxy`
  (an entry-only xray on 1081, `buildEntryOnlyConfig`, deliberately NOT registered as
  the active connection or `isVpnActive()` would lie mid-purchase) → check + buy +
  handshake the exit with a `SocksHttpsAgent` → stop the proxy → build the chain.
  Consequences to keep: the exit's gate now runs AFTER the entry is paid for (the
  picker's grade is the primary check, this is the backstop); the exit PURCHASE is
  broadcast directly on purpose (a public tx tells the exit nothing new, and it keeps
  CosmJS off the proxy); proxied calls get their own longer timeouts, because a
  timeout there strands a paid entry. **Never add a direct call to the exit node.**
  **Why splitting provisioning and traffic across two source addresses is safe at all:**
  the node binds the peer to nothing but the session. `sentinel-dvpnx`
  `api/handshake/handlers.go` persists account address, node address, peer id, session id,
  quotas, peer metadata, the peer request, byte counters, service type and signature, and
  no client IP; `node/setup.go` builds the API with `gin.New()`, so no logger middleware
  records one either. The exposure this ordering closes therefore always needed a modified
  node, a reverse proxy in front, or capture at the OS level — real, but not automatic.
  **Verified live on mainnet 2026-08-15**, by sampling `ss -tan` across a whole purchase:
  the host opened `45.124.52.245:26132` (entry API, direct) and `:48923` (the proxy), and
  the exit's API `217.154.177.25:35159` appeared ZERO times while its session was bought
  and handshaked anyway. To re-check after touching this path, sample sockets from before
  "Buy both hops" until the tunnel is up and read each node's API from the chain's
  `remoteAddrs` — the API port is NOT the VLESS port, so watching the config's address
  alone would miss a direct handshake entirely.
- **The SDK cannot handshake through a proxy**, so `node-handshake.ts` rebuilds that one
  POST (checked against 2.1.0's published `dist/utils.js`; the Go SDK's node client is
  the same, `WithInsecure`/`WithTimeout` only). The SDK still owns every DIRECT
  handshake. `node-handshake.test.ts` captures what the real SDK puts on the wire and
  asserts ours is byte-identical — that test is the whole safety argument for the
  reimplementation, so it must never be weakened to a hand-written fixture.
- **`URL.port` is a STRING, and the SOCKS agent is the one place that notices.**
  `http.get(urlString)` launders it through Node's `urlToHttpOptions`, which coerces to a
  Number, so `node-tester`'s probes were fine; `postHandshake` built its options by hand
  from `new URL(...)` and passed the raw string. `SocksHttpsAgent.createConnection`
  asserted `port?: number`, trusted it, and threw "invalid port 6636" — AFTER both hops
  were bought, because the preflight had gone through the coercing path and passed. Both
  ends are fixed (the agent coerces, `postHandshake` sends a number), and the agent's
  options type must keep saying `number | string`: it is Node's contract, not ours. The
  live cost was a two-session buy-and-refund with all 12 codec tests green, because none
  of them went through `createConnection` — the only door untyped options come in by.
  Anything reaching that class from a URL needs a test AT the agent, not at the codec.
- **The picker's bulk grading rides whatever tunnel is up; a cold start is the accepted
  residual.** It carries no wallet and no session and goes to hundreds of nodes, so what a
  node learns is "an address looked at me" with nothing to attach it to. The modal says so.
  In TUNNEL mode nothing was ever needed: the OS puts these probes in the tunnel already
  (wg/awg/openvpn replace the default route; tun2socks owns `0.0.0.0/1` + `128.0.0.0/1`,
  and only the connected node's `/32` bypasses). **Local-proxy mode was the one state
  where a tunnel existed and our own traffic did not use it**, so grading now goes through
  its SOCKS listener via `getActiveProxyPort()` + `SocksHttpsAgent`. That accessor is for
  this caller only, and is deliberately not `isVpnActive()`'s inverse. **A proxied probe
  that fails must never retry direct** — that is the silent leak this exists to prevent;
  the row reads as unknown instead. Don't route `probeNode` the same way: it measures
  latency, and through a proxy it would measure the wrong thing.
- **Key material is validated before an inbound is selected, on both protocols.** TLS
  needs a `tls_pin` that normalises; Reality needs a 32-byte `reality_public_key` AND a
  non-empty `reality_server_name` (`isUsableReality`, mirrored in `xray-config.ts` with a
  cross-check test). Reality is preferred first, so an unusable Reality entry used to
  shadow a good TLS one on the same node and emit `publicKey: ''` — a config xray rejects
  at SPAWN, which is after `establishChainOrRefund` returns, so nothing refunds it. Keep
  the check out of `classifyHopEligibility`: the public listing blanks those fields.
- **The exit's address is resolved over DoH** in `performChainHandshake`, before the
  tunnel exists, because `pinV2RayNodeAddresses` would otherwise hand the ISP the one
  fact a chain buys: which exit was chosen. Do NOT "simplify" this by leaving the exit a
  hostname for the entry to resolve unless it is proven that xray never resolves a
  detoured destination locally: if it does, the lookup happens through the tunnel and
  needs the exit to reach the exit. Falls back to the old `getent` pin on any failure.
- **Record `walletId` on BOTH hops**, including the active wallet's. Absent means
  "whichever wallet is active now", so switching wallets hid a hop from the Sessions tab
  and made its cancel unsignable (x/session only accepts the session's own account).
- Measured cost: ~20x latency vs single-hop on a long chain (ES→TR 1.75s), ~0.95s AU→JP,
  ~2-3 MB/s. Chains are for privacy, not speed.

**DNS fallback.** wg-quick/awg-quick fail the whole bring-up when `resolvconf` is
missing. Those catch paths rethrow with the `DNS_PROVISION_FAILED` marker
(`src/shared/error-markers.ts`), and `CONNECTION_CONNECT`'s `dnsFallback` retries the
same config through `stripDnsLines()`. User consent only — auto-reconnect never strips
DNS, and the renderer states that system DNS then leaves the tunnel. `stripDnsLines` is
deliberately the narrower sibling of `replaceDnsLines` (see the node-DNS invariant above):
this path removes DNS because resolvconf is missing, so it wins over a chosen resolver —
any `DNS =` line fails the bring-up here, including one we picked.

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

**getDefaultDepends is not the whole truth: `libasound2` and `libgbm1` are ours to
declare.** Both are hard `DT_NEEDED` entries of the Electron binary, not dlopen'd
extras, so a missing one is not degraded audio or degraded graphics — the dynamic
linker refuses to exec the app at all (`error while loading shared libraries:
libasound.so.2: cannot open shared object file`), before any window, log line or
error dialog can exist. Neither is in electron-builder's default list, so the
"repeat the nine verbatim" rule above was necessary but NOT sufficient.
Measured in a `debian:bookworm` container carrying only this package's declared
dependencies: plain install → `libasound.so.2` missing, app dead at exec;
`apt-get --no-install-recommends` → `libgbm.so.1` missing as well, since the GL stack
(libGL, libEGL, the mesa DRI drivers) arrives through **Recommends** somewhere in this
dependency set and never through anyone's Depends. That second case is also a machine
with no system GL whatsoever, which is precisely the no-WebGL state the Map tab has to
survive.

**`libasound2t64 | libasound2` must stay an alternation with the t64 name FIRST, and
Ubuntu is the only place that shows why.** On Ubuntu 24.04 `libasound2` is a *virtual*
name with several providers, and the one apt picks unprompted is
`liboss4-salsa-asound2`, an OSS4 shim implementing a subset of the ALSA API. The real
`libasound2t64` is never installed, the package installs cleanly, `ldd` reports **zero**
unresolved libraries, and the app dies the instant it is run:
`symbol lookup error: undefined symbol: snd_device_name_get_hint, version ALSA_0.9`.
Debian 12/13 and Ubuntu 22.04 all resolved the bare name to the real library, so
**testing Debian only would have shipped a package that cannot start on the single most
common desktop target.** Naming the real package first makes the choice deterministic;
older releases have no `libasound2t64` and fall through to the second alternative, where
`libasound2` is a real package and therefore beats any provider.

**A container is enough to catch this class of bug and costs minutes, but `ldd` alone is
not a sufficient check and Debian alone is not sufficient coverage.** Run all four
(`debian:bookworm`, `debian:trixie`, `ubuntu:22.04`, `ubuntu:24.04`):
`apt-get install -y --no-install-recommends /tmp/app.deb`, then
`ldd "/opt/Katacomb VPN/katacomb-vpn" | grep "not found"` (must print nothing) **and**
actually execute the binary (`--no-sandbox --version`), which must reach Chromium's own
startup rather than `symbol lookup error` or `error while loading shared libraries`.
Reaching a dbus or `Missing X server or $DISPLAY` complaint is the expected pass in a
headless container. Do that on any dependency change before reaching for the full
interactive script below.

**The AppImage bundles `libasound.so.2`, and deliberately does NOT bundle `libgbm.so.1`.**
An AppImage has no package metadata, so it cannot declare either of the two libraries
the deb declares above, and both are `DT_NEEDED` on the main Electron binary — a host
missing one gets a linker error and no dialog. `AppRun` exports
`LD_LIBRARY_PATH=$APPDIR/usr/lib`, so `linux.extraFiles` stages our copy there beside
electron-builder's own `libXtst`/`libnotify`/`libXss`. It has to be `linux.extraFiles`,
not `appImage.extraFiles`: the schema has no per-target `extraFiles`. Landing in the deb
as well is harmless **because the binary's RPATH is bare `$ORIGIN`, not
`$ORIGIN/usr/lib`** — moving it up to the app root would shadow the system library for
deb users, which is the opposite of what the deb's own `Depends` is for.
The asymmetry is the point: `libgbm` is bound to the host's mesa DRI drivers and
`LD_LIBRARY_PATH` outranks the system, so bundling it would shadow mesa for **every**
AppImage user including the ones it works for today, to rescue hosts that have no
graphics stack to run a GUI on regardless. `libasound` has no such coupling and the app
never plays audio; it only needs the symbols to resolve, which is also what makes it
immune to Ubuntu's partial OSS4 shim. Vendored **from a `debian:bookworm` container**,
never from the maintainer's desktop, for the reason `scripts/build-amneziawg.sh` builds
in one: a native copy inherits this machine's glibc and would refuse to load on older
targets (floor is GLIBC_2.34; re-check on any refresh). It is LGPL-2.1, so unlike the
six executables it is *linked into* the process and carries a source offer in
`THIRD-PARTY-LICENSES.md` — keep that entry in step if the file is ever refreshed.

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
