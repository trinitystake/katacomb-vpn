# Key modules (main process)

What each module in `src/main/` is for. The folder each lives in is listed in
CLAUDE.md; this is the per-module detail.

- `wallet.ts`: BIP-39 mnemonic import, `DirectSecp256k1HdWallet` derivation with `sent` prefix, `safeStorage` encryption (OS keyring via libsecret on Linux), balance/session queries via `SentinelClient`.
- `settings.ts`: Multi-wallet store (`wallets/` dir with encrypted `.enc` files + `wallets-index.json`), app settings (`settings.json`), old single-wallet migration. Wallet entries have `id` (UUID), `name`, `address`.
  **There is no seed id on disk**: every entry holds its own encrypted copy of the phrase
  (a derived subaccount re-encrypts the same words), so which wallets share a seed is
  computed by decrypt-and-compare on every `WALLET_STORE_STATUS` read (`assignSeedGroups`
  in `shared/seed-groups.ts`, pure + unit-tested) and never persisted. The Settings
  Wallets tab nests wallets under those groups and `WALLET_DELETE_SEED` removes one
  group; its `keepSeed` is only valid when that group is the last thing stored, because
  `retainedSeedId` can only hold a seed while zero wallets exist.
- `chain-service.ts`: `SigningSentinelClient` for on-chain tx (node subscription via `nodeStartSession`), session ID extraction from tx events, cryptographic handshake with nodes (WireGuard/V2Ray branching). Session configs saved to disk for reconnect.
- `vpn-manager.ts`: V2Ray child process lifecycle, WireGuard via polkit helper, tun2socks TUN routing for V2Ray, connection status monitoring. Bundled child-proxy binaries (v2ray, xray, hysteria) verified via SHA-256 before use, with system PATH fallback. tun2socks is no longer a binary: the engine is compiled into the privileged helper (`daemon/internal/tun2socks`), and `tun-up` self-execs it. Likewise the AmneziaWG userspace device (`daemon/internal/amneziawg`), which `awg-up` self-execs: root runs no vendored binary any more.
- `ipc-handlers.ts`: all IPC channels (registered via a `handle()` wrapper that rejects calls from any frame that isn't our own renderer), pre-connect balance validation, node list fetch from `api.sentnodes.com/v2/nodes` via `net.fetch`, auto-reconnect + a WireGuard liveness monitor. Caches balance/sessions/nodes when VPN is active (RPC unreachable through tunnel).
- `config-guard.ts`: **pure validators for untrusted-node data** — `assertSafeWireguardConfig` (allow-list keys, reject `PostUp`/`PreUp`/… so a node config can't run shell as root via `wg-quick`), `assertSafeV2RayConfig`, `isAllowedBypassCidr`/`sanitizeBypassRoutes` (reject `0.0.0.0/x` split-tunnel routes), `extractWireguardEndpointHost`. Unit-tested; see [docs/invariants/node-trust.md](invariants/node-trust.md).
- `fs-utils.ts`: `writeFileAtomic(path, data, mode=0o600)` (temp + rename). Use it for all settings/wallet/session/cache writes — never `writeFileSync` directly for persisted state.
- `kill-switch.ts`: iptables-based kill switch (helper `killswitch-on`/`killswitch-off`); `traffic-stats.ts`, `node-tester.ts`, `plan-service.ts`/`provider-service.ts` and their `*-cache.ts`, `nodes-cache.ts` round out the main process.
- `async-utils.ts` (`withTimeout`), `connect-decisions.ts` (pure refund-message + reconnect/backoff decisions, `serviceTypeToNodeType` for the preflight, `isDnsProvisionError`/`stripDnsLines` for the DNS fallback), `tx-utils.ts` (`broadcastOrTimeout`): the **Electron-free, unit-tested** reliability helpers. Keep new pure decision logic here rather than inline in the Electron-coupled modules, so it stays testable under the native runner. **Transactions carry no memo** — all `signAndBroadcast` calls pass an empty string or the CosmJS default, never app-identifying labels.
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
  unit-tested; see [docs/multihop.md](multihop.md) for the invariants it enforces.
- **The SDK's hand-written layer is NOT used any more; only its generated protobuf,
  clients, queries and tx helpers are.** `@sentinel-official/sentinel-js-sdk` stays a
  runtime dependency for those, and a devDependency-grade test oracle besides. What was
  cut was the part that was pure liability, replaced by four pure, unit-tested modules
  whose output is pinned **byte-identical to the SDK's** (the same safety argument
  `node-handshake.test.ts` makes, and the reason the package must not be removed
  outright — these oracles need it):
  - `chain-keys.ts`: `derivePrivKey` (was `privKeyFromMnemonic`; **`hdPath` is now
    REQUIRED**, because the SDK default of account 0 silently signed node handshakes
    with a key that did not match the address the session was bought with),
    `generateWireguardKeypair` (node:crypto x25519), `generateProxyUuid` / `uuidToBytes`.
  - `wireguard-config.ts`: `buildWireguardConfig`, replacing the SDK `Wireguard` class.
  - `v2ray-config.ts`: `buildV2RayConfig`, replacing the SDK `V2Ray` class.
  - `chain-events.ts`: `searchEvent`.
  Why: those classes are connection managers, not builders. Constructing one pulled
  axios, qrcode, find-free-ports and child_process into the main process and could spawn
  `v2ray`, mkdtemp a config and print QR codes. The V2Ray connect path built a config,
  wrote it to a temp file under `os.tmpdir()` at default permissions, read it straight
  back and unlinked it — with the session uuid in it throughout. `Wireguard.parseConfig`
  awaited a free-port lookup for a `ListenPort` that `buildConfigString` never emitted.
  **The dead weight the SDK emitted is reproduced deliberately, not tidied**: the global
  `transport` block of empty defaults and the unused StatsService api inbound stay,
  because trimming them changes wire behaviour for transports that cannot be tested
  offline. `buildV2RayConfig` takes `apiPort` as an argument so it stays pure; the
  caller uses `findFreePort()` in `chain-service.ts`.
  Consequence worth knowing: **the WireGuard `DNS = 10.8.0.1, 1.0.0.1, 1.1.1.1` list is
  the SDK's hardcoded default, not something the node pushes.** It reads like
  node-supplied data and is not (`10.8.0.1` is the in-tunnel gateway, i.e. the node's
  own resolver, which is why the node-DNS invariant still applies to it).
  Consequence for the connect path: **WireGuard and V2Ray no longer have two connect
  paths each.** They used to stash a live SDK object (`activeWg`/`activeV2ray`) for a
  fresh connect and a config string for a reconnect; now every protocol stashes a string
  (`activeWgConfig`/`activeV2rayConfig`, like the other four) and the instance variants
  `connectWireGuard(wg)` / `connectV2Ray(v2ray)` are deleted.
- **There is ONE registry, `CHAIN_REGISTRY`** (`provider-msgs.ts`). There used to be two:
  that one and a bare `new Registry(SentinelRegistry)` in `chain-clients.ts`. The SDK's
  list omits the whole x/lease module and `MsgUpdatePlanDetails`, so a client built from
  it could not encode those — harmless only because that traffic happened to go through
  the provider console. Anything moved onto the connect flow's client would have failed
  at encode time, at the point of spending money.
- `price-service.ts`: P2P→USD rate from CoinGecko (`ids=sentinel`), 15-min memory cache,
  **display only** — no transaction figure is ever derived from it, and failure returns the
  last value or null so the "≈ $x" hint just disappears.
