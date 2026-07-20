# Close remaining reliability-review findings — design

**Date:** 2026-07-20
**Source:** `docs/reliability-review.md` (H1/H3/H4 already shipped separately).
**Scope:** the 15 remaining findings, sequenced into 4 themed batches, lowest-risk
first. Each batch: implement → `typecheck` + full suite green → commit. One branch
(`close-review-findings`), a commit per batch; merge decided at the end.

## Roadmap

| Batch | Theme | Findings | Risk |
|---|---|---|---|
| 1 | Timeouts, leaks & writes | M2, M3, L1, L2, L3 | Low |
| 2 | Connection lifecycle | M1, M4, M6, L8 | Higher (concurrency) |
| 3 | Money robustness | H2 | Medium (CosmJS) |
| 4 | Data/seed lifecycle + UX | M5, L4, L5, L6, L7 | Low-medium |

Batches 2–4 are detailed just before they're executed (this doc is updated then).

## Batch 1 — Timeouts, leaks & writes

Mechanical application of patterns already in the repo; no happy-path change. Little
new pure logic — verification is `typecheck` + the existing 96-test suite staying
green + reasoned confirmation each caller already handles a thrown/timed-out connect.

- **M2** — `WALLET_END_SESSION` (`ipc-handlers.ts`): add an `isVpnActive()` guard so
  ending a session while the tunnel is up fails fast ("disconnect first") instead of
  hanging on unreachable RPC. `isVpnActive` is already imported.
- **M3** — add `{ signal: AbortSignal.timeout(15000) }` to the two bare `net.fetch`
  calls (`fetchNodes` at the node-list API, `fetchPublicRpcs`), matching the sibling
  handlers `RPC_CHECK`/`NETWORK_GET_IP`.
- **L1** — `try/finally` so the RPC client is always disconnected on error:
  - `getBalance`, `getActiveSessions` (`wallet.ts`) — move `client.disconnect()` into
    a `finally`.
  - `subscribeToNode` (`sentinel-service.ts`) — keep the parallel connect+query, but if
    the parallel `queryNodeOnChain` rejects, disconnect the signing client that was
    started alongside it (no perf regression; no orphaned client).
- **L2** — wrap the CosmJS `SentinelClient.connect` / `SigningSentinelClient.connectWithSigner`
  calls **outside** `provider-service` in the shared `withTimeout` (from `async-utils`),
  so a slow public RPC fails fast rather than hanging. Sites: `wallet.ts`
  (`getBalance`, `getActiveSessions`), `sentinel-service.ts` (`queryNodeOnChain`,
  `subscribeToNode`, `endSession`), `plan-service.ts` (`discoverPlans`,
  `listNodesForPlan`, `queryPlanAllocations`, `startSessionWithExistingSubscription`,
  `subscribeToPlan`). Local `const RPC_CONNECT_TIMEOUT_MS = 10_000` per file (matches
  provider-service's `CONNECT_TIMEOUT_MS`). Behavior change is hang → fast error;
  callers already `catch`/`try-finally`/propagate-to-renderer.
- **L3** — swap `writeFileSync` → `writeFileAtomic` (from `fs-utils`) in
  `plan-cache.ts` and `provider-cache.ts` `saveToDisk`. `writeFileAtomic` defaults to
  mode `0o600`, matching the current explicit mode.

**Files:** `ipc-handlers.ts`, `wallet.ts`, `sentinel-service.ts`, `plan-service.ts`,
`plan-cache.ts`, `provider-cache.ts`. **Reuse:** `withTimeout` (`async-utils.ts`),
`writeFileAtomic` (`fs-utils.ts`), `isVpnActive` (`vpn-manager.ts`), existing
`AbortSignal.timeout` sites as the template.

## Batch 2 — Connection lifecycle (M1 + M4 + L8; M6 deferred)

- **M1** — `withConnectionLock(fn)`, a promise-chain mutex serializing the tunnel-
  affecting ops (`CONNECTION_CONNECT`, `performDisconnect`, the reconnect timer body)
  so overlapping ops can't orphan a v2ray child. Composes with the shipped H4 epoch:
  the lock prevents concurrent execution, the epoch invalidates a reconnect queued
  behind a disconnect. Reentrancy avoided by locking inside `performDisconnect`/the
  connect body (tray + `cleanupOnQuit` callers don't nest). `CONNECTION_SUBSCRIBE`
  stays unlocked (it preps state, doesn't spawn a tunnel).
- **M4** — in the `CONNECTION_CONNECT` v2ray branch, if `bringUpV2RayTunnel()` throws,
  `await disconnect()` to tear the running v2ray child down before rethrowing.
- **L8** — collapse the duplicated `activeProtocol` to a single source of truth
  (vpn-manager owns process truth; ipc-handlers reads it), IF it can be done without
  destabilizing the WG-monitor gating — otherwise flag and defer.
- **M6** — DEFERRED (self-heals on next launch; UX plumbing not worth it now).

## Batch 3 — Money robustness (outline)

- **H2** — set an explicit `timeoutHeight` on session-creating broadcasts and treat
  CosmJS `TimeoutError` distinctly (poll for a late-landed session and offer to cancel).

## Batch 4 — Data/seed lifecycle + UX (outline)

- **M5** — auto-clear the copied mnemonic from the clipboard (and on unmount).
- **L4** — startup sweep of `sessions/session-*.json` files whose id is no longer active.
- **L5** — clean up root-side runtime residue (daemon `/run/.../sntl0.conf`,
  `SECURE_TMPDIR`, SDK-written temp config).
- **L6** — zero `state.privKey` before reassigning on wallet switch/restore.
- **L7** — give the renderer polling hooks a stale/error surface (lift the `IpDisplay`
  pattern) instead of silent catches.
