# Reliability invariants

The connect path spends real on-chain funds. Every rule here was paid for by a
live incident; none is theoretical. Read this before touching `ipc-handlers.ts`,
`vpn-manager.ts`, `chain-service.ts` or anything under `src/main/ipc/`.

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
- **One connection at a time, enforced in main.** Every entry point that creates a
  session or brings up a tunnel calls `assertNotConnected()` (ipc-handlers.ts):
  `CONNECTION_SUBSCRIBE`, `CONNECTION_SUBSCRIBE_CHAIN`, `CONNECTION_RECONNECT`,
  `CONNECTION_CONNECT` (inside the lock, so a queued connect sees the one before it),
  `PLAN_SUBSCRIBE`, `PLAN_START_SESSION_FROM_SUB`, `PLAN_SMART_CONNECT`. It refuses while
  `getConnectionStatus().connected` OR `reconnectAttempt > 0` — deliberately broader
  than `isVpnActive()`, because local-proxy mode has a live paid session with routing
  untouched, and the reconnect window has a tunnel about to be resurrected. Without
  it a second purchase clobbered the tracked session (`applySession`) and stacked a
  second tunnel over the first, leaving the old session active on chain with nothing
  watching its quota (live 2026-08-25: a plan session orphaned by a Nodes-tab
  subscribe that presented the normal pay form while connected). The renderer's
  connect surfaces grey out behind a "You are connected" banner (`ConnectionModal`'s
  `connectedElsewhere`, `PlanConnectModal`'s `tunnelUp`, `ChainReviewModal`'s
  `alreadyConnected`, Sessions' Reconnect) — but that is UX; the handlers are the
  enforcement. Third-party VPNs (`detectOtherVpn`: non-sntl wireguard/tun links)
  stay a warn-with-override, never a hard block — the detection false-positives on
  Tailscale. **IPsec/XFRM VPNs are no longer invisible**: reading xfrm policy needs
  CAP_NET_ADMIN, so the helper does it (`ops.XfrmPolicyCount`, daemon op
  `xfrm_policies`, read-only and lock-free) and `CONNECTION_CHECK_VPN` merges the
  answer in. Counting only policies with a `tmpl` line is load-bearing: the kernel
  installs template-less socket policies of its own on some systems, and without that
  filter this reports a VPN on an idle machine. It is **daemon-only, never the pkexec
  fallback** — routing it through pkexec would put a password prompt in front of a
  warning nobody asked for. No daemon means no answer, and the check still informs
  rather than gates.
- **The active wallet is frozen while a session is live.** `WALLET_SWITCH`, `WALLET_IMPORT`
  (an import becomes active), `WALLET_DELETE`, `WALLET_DELETE_ALL` and `WALLET_DELETE_SEED`
  call `assertNotConnected('switching wallets')` and friends, and `activeWalletId` is not a
  `SETTINGS_SET` key: only `wallet.ts` writes it, which is what keeps the in-memory keys in
  step with disk. A single-hop session's saved config carries no `walletId` (only multihop's
  `finalizeChain` records one), so "owner" means "whichever wallet is active", and a
  mid-session switch makes `WALLET_END_SESSION` and the reconnect handshake sign with the
  wrong key: x/session rejects the cancel and the deposit is stranded until expiry, while
  `lastKnownSessions`/`lastKnownBalance` (now cleared on switch) showed the old wallet's data
  under the new address. The Settings Wallets tab greys Switch / Add Wallet / Delete / Remove
  seed out behind a banner; the handlers are the enforcement. Rename, Derive Subaccount and
  Recovery Phrase are deliberately not gated: none changes who signs. The same predicate
  (`connectionIsLive()`, true in local-proxy mode and the reconnect window where
  `isVpnActive()` is false) refuses ending the live session and cancelling the subscription
  behind it, which the Sessions tab's disconnect-first step does not cover mid-reconnect. The
  provider and subscription forms take their opener's read-only gate as a prop so a form
  opened before a connect greys out with it, and Settings > Network pauses its RPC probes
  (tab open and Retest) while the RPC state is `suspended`/`blocked`.
- **Bound every wait.** RPC connects go through `withTimeout`; session-creating broadcasts
  go through `broadcastOrTimeout` and set a `timeoutHeight`. `provider-service.ts` is the
  reference for the timeout pattern. (`node-tester.ts`'s `nodeFetch` now enforces ONE
  deadline across DNS, TCP connect, TLS and body. It used to set only
  `req.setTimeout`, a socket INACTIVITY timer that does not arm until the socket
  connects, so a blackholed node hung past it: measured at >120s against an 8s budget,
  and with the batch probe's `CONCURRENCY` of 3 that stalls a whole sweep. Three of the
  four call sites already wrapped it in `withTimeout`; `probeNode` did not, which was
  the live path. Those wraps stay as defence in depth but are no longer load-bearing.)
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
  - `checkWireGuardHandshake()` on the same loop, **kernel WireGuard ONLY**, closes the
    hole the bullet above admits to: an idle tunnel whose peer has died produces no
    traffic, so `isTunnelOneWay` abstains forever and the idle branch keeps advancing
    `aliveUntilMs = now` against a dead tunnel (the #53670474 shape). The kernel is the
    witness. Our configs carry `PersistentKeepalive = 15`, so a live peer re-handshakes
    on its own (`RekeyAfterTime` is 120 s on send, and the keepalive guarantees a send)
    and the age saws 0 → ~140 s regardless of the user, while a keypair older than
    `RejectAfterTime` = 180 s is refused for BOTH send and receive — so
    `WG_HANDSHAKE_DEAD_SECONDS = 180` (`connect-decisions.ts`) is the protocol's own
    line, not a tuned number; read it out of amneziawg-go's `device/constants.go`
    before touching it. The daemon's `wireguard_handshake` op does the read (`wg show
    sntl0 latest-handshakes` needs CAP_NET_ADMIN — verified in a container:
    `Operation not permitted` as a normal user) through the `Env` seam with no new Go
    dependency, and it is **daemon-only, never pkexec**: a 15 s poll cannot carry a
    password prompt, so no daemon means the app keeps only the detectors above.
    `WG_HANDSHAKE_STALE_SAMPLES` consecutive stale ticks are required, and the count is
    measured rather than chosen: a returning peer needs the 15 s keepalive to drive a
    rekey before the age resets, which took 10-20 s, so two samples (15 s apart) sit
    INSIDE that window — a 90 s blackout that healed cleanly was observed ONE sample
    short of ending a live session. On detection the floor is pulled back to
    `latestProofOfLifeMs`, the later of the handshake and the last inbound byte, NOT the
    handshake alone: that is ~130 s stale on a healthy tunnel and collapsed
    `durationSeconds` to 0 when the peer died before the first rekey (#61725835, 1.3 MB
    received, zero seconds recorded). It proves the PEER answers,
    not that the node forwards, so it ADDS a detector and replaces neither the probe nor
    `isTunnelOneWay`. AmneziaWG is deliberately NOT covered: its `sntl0` is a `type tun`
    with no UAPI socket, so the op answers `kernel:false` and the check abstains — that
    blind spot stays. Known residual, quantified: an unbroken outage that spans the rekey
    point and is still running when the samples are taken ends a session that would have
    healed. Past 180 s the keypair is refused, so nothing is flowing at that moment
    either, and the session stays open on chain with a reconnect offered.
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
  during the dialog, so the renderer's status poll never observed the gap. WireGuard was never
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

- **The tunnel never outlives the app, and NOTHING outside the app will end it.** A crash
  leaves everything running by construction: WG/AWG/OpenVPN interfaces are kernel-resident
  and root-created, tun2socks is spawned detached by the helper, and the daemon has no
  notion of whether a GUI is alive (the daemon's socket close carries no meaning, since
  `daemon-client` opens one connection per request by design, and the unit has no
  `ExecStop`). Teardown is therefore the app's job on both exit paths:
  - **Quit** runs `cleanupOnQuit` → `performDisconnect()`, NOT a lighter copy of it. The
    copy skipped `rememberSessionUsage()` (a quit mid-session wrote no usage floor, so the
    gauge fell back to the lagging chain figure), `isIntentionalDisconnect` + clearing
    `activeSessionId` (so `disconnect()`'s SIGTERM to the core made `onV2RayUnexpectedExit`
    schedule a reconnect *during* the quit), and the `connectionEpoch++` that makes an
    in-flight connect bail. The ordering inside `performDisconnect` is load-bearing:
    `stopQuotaWatchdog()` nulls `connectedAtMs`, which `rememberSessionUsage()` needs, so it
    must run AFTER it. **Never pre-stop anything from the quit path.** Still capped by
    `before-quit`'s 5s race, so on the pkexec path an unanswered polkit prompt outlives the
    budget and the next launch's heal finishes the job.
  - **Crash** is repaired by `healOrphanedTunnel()` at startup, ordered between
    `detectExistingConnection()` (which sets `activeProtocol`, so `disconnect()` picks the
    matching teardown verb) and `healStrandedKillSwitch()` (which skips while a tunnel is
    up, so it must see the state this leaves, not the one it found). An adopted tunnel has
    NO session behind it, because `activeSessionId` is only ever assigned on the
    connect/reconnect paths: `startQuotaWatchdog` and `startRootTunnelMonitor` never
    restart, so the paid quota goes unwatched, and the kill switch cannot even be armed
    against it (`armedWith` is null and there is no endpoint recorded to whitelist, so
    enabling it just sets `killSwitchFailed`). That is worse than no tunnel, so it is closed
    and the user reconnects from the Sessions tab, which restores the session and the
    watchdog properly. Traffic is deliberately NOT left blocked afterwards: full
    `revertPostConnectSettings`, per the rule that "expired, traffic blocked" must not
    survive a restart.
  - **The teardown MUST tell the tray.** `createTrayIcon()` reads `getConnectionStatus()`
    synchronously at startup, i.e. BEFORE the teardown's privileged round-trip returns, so
    it caches "connected" off the very interface about to be deleted, and the tray only
    ever updates on a push, unlike the renderer, which also polls. `healOrphanedTunnel` therefore
    ends at `notifyTraySettled()`. Live symptom (2026-08-26): idle window, orphan banner
    and a green tray dot, all at once.
  - **Proxy cores are reaped by pid, and an orphan does NOT die on its own.** Measured
    2026-08-26 against the bundled xray: parent killed, child reparented to PID 1, still
    listening 20s later. The plausible escape (piped stdio, so a write should raise SIGPIPE)
    never fires, because at `loglevel: warning` an idle core writes nothing. It then holds
    `127.0.0.1:1080` and the next connect's core exits with "process exited immediately
    after starting", pointing at nothing. `proxy-children.ts` (Electron-free, unit-tested
    against real processes) records pid+exe+configFile at spawn and clears it from the
    child's own `exit`; the reap signals only when BOTH `/proc/<pid>/exe` matches AND the
    recorded config path appears as a whole argv entry, because the pid may have been reused
    and the user may run their own v2ray/xray (`resolveV2RayBinary` falls back to the system
    one). **Never reap by process name.**
  - The window's X is NOT a quit: with a tray host it hides, without one it falls through to
    `window-all-closed` → `app.quit()`. And the `state === 'connected'` window during startup
    healing is HONEST, not a glitch to paper over: the orphan really is carrying traffic
    until it is torn down, so the IP display and tray are right to say so for those seconds.
    Do not add a "verifying" state (see the rule above forbidding one).
