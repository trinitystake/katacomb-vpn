# Multi-hop VPN audit

Audit of the two-hop (multihop) chain feature: hop selection, purchase, handshake,
tunnel establishment, state management, failover, kill switch / leak protection, DNS,
UI and logging.

Date: 2026-08-15. Scope: `main` at 5bf6ac3. Method: source read against the live
invariants recorded in `CLAUDE.md`, the go-sdk/dvpnx behaviour those cite, and the
bundled `@sentinel-official/sentinel-js-sdk` 2.0.4.

Remediation status for every finding is at the bottom.

---

## 1. Feature map

**Pure logic (Electron-free, unit-tested)**

- `src/main/multihop-config.ts` — the chain builder: `buildMultihopConfig`,
  `selectHopEntry`, `classifyHopEligibility`, `normalizeTlsPin`, `EXIT_TRANSPORTS`,
  `isChainGradeSecurity`
- `src/main/multihop-config.test.ts` — 30 tests, all against the builder/grader
- `src/main/connect-decisions.ts` — `refundEachInTurn`, `chainFailureMessage`,
  `deadTunnelMessage`, `evaluateQuota`
- `src/renderer/utils/chain-diversity.ts` — advisory ASN / /24 / domain / country
  overlap checks

**Orchestration (main process)**

- `src/main/ipc-handlers.ts` — `CONNECTION_SUBSCRIBE_CHAIN`, `establishChainOrRefund`,
  `refundSessions`, `assertChainEligible`, `applyChainSession`, the chain branch of
  `CONNECTION_RECONNECT`, `NODE_CHAIN_ELIGIBILITY`, the dual quota
  (`activeExitQuota` / `currentQuotaVerdict`), `getOtherWalletSessions`,
  `WALLET_END_SESSION`, `WALLET_LINK_CHECK`
- `src/main/chain-service.ts` — `performChainHandshake`, `handshakeChainHop`,
  `sendChainHopProgress`, `SavedSessionConfig.chainPeerSessionId` / `chainRole` /
  `walletId`, `retireSessionConfig`
- `src/main/vpn-manager.ts` — `extractV2RayRemoteHost` (picks the direct-dial outbound,
  i.e. the entry, and feeds both the tun2socks bypass route and the kill-switch
  whitelist), `connectXRayFromConfig`
- `src/main/config-guard.ts` — `pinV2RayNodeAddresses`, `assertSafeV2RayConfig`,
  `withV2RayDoH`
- `src/main/kill-switch.ts` via `armKillSwitch`; `src/main/wallet.ts`
  `findTransferBetween`; `src/main/node-tester.ts` `fetchNodeServiceMetadata`

**UI**

- `src/renderer/components/MultihopModal.tsx` (picker, confirm, per-hop progress,
  connected summary), `src/renderer/hooks/useChainEligibility.ts`,
  `src/renderer/components/ActiveSessions.tsx` (the chain drawn as one card, "End
  both"), `src/renderer/components/ConnectedBar.tsx` (exit-hop badge),
  `ConnectErrorActions.tsx`, `src/renderer/hooks/useReconnect.ts`

**How the flow works today**

The user picks two V2Ray/XRAY nodes in `MultihopModal`. Every v9 candidate is graded by
probing the node's own root path (`classifyHopEligibility`: TLS or Reality on both ends,
plain TCP on the exit) and rows without positive evidence are disabled. On "Buy both
hops", main runs `preflightConnect` and `assertChainEligible` for each hop, checks funds
(per account when a second wallet pays for the exit), then `establishChainOrRefund` buys
the entry session, buys the exit session, resolves both endpoints and handshakes both
nodes directly over HTTPS, signing each with its owning account's key.
`buildMultihopConfig` turns the two handshake responses into one xray config with two
outbounds, where the exit carries `proxySettings: {tag: 'entry-out'}` so xray dials it
through the entry, and the exit is `outbounds[0]` so it is the default egress. Any
failure refunds both sessions sequentially. The config is saved under both session ids
(with `chainPeerSessionId` / `chainRole`), stashed as `activeXrayConfig`, and brought up
by the ordinary xray path: pin hostnames to IPv4, validate, optional DoH, spawn xray,
tun2socks TUN with a bypass route to the entry IP only, kill switch whitelisting the
entry IP only, then `assertTunnelCarriesTraffic`. While connected, both sessions' quotas
are scored against the same interface counters with the worst verdict winning; the
Sessions tab draws the pair as one card and "End both" cancels them one at a time.

---

## 2. Findings

### Bugs

#### B1. After a Sessions-tab reconnect, the exit hop's quota is never watched

**Severity:** Medium
**Location:** `src/main/ipc-handlers.ts` — chain branch of `CONNECTION_RECONNECT`
(~:2610), `startQuotaWatchdog` (~:487)

The chain branch of `CONNECTION_RECONNECT` restores `activeExitSessionId` and
`activeExitNodeInfo` but never sets `activeExitQuota`, and `startQuotaWatchdog` only
repairs `activeQuota`. A chain reconnected after an app restart is therefore scored
against the entry hop alone. If the exit runs out first, `currentQuotaVerdict` stays
`ok`, the node stops forwarding, and the only remaining safety net is
`checkTunnelStalled`, which needs 64 KB out plus 90 s of silence. The "worst verdict
wins" design is inert on exactly the path that matters most.

**Fix:** In `startQuotaWatchdog`, mirror the entry repair for the exit, sourced from
`lastKnownSessions` the same way.

#### B2. The entry hop's saved config records no `walletId`, so switching wallets orphans half the chain

**Severity:** Medium
**Location:** `src/main/ipc-handlers.ts` `activeSigner` (~:2454),
`src/main/chain-service.ts` `performChainHandshake`'s save loop (~:750),
`getOtherWalletSessions` (~:1878), `WALLET_END_SESSION` (~:2086)

`activeSigner` is built without a `walletId`, so `saveSessionConfig` writes
`walletId: undefined` for whichever hop the active wallet paid for.
`listSessionsOwnedByOtherWallets` only returns records that carry one. If the user
switches the active wallet (which per-hop chains actively encourage, since the second
wallet sits in the same picker), the entry hop disappears from the Sessions tab, and
`WALLET_END_SESSION` signs its cancel with the wrong account, so the chain rejects it
and the deposit is stranded. Same class as the "all three writers of
`lastKnownSessions`" invariant, one layer down.

**Fix:** Always record the owning wallet id on both hops, and treat "recorded id is not
the active id" as foreign rather than relying on absence meaning "active".

#### B3. `failedRole` is never set for handshake or build failures, so chain errors name the wrong node

**Severity:** Medium
**Location:** `src/main/ipc-handlers.ts` `establishChainOrRefund` (~:1268),
`src/main/connect-decisions.ts` `chainFailureMessage` (~:79)

`failedRole` is reset to `null` before the endpoint resolves and is only reassigned
inside the two `resolveNodeRemoteUrl` catches. Every failure out of
`performChainHandshake` (both handshakes, `V2RayPolicyError`, every
`buildMultihopConfig` throw) therefore leaves it `null`, and `chainFailureMessage` falls
back to `entry.nodeMoniker`. A cleartext **exit** produces `Node "<entry moniker>" only
offers unencrypted (VLess-none) inbounds`, pointing the user at the wrong end of the
chain, and both sessions have just been refunded on the strength of that message.

**Fix:** Tag the role at the throw site (`handshakeChainHop` already knows it) and read
it back in the catch, falling back to null only for genuinely role-less failures.

#### B4. Reality inbounds are selected without checking they carry keys, so a node can sell an unbuildable chain (with no refund path)

**Severity:** Medium
**Location:** `src/main/multihop-config.ts` `selectHopEntry` (~:210), `buildHopOutbound`
(~:319); the same gap single-hop in `src/main/xray-config.ts` `selectXRayEntry` (~:93)

`selectHopEntry` refuses a TLS inbound whose `tls_pin` does not normalise but applies no
equivalent test to Reality, and Reality is preferred first. A node advertising
`transport_security: 3` with an empty `reality_public_key` is chosen over a perfectly
good TLS inbound on the same node; `buildHopOutbound` emits `publicKey: ''` and the
config builds cleanly. xray then rejects that config at spawn, which happens **after**
`establishChainOrRefund` has returned, so neither deposit is refunded and "Retry
connection" can never succeed. Node data is adversarial by this repo's own threat model,
and this is the one metadata field the builder takes on trust.

**Fix:** Require a syntactically valid Reality entry (a `reality_public_key` that decodes
to 32 bytes, and a non-empty `reality_server_name`) exactly as TLS requires a usable pin.
Keep the check out of `classifyHopEligibility` — the public root listing blanks those
fields by design, so the builder stays the final say and a lying node gets refunded
rather than paid.

#### B5. "Start over" after a paid chain re-arms the Buy button, which buys a second pair

**Severity:** Medium
**Location:** `src/renderer/components/MultihopModal.tsx` `onStartOver` (~:638) and the
Buy button (~:575)

`onStartOver` clears `paid` and returns to `step: 'confirm'`, where the enabled "Buy both
hops & connect" button calls `connectionSubscribeChain` again. Main still holds the first
pair in `activeSessionId` / `activeExitSessionId` / `activeXrayConfig`, and
`applyChainSession` overwrites it, so the first two sessions keep their deposits with
nothing in the UI pointing at them. The "retry, don't re-buy" invariant is honoured by
the Retry button and defeated by the secondary link next to it, at double cost.

**Fix:** When two sessions are already paid for, the secondary action must not lead back
to the purchase form. Name both session ids and send the user to the Sessions tab.

#### B6. The per-hop progress replays entry then exit twice, so both hops visibly jump backwards

**Severity:** Low
**Location:** `src/main/ipc-handlers.ts` (~:1259, :1264) vs `src/main/chain-service.ts`
(~:740, :744); rendered by `MultihopModal.tsx` `hopState` (~:680)

`sendChainHopProgress` fires four times per build: entry (buy), exit (buy), entry
(handshake), exit (handshake). `hopState` derives state purely from the last marker, so
the sequence renders as entry active, entry done + exit active, then **exit back to
pending and entry active again**. That is the same "counts up, jumps back" the marker was
introduced to remove. Related: `HopProgress` prints "Bought and handshaked." for the
entry the moment the *exit purchase* starts, before any handshake has happened.

**Fix:** Make the marker carry the phase as well as the role and track a monotonic
per-hop stage in the modal, with labels that match the phase that actually finished.

### Security

#### S1. The exit node learns the user's real IP before the chain exists

**Severity:** High
**Location:** `src/main/chain-service.ts` `handshakeChainHop` (~:677) /
`performChainHandshake` (~:724); also `preflightConnect` and `assertChainEligible` on the
exit (`ipc-handlers.ts` ~:2441, ~:2449) and the picker's `NODE_CHAIN_ELIGIBILITY` probes
(~:3140). Claimed otherwise in `MultihopModal.tsx` (~:330, :595, :829)

`performChainHandshake` posts to the **exit** node's API directly from the user's
machine, over the ordinary uplink, before any tunnel is up. That request is signed with
the paying account's key, carries the session id, and shows the node the source IP. It
also correlates trivially with the later traffic: the handshake mints the VLESS UUID the
chained tunnel then presents. The eligibility probe and `preflightConnect` contact the
exit directly too, so a node learns a user is shopping for it even when no chain is
bought. The UI states three times that the exit "never sees your IP"; against a node that
logs handshake source addresses, that is false, and it is the single property the feature
is sold on. Cascading-VPN implementations avoid this either by provisioning both hops
through an out-of-band control plane, or by bringing the first hop up and negotiating the
second through it.

**Fix (preferred):** Bring the entry hop up first as a local proxy (this app already
supports `mode: 'proxy'`: one xray process on 127.0.0.1:1080), run the exit's
eligibility check, preflight and handshake through that SOCKS listener, then rewrite the
config with both outbounds and restart. This is a real reordering of
`establishChainOrRefund` and needs the handshake POST to accept a proxy agent, which the
bundled SDK's `handshake()` does not offer.
**Fix (interim):** State it plainly in the UI, in the picker, the confirm step and the
threat-model block.

#### S2. The exit node's hostname is resolved by the local resolver before connecting

**Severity:** Medium
**Location:** `src/main/config-guard.ts` `pinV2RayNodeAddresses` (~:300, maps over every
outbound), called from `vpn-manager.ts` (~:859) with `resolveHostToIPv4` (~:304, `getent`,
i.e. the system/ISP resolver)

`pinV2RayNodeAddresses` pins both outbounds, so the exit hop's hostname is looked up in
cleartext on the user's own network at connect time. The header comment in
`multihop-config.ts` says the opposite ("the entry node resolves it for us"). The
observer a chain is bought to defeat, the local network, therefore learns which exit was
chosen, seconds before the circuit comes up. This is a DNS-only leak: no packet is ever
sent to the exit's address directly, and the kill switch and bypass route correctly name
the entry only.

**Fix:** Note that the obvious fix (skip outbounds carrying `proxySettings`, leaving the
exit as a domain for xray's detour dialer to hand to the entry) is only safe if xray
never resolves a detoured destination locally. If it does, the query is emitted *after*
the TUN is up, goes through the tunnel, and needs the exit to be reachable to resolve the
exit: the v2ray DNS deadlock, on a path that has already spent two deposits. The
risk-free equivalent is to keep pinning but resolve the exit hop over DoH from the app,
before the tunnel exists, falling back to the current `getent` behaviour.

#### S3. Every hop's key material arrives over a TLS channel with no certificate validation

**Severity:** High (architectural, inherited from the SDK; worst here)
**Location:** `node_modules/@sentinel-official/sentinel-js-sdk/dist/utils.js` (~:88,
`rejectUnauthorized: false` on the handshake POST); `src/main/node-tester.ts` (~:6, the
same for probes and the pre-purchase listing)

The handshake request is signed by the client, but the **response** is authenticated by
nothing. The TLS pin, the Reality public key, the port and `addrs` all come back over a
connection that accepts any certificate, and they are precisely what the chain's
confidentiality then rests on. An on-path attacker (the ISP) can answer the entry
handshake with its own metadata and become the entry hop; `normalizeTlsPin` and
`buildHopOutbound` will faithfully pin the attacker's certificate. The green "wrapped in
TLS/Reality" badge is derived from the same unauthenticated channel. Not
multihop-specific, but multihop is the one feature whose stated adversary includes the
local network.

**Fix:** There is no key on chain to verify against, so the honest options are (a)
trust-on-first-use: persist `nodeAddress -> cert SHA-256` and refuse a silent change,
which catches an ISP that was not present at first contact; (b) cross-check the
pre-purchase listing against the handshake response and refuse a downgrade; (c) at
minimum, document the limit where the UI currently implies the wrapping defeats the ISP.

#### S4. Default settings leave DNS outside the chain, and the modal never mentions it

**Severity:** Medium
**Location:** `src/main/settings.ts` defaults (`killSwitch: false`,
`dnsResolver: 'system'`), `ipc-handlers.ts` `effectiveV2RayResolverIp` (~:149) and
`applyPostConnectSettings` (~:1382)

With the defaults, `effectiveV2RayResolverIp` returns null: no `dns-set`, no DoH
injection. Queries go to whatever `/etc/resolv.conf` holds, which on a normal desktop is
a LAN or loopback-stub resolver forwarding to the router, and a LAN route is more
specific than tun2socks' `/1` halves, so it never enters the tunnel. The ISP sees every
domain visited while a two-hop chain is up. The modal's threat-model block covers
correlation, cost and latency but says nothing about DNS, while the entry-hop hint claims
the entry sees "nothing about where you go".

**Fix:** Warn on the confirm step when the resolver is `system` and the mode is a full
tunnel, with a one-click switch to an encrypted resolver, and say it in the threat-model
block. The DoH injection path already exists and lands on `exit-out`.

#### S5. The wallet-link check proves less than the copy claims

**Severity:** Low
**Location:** `src/main/wallet.ts` `findTransferBetween` (~:313); copy in
`MultihopModal.tsx` (~:495)

`findTransferBetween` searches only for a direct transfer in either direction between the
two addresses. On a clean result the UI says "No transfer between these two accounts, so
nothing on chain joins them and neither node can look the other up." Two wallets funded
from the same exchange withdrawal, or from a common third address, are joined just as
publicly one hop further out, and the check cannot see it. Given how carefully the rest
of this modal avoids overclaiming, the sentence stands out.

**Fix:** Narrow the wording to what was actually tested, and name the case it misses.

#### S6. The xray log survives disconnect and can contain hop addresses and failed destinations

**Severity:** Low
**Location:** `src/main/vpn-manager.ts` `spawnV2Ray` (~:490)

`~/.config/katacomb-vpn/xray.log` (mode 0600, truncated per spawn, never deleted)
captures xray's stderr at `loglevel: warning`, which for a chain includes both hops'
addresses in dial failures and destination hosts in "failed to process outbound traffic"
lines. It outlives the session and the app.

**Fix:** Delete it on disconnect and keep the in-memory ring buffer, which is what the
error surfacing actually reads.

### Performance

#### P1. Opening the picker probes every v9 candidate on the network

**Severity:** Low
**Location:** `MultihopModal.tsx` `checkable` (~:805), `useChainEligibility.ts` (~:32),
`ipc-handlers.ts` `NODE_CHAIN_ELIGIBILITY` (~:3160)

`checkable` is derived from `matches`, not from `visible`, so with no filters applied the
first open fires an HTTPS probe at every healthy v9 V2Ray/XRAY node (200+ by the repo's
own measurements) at concurrency 8 with a 10 s timeout each. Slow first impression, and
it is also the fan-out that makes S1's "every node learns you are shopping" broad rather
than narrow. The reason for grading everything is sound (the sort and the "verified exits
only" filter both need grades beyond the visible rows); the cost is simply unbudgeted.

**Fix:** Grade the visible rows first so the list settles immediately, then continue
through the rest. Main's 10-minute cache already makes repeat opens free.

#### P2. Two identical root-path requests per hop on the connect button

**Severity:** Low
**Location:** `ipc-handlers.ts` (~:2440), `node-tester.ts` `fetchNodeRoot` (~:173)

`preflightConnect` and `assertChainEligible` each call `fetchNodeRoot` on the same URL, so
the pre-purchase gate makes four requests to two nodes where two would do, each with a
10 s timeout in front of the user. The fresh (uncached) read is deliberate and worth
keeping; the duplication is not.

**Fix:** Reuse the response within the same connect attempt.

#### P3. Latency and byte accounting

**Severity:** Informational

The ~20x latency is measured and disclosed. One accounting note: both hops meter the same
stream, but the entry meters the *encapsulated* bytes, so the chain's on-chain figures
run slightly ahead of the tun counter `evaluateQuota` scores against. That makes the
watchdog marginally late rather than early, which is the safe direction, and the next
chain read corrects the baseline.

### UX / workflow

#### U1. Pre-9.0.0 nodes are disabled, but the surrounding copy and one whole branch still assume they are selectable

**Severity:** Low
**Location:** `MultihopModal.tsx` (~:32 comment, ~:844 body copy) contradicted by ~:903
(`refused` disables them), which also makes the confirm-step block at ~:336 unreachable.
The `MAX_ROWS` comments at ~:776 and ~:795 still say "only 50 rows render" (now 300).

A user who reads the header text expects to be able to pick an old node and be refunded if
it fails; the row is greyed out with a tooltip saying the opposite. In a file this
carefully commented, the stale comments will mislead the next change as much as the user.

**Fix:** Delete the dead branch, correct the copy, update the stale counts.

#### U2. A chain that stands down for quota does not say which hop ran out

**Severity:** Low
**Location:** `ipc-handlers.ts` `standDownSession` (~:654, always reads
`activeNodeInfo` = the entry), `lastExpiry` (~:390)

`currentQuotaVerdict` knows which of the two quotas fired and then discards it. The user
is told "Session ended" with the entry node's name even when the exit expired, which is
the wrong node to replace next time.

**Fix:** Carry the losing quota out of `currentQuotaVerdict` and name the hop in the
banner and the notification.

#### U3. Dead export

**Severity:** Low
**Location:** `useChainEligibility.ts` `probeOne` (~:61)

No callers. The repo lists unexported-helper drift as a known antipattern.

#### U4. No handling of a network change or resume mid-chain

**Severity:** Low (affects every tun2socks protocol; a chain is the longest-lived and
slowest to rebuild)
**Location:** no `powerMonitor` or connectivity listener anywhere in main;
`startRootTunnelMonitor` deliberately excludes xray (`ipc-handlers.ts` ~:331);
`bringUpTun` pins the gateway and interface at bring-up (`vpn-manager.ts` ~:384)

On a Wi-Fi to wired/cellular switch, or a laptop resume onto a different network, the
bypass route to the entry IP is stale while the xray process stays alive, so nothing
notices until `checkTunnelStalled` accumulates 64 KB out and 90 s of silence. There is no
leak (traffic dies inside the tun), but the UI says "connected" for up to two minutes and
the auto-reconnect ladder never starts.

**Fix:** Watch the default route while a child-proxy tunnel is up and treat a change like
an interface drop.

### Open question

`sendChainHopProgress` is exported from `chain-service.ts` and called from two modules for
two different phases. Was the marker meant to say "this hop is being worked on right now"
(making B6 a UI bug) or "this hop's purchase has begun" (making the second pair of calls
the redundant one)? The fix differs. This audit assumed the former.

---

## 3. Fix first

1. **S1** — the exit hop sees the user's real IP at handshake time. Either negotiate the
   exit through the entry, or stop promising it does not.
2. **B4** — unvalidated Reality keys let a node take two deposits for a chain that can
   never start, with no refund path.
3. **S2** — stop the exit's hostname going through the ISP's resolver.
4. **B1** — repair `activeExitQuota` on reconnect so a chain is watched on both halves.
5. **B2 / B5** — record the owning wallet on both hops, and stop "Start over" re-buying a
   pair that is already paid for.

---

## 4. Remediation

Every finding was acted on. Two were fixed differently from the suggestion above, for
reasons given below; one (S1) is only half fixable without a redesign, and the half that
is not fixed is now stated in the UI instead of contradicted by it.

Verified by `npm run typecheck` (clean), `npm test` (480 pass, up from 445) and
`npm run build` (clean), and **since 2026-08-15 against a live mainnet chain** — see
"Measured on a live chain" below for what that did and did not cover.

| # | Status | Where |
|---|--------|-------|
| B1 | Fixed | `ipc-handlers.ts` `startQuotaWatchdog` repairs `activeExitQuota` from `lastKnownSessions`, exactly as it already did for the entry |
| B2 | Fixed | `activeSigner` now carries `walletId: getActiveWalletId()`, so both hops record their owner |
| B3 | Fixed | `chain-service.ts` tags handshake errors with their hop (`tagChainHopRole` / `chainHopRoleOf`, non-enumerable so `instanceof` and the axios `response` still work); `establishChainOrRefund` prefers the tag over `failedRole` |
| B4 | Fixed | `isUsableReality` in `multihop-config.ts` + `isUsableXRayReality` in `xray-config.ts` (single-hop had the identical gap). `selectHopEntry` refuses an unusable Reality entry, `requireEntry` reports it distinctly, and `isShapeUsable` was split out so a grpc-only exit is still reported as a transport problem, not a key problem. 6 new tests, including one that pins the two duplicated validators together |
| B5 | Fixed | With two sessions paid for, "Start over" closes the modal instead of returning to the live Buy button, and a new panel names both session ids and where to end them |
| B6 | Fixed | Markers are now `hop:<role>:<phase>`; `hopStage` maps the four-marker sequence to a monotonic per-hop stage (`pending → buying → bought → handshaking → done`), and each stage has an accurate label |
| S1 | **Fixed** (2026-08-15, second pass) | The exit is now provisioned through the entry. See "S1, closed" below |
| S2 | **Fixed differently** | The exit's address is resolved over DoH inside `performChainHandshake` (`resolveExitHostPrivately`, using the user's chosen resolver when they have one), so the ISP never sees the lookup and the config still reaches xray as an IP literal. See below for why the suggested fix was not taken |
| S3 | Documented | A paragraph in the threat-model block states that each hop authenticates with keys it sends over a channel with nothing to verify it against. TOFU pinning is not implemented |
| S4 | Fixed | The confirm step warns when the resolver is System Default on a full tunnel, with a one-click switch to encrypted DNS |
| S5 | Fixed | The clean result now says "no **direct** transfer" and names the case it misses (both wallets funded from one third account) |
| S6 | Fixed | `vpn-manager.disconnect()` deletes the core's log; the in-memory ring buffer that error reporting actually uses is untouched |
| P1 | Fixed | The picker probes the rendered rows first, then the rest, so the visible list settles in the first chunk and an abandoned picker contacts far fewer operators |
| P2 | Fixed | A 5 s success-only memo on `fetchNodeRoot`, so `preflightConnect` and `assertChainEligible` share one request per node (4 requests to 2 for a chain) |
| P3 | No change | Informational; the bias is in the safe direction |
| U1 | Fixed | Dead confirm-step branch removed, three stale comments corrected, `MAX_ROWS` references no longer say 50 |
| U2 | Fixed | `currentQuotaVerdict` returns the losing session; `standDownSession` reports that hop's node and role, and the banner names it. A stall claims no role, because nothing can attribute one |
| U3 | Fixed | `probeOne` removed |
| U4 | Fixed | `hasDefaultRouteChanged()` in `vpn-manager.ts` (tun2socks never replaces the default route, so the comparison stays meaningful), watched on the existing 5 s monitor, which now covers the child-proxy protocols in tunnel mode too |

### S1, closed

Done in a second pass, after research against upstream established the two facts it
depended on. Plan: `~/.claude/plans/on-s1-do-an-zany-tower.md`.

**Why it is safe to provision from one address and connect from another:** the node
stores no client IP. `sentinel-dvpnx` `api/handshake/handlers.go` persists account
address, node address, peer id, session id, quotas, peer metadata, the peer request,
byte counters, service type and signature, and nothing else. The peer is not bound to
the source address. (The reference node does not log IPs either: `node/setup.go` uses
`gin.New()` with only CORS and a rate limiter, no logger middleware. So the exposure
always needed a modified node, a reverse proxy in front, or capture at the OS level —
real, but not automatic.)

**The order now is:** buy entry → handshake entry → stand up an entry-only xray on
127.0.0.1:1081 (`buildEntryOnlyConfig` + `startProvisioningProxy`) → run the exit's
preflight, eligibility gate and handshake through it via `SocksHttpsAgent` → stop the
proxy → build the chained config → hand off to the existing connect path, untouched.
The provisioning phase is entirely rootless: no TUN, no firewall, no polkit.

**New code:** `socks-agent.ts` (SOCKS5 no-auth CONNECT as an `https.Agent`, hand-rolled
rather than adding a dependency on the path that authenticates us to a node),
`node-handshake.ts` (the signed POST, because the SDK's takes no agent),
`buildEntryOnlyConfig`, `startProvisioningProxy`. 20 new tests, including a real
stub-proxy exchange and `node-handshake.test.ts`'s capture of the live SDK request,
which asserts our body is byte-identical to it.

**Deliberate choices worth keeping:** the provisioning proxy is never registered as the
active connection (registering it would make `getConnectionStatus()` report connected
and `isVpnActive()` lie while a chain is still being bought); the exit purchase is
broadcast directly, since a public transaction tells the exit nothing its own session
row does not, and that keeps CosmJS off the proxy; proxied calls get their own longer
timeouts, because a timeout there strands an entry that is already paid for.

**Accepted cost:** the exit's eligibility gate now runs after the entry is bought, so a
bad exit costs an entry refund rather than nothing. The picker already refuses an exit
without positive evidence, so this is a backstop against a node that changed since it
was graded.

**Still residual:** the picker's bulk grading, when no tunnel is up. It carries no wallet
and no session and goes to hundreds of nodes at once, so a node learns "an address looked
at me" with nothing to attach it to — a different kind of exposure from the signed,
session-bound, immediately-followed-by-traffic contact that was closed. The modal says
so rather than implying otherwise.

What it is NOT is a leak whenever a tunnel exists. Checking the routing rather than
assuming: in tunnel mode the OS already carries these probes through the tunnel
(wg/awg/openvpn replace the default route; the helper gives tun2socks `0.0.0.0/1` +
`128.0.0.0/1`, and only the connected node's own `/32` bypasses it), so grading was
private there all along and needed no code. **Local-proxy mode was the exception** — it
leaves routing untouched by design, so a tunnel existed while our own probes went out on
the physical NIC. `getActiveProxyPort()` + the `SocksHttpsAgent` built for S1 now put
grading through that listener. A proxied probe that fails reports the row as unknown and
never retries direct: falling back would silently leak the address the route exists to
hide.

So the residual is now precisely "grading from a cold start, with no tunnel of any kind"
— which is the case the picker is usually used in, and closing it would mean grading
exits only after an entry is already bought.

### Measured on a live chain

2026-08-15, mainnet, entry `45.124.52.245` (grpc/TLS) → exit `217.154.177.24` (tcp/TLS),
sessions #55313487 (entry) and #55313511 (exit) on two different accounts. Read-only
inspection of a chain the maintainer had already brought up. Both sessions have since
settled and been deleted by the chain with nothing stranded.

| Invariant | How it was checked | Result |
|---|---|---|
| Provisioning proxy is torn down | `ss -tlnp` | nothing on :1081, one xray, one tun2socks |
| Exit is reached THROUGH the tunnel | `ip route get 217.154.177.24` | `dev sntl-tun` |
| Entry is the only direct dial | `ip route get 45.124.52.245` | `via 192.168.20.1 dev wlp3s0` |
| Only the entry gets a bypass route | `ip route show` | one `/32`, entry; none for the exit |
| Exit must be plain TCP | live config | `exit-out` tcp+tls with `proxySettings.tag: entry-out` |
| Both hops TLS or Reality | live config | entry grpc+tls, exit tcp+tls |
| Egress is the exit | public IP lookup | `217.154.177.24`, exactly the exit |
| DNS cannot leak | `ip route get 9.9.9.9` | `dev sntl-tun`; DoH to Quad9, bootstrap pinned |
| DNS is hidden from the ENTRY too | live config | `dns-module` routed to `exit-out` |
| Per-hop wallets | chain query | two distinct accounts |
| Credentials never plaintext | `sessions/*.json` | safeStorage blobs, not JSON |
| **Only the entry is ever dialled** | `ss -tnp` | xray holds ONE outbound socket, to the entry; **zero sockets to the exit IP anywhere on the host** |
| Kill switch whitelists the ENTRY | `iptables -S KATACOMB_KILLSWITCH` | `-d 45.124.52.245/32 -j ACCEPT` present |
| Kill switch does NOT whitelist the exit | same | absent, correctly; trailing `-j DROP` present |
| Nothing bypasses the tunnel | `ss -tn` on the physical NIC | zero flows except the entry |

The **string-port fix** (`SocksHttpsAgent`, `postHandshake`) is live-verified by this chain
existing at all: the exit's peer material can only have come from the proxied handshake.

**Two findings from the live run, neither a defect in this code:**

- **The exit node never submitted a usage proof.** #55313511 read 0s and 0.00 MB after
  ~16 MB had crossed the tunnel, and its `inactiveAt` did not move between readings a
  minute apart — so `lastNodeProof + statusTimeout` had never been refreshed. It settled
  at zero usage, so the hop cost gas only. Harmless here, but a node that never proves
  will have its session reaped on the idle deadline while the UI says connected, which is
  the dead-tunnel tell `CLAUDE.md` describes. Worth treating as a node-quality signal.
- **The kill switch's `-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT` is broader
  than its comment.** It is documented as being "for the tunnel itself", but the tunnel's
  own outer connection is already covered by the entry whitelist two rules above it. What
  it actually permits is any established flow egressing any interface, so a connection
  opened over the physical NIC *before* connecting can keep running outside the tunnel
  while the kill switch is armed. Measured as **latent, not active**: zero non-entry flows
  existed on the NIC. Flows that were inside the tunnel are sourced from `198.18.0.1` and
  cannot survive the interface going away, so the tunnel-drop case is likely covered. Not
  changed here: it is a root-run firewall rule and the change needs its own pass through
  `scripts/verify-deb-portability.sh`.

**Still unverified, because each needs a fresh connect rather than a running one:** the
provisioning-window check (during setup, no socket to the exit may exist — the decisive
S1 proof), the fail-closed path, and a single-hop regression on v2ray/xray.

### Where the other fix differs from the suggestion

**S2 took the opposite approach to the one suggested.** "Pin only the direct-dial
outbound" is correct only if xray never resolves a detoured destination locally. If it
ever does, the lookup is emitted after the TUN is up, routes into the tunnel, and needs
the exit reachable in order to resolve the exit: the v2ray DNS deadlock, on a path that
has already spent two deposits. Resolving the exit over DoH before the tunnel exists
closes the same leak with no way to deadlock, and degrades to today's behaviour if the
DoH request fails.

### Not fixed, and why

- **S3's trust-on-first-use pinning.** Research settled the question this depended on:
  `sentinel/node/v3/node.proto` gives `Node` only `{address, gigabyte_prices,
  hourly_prices, remote_addrs, inactive_at, status, status_at}`. There is no
  certificate, fingerprint or public key on chain, so there is nothing to verify a node
  against and TOFU is the only option that exists. It belongs to the whole app rather
  than to multihop, changes the failure mode of every connect, and cannot be validated
  without live nodes. Documented in the UI instead.
- **The picker's grading from a cold start** (see "S1, closed"): a deliberate residual,
  not an oversight. It now rides whatever tunnel is up, including local-proxy mode; what
  is left is the no-tunnel case, and closing that means grading exits only after an entry
  has been paid for.
- **`sendChainHopProgress`'s open question** was resolved in the direction this audit
  assumed (the marker means "this hop, this phase, right now"). If the other reading was
  intended, B6's fix is where to change it.

### Noticed in passing, then swept

`standDownSession`'s notifications and several `throw` messages in `ipc-handlers.ts`
(for instance "Can't build the chain — not charged") used em dashes in user-visible
strings, which `CLAUDE.md` rules out. Pre-existing and unrelated to multihop, but swept
on request afterwards: ~100 prose strings across 30 files (main-process error and
notification text, every renderer component, and the shared `funds` / `mnemonic`
helpers), each rewritten with the comma, colon or full stop that fits rather than a
mechanical substitution. Two test fixtures that quoted the old wording were updated with
them.

**Left alone deliberately:** the bare `'—'` used as a "no value" placeholder in table
cells and stat tiles (~29 sites: `NodeTable`, `PlanDiscovery`, `ProviderPlans`,
`ActiveSessions`, `protocols.ts`, and others). That is a typographic convention rather
than prose, it does not read as AI-written, and changing it would alter how every table
looks. Say the word if you want those too. Code comments and `console.*` diagnostics
were also left alone, per the rule's own scope.
