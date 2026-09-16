# Multihop (two-hop chains)

Verified live. `src/main/protocols/multihop-config.ts` is the pure builder.

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
deliberately the narrower sibling of `replaceDnsLines` (see the node-DNS invariant in
[docs/invariants/reliability.md](invariants/reliability.md)):
this path removes DNS because resolvconf is missing, so it wins over a chosen resolver —
any `DNS =` line fails the bring-up here, including one we picked.

**Plans tab (consumer side).** Rebuilt 2026-08-24 around three pieces; the invariants
each carries:
- **`PlansContext` is the ONE data source** (`components/plans/`, the NodesContext
  pattern, mounted above the tab so switching tabs keeps state). It reads
  `PLAN_OVERVIEW` — plans + subscriptions + allocations in one round-trip over one
  connection — and refreshes on `onSessionsChanged` pushes, after every mutation, and
  one slow backstop. Don't add per-component plan polls (the retired `usePlans` ran
  two independent 120 s allocation polls) and don't resurrect the superseded
  `PLAN_LIST_CACHED` / `PLAN_ALLOCATIONS` / `SUBSCRIPTION_LIST` channels. The
  overview's `stale: true` means "chain half is a memory" (tunnel up, or the read
  failed; main serves `lastPlanOverview`, cleared on WALLET_SWITCH) — the tab shows
  cached data and disables mutations rather than blanking. `PLAN_NODES` likewise
  answers from its cache while the VPN is active, and returns **null, never `[]`, when
  it cannot know** (cache miss: the cache is in-memory, so the catalog scan's warm
  entries die with the process). `[]` there rendered as a false "No nodes are linked
  to this plan" twice: first from the tunnel, then again after every app restart via
  the `?? []` fallback, shown even for the plan the user was connected through. The
  renderer words null as "cannot check right now" and falls back to the catalog's
  persisted `nodeCount`; only a real `[]` may claim the plan has no nodes.
- **Smart connect (`PLAN_SMART_CONNECT`) spends the plan price AT MOST ONCE.** The
  pure module `plan-connect.ts` (unit-tested) owns the decisions: `rankPlanCandidates`
  admits nodes on positive evidence only (directory row, active, healthy, runnable
  protocol, probe not failed; latency buckets, then `PROTOCOL_PREFERENCE`, then
  address for determinism), `shouldTryNextCandidate` walks the ladder (nothing-spent
  failures advance freely; refunded failures advance within `MAX_TX_ATTEMPTS`;
  tx-timeout / funds / chain stop cold — a second MsgStartSession after a timeout
  could buy a second subscription), and `ladderNextTx` states the money rule: once a
  subscription commits, every further attempt is a gas-only session on it. The handler
  runs every attempt through `preflightConnect` + `establishSessionOrRefund`, and a
  failed REFUND stops the ladder (`REFUND_FAILED_TAIL`, shared with
  `sessionFailureMessage`). A ladder that exhausts after a fresh purchase reports the
  surviving subscription instead of losing it. Progress rides `CONNECTION_PROGRESS`
  as `plan:rank/buy/session/handshake` (`sendPlanProgress`, the chain-hop precedent).
- **Plan/subscription mutations fail fast while the tunnel is up** (`isVpnActive()`
  throw in the handlers, wording per WALLET_END_SESSION) and ride `openChainFlow`
  with a `timeoutHeight` (raw msgs, not the SDK convenience methods, which never set
  one). Money figures still come from main's plan cache (`cachedPlanCost`), never the
  renderer.
- Formatting: plan bytes are DECIMAL on chain (`BYTES_PER_GB = 1e9`), so everything
  plan-shaped goes through `utils/format.ts` (import-free, unit-tested) —
  `formatBytes` decimal units, `planPriceDisplay` gives non-udvpn plans their real
  denom with `udvpn: null` (never zero: they used to render as free and sort
  cheapest), `formatPerGb` keeps significant digits on huge plans. ActiveSessions'
  own gauge formatters are deliberately untouched (its `formatDuration` must render
  0 as "0m").

**Subscription chain facts** (unchanged by the rebuild): `RenewalPricePolicy` 0
(UNSPECIFIED) is the hub's own "never renew" (`Subscription.RenewalAt()` returns the
zero time for it; cancel sets it to 0); 7 (ALWAYS) stays the default. Cancel marks the
subscription inactive-pending — it is NOT an instant refund, so don't word it as one
(`SubscriptionActionModal` states this). Renew is plan-only (a node subscription has
no plan price to charge). `subscriptionShare` exists in the SDK and is deliberately
unwired.
