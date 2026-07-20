# Connect-path safety + reconnect race fix — design

**Date:** 2026-07-20
**Findings addressed:** H1, H3, H4 (from `docs/reliability-review.md`)
**Out of scope:** H2 (broadcast `timeoutHeight`), M1 (connect/disconnect mutex) — separate follow-ups.

## Problem

Three High findings on the paid connect path and the reconnect machine:

- **H1** — After `subscribeToNode`/`subscribeToPlan`/`startSessionWithExistingSubscription`
  creates a session on-chain (locking funds), only a `V2RayPolicyError` triggers an
  auto-cancel/refund. A failed `resolveNodeRemoteUrl` (outside the try entirely) or any
  non-policy handshake failure re-throws with **no refund** — the deposit/allocation is
  orphaned, recoverable only by the user manually cancelling in the Session tab.
- **H3** — The SDK handshake POST (`utils.js:88-94`) has no `timeout`, so an adversarial
  or dead node that accepts TLS but never replies wedges the *paid* connect flow forever.
  The response is also consumed unvalidated (`JSON.parse(Buffer.from(result.data,...))`).
- **H4** — The reconnect timer body never re-checks intent after its awaits, so a user
  Disconnect that overlaps an in-flight reconnect is silently reversed — the tunnel comes
  back up "connected" after the user disconnected.

## Goals / non-goals

**Goals**
- Any failure between session creation and a live tunnel attempts a bounded refund and
  surfaces an actionable, session-id-bearing message.
- A silent node fails fast (bounded wait) into that refund path instead of hanging.
- An intentional disconnect can never be undone by an in-flight reconnect.
- The two highest-risk decisions become pure, unit-tested functions (closes part of C1).

**Non-goals**
- No happy-path behavior change. No new user-tunable settings (defaults only).
- Not fixing H2/M1 here. Not adding a general connect mutex (M1) — the H4 epoch only
  guards the reconnect-vs-disconnect race, not arbitrary overlapping connects.

## Approach (chosen)

Test-first, with the risky logic extracted into Electron-free pure modules and a thin
imperative shell left in the handlers. H4 uses a **monotonic epoch counter** (approach A);
a plain flag-recheck (B) was rejected because `isIntentionalDisconnect` is transient
(true only during `performDisconnect`), so a reconnect body resolving *after* disconnect
finishes would see it already reset to `false`.

## Components

### 1. `src/main/async-utils.ts` (new) — `withTimeout`

Lift `withTimeout(promise, ms, label)` verbatim out of `provider-service.ts` (races a
timeout against the promise; `clearTimeout` on settle). `provider-service.ts` imports it
from here instead of defining it. Reused by the handshake (H3) and the refund path (H1).

- **Interface:** `withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T>`
- **Depends on:** nothing (pure timers).
- **Note:** bounds the *wait*, not the underlying socket — a timed-out promise's work keeps
  running and is ignored (same limitation `provider-service` already accepts).

### 2. `src/main/connect-decisions.ts` (new) — pure decisions

Electron-free. No imports from `electron`, `wallet`, `vpn-manager`, etc.

- `sessionFailureMessage(opts): string`
  - `opts`: `{ refunded: boolean; isDeposit: boolean; sessionId: string; nodeMoniker: string; reason: string; policyRejected: boolean }`
  - Produces the user-facing error. `policyRejected` selects the VLess-none preamble;
    otherwise a generic "could not establish the tunnel: `<reason>`" preamble. Both share
    the tail: refunded → "the session was cancelled[ and your deposit refunded]"; not
    refunded → "could not auto-cancel — open the Session tab and cancel session #`<id>`
    manually." (Folds in today's wording from `handshakeWithPolicy`.)
- `decideReconnect(opts): ReconnectDecision`
  - `opts`: `{ attempt: number; maxAttempts: number; autoReconnect: boolean; intentional: boolean; hasSession: boolean }`
  - `attempt` = attempts already made. Compute `next = attempt + 1`. Returns, in order of
    precedence: `{ action: 'abort' }` (no session, intentional disconnect, or autoReconnect
    off — do nothing); `{ action: 'give-up' }` (`next > maxAttempts` — tear down to idle);
    else `{ action: 'retry'; attempt: next; delayMs: backoffDelayMs(next) }`. Passing
    `next` (not `attempt`) to `backoffDelayMs` preserves today's timing: first retry =
    `2^1·1000` = 2s.
- `backoffDelayMs(attempt: number): number` → `Math.min(2 ** attempt * 1000, 60000)`.

Both modules get `*.test.ts` under Node's native `--test` runner (matching the existing
setup: import the module under test with a `.ts` extension, excluded from build tsconfigs).

### 3. H1 shell — `establishSessionOrRefund` in `ipc-handlers.ts`

Replaces `handshakeWithPolicy`. Signature (roughly):

```
async function establishSessionOrRefund(params: {
  sessionId: string
  nodeAddress: string; nodeType: 1 | 2; apiField: string
  nodeMoniker: string; nodeCountry: string
  wallet; address: string; privKey: Uint8Array
  isDeposit: boolean
}): Promise<Awaited<ReturnType<typeof performHandshake>>>
```

Body:
1. `try`: `remoteUrl = await resolveNodeRemoteUrl(nodeAddress, apiField)`; `return await performHandshake({ sessionId, ..., remoteUrl, privKey })`.
2. `catch (err)`: attempt refund — `await withTimeout(endSession({ wallet, address, sessionId }), REFUND_TIMEOUT_MS, 'refund')`; set `refunded = true` on success, log + `refunded = false` on failure.
3. Throw `new Error(sessionFailureMessage({ refunded, isDeposit, sessionId, nodeMoniker, reason: err.message, policyRejected: err instanceof V2RayPolicyError }))`.

The three handlers (`CONNECTION_SUBSCRIBE`, `PLAN_SUBSCRIBE`, `PLAN_START_SESSION_FROM_SUB`)
drop their separate `resolveNodeRemoteUrl` + `handshakeWithPolicy` calls and call
`establishSessionOrRefund` once with `isDeposit` set appropriately. `V2RayPolicyError` stays
thrown from inside `performHandshake` (before any tunnel bringup) and is simply one more
`catch`-ed failure now — its dedicated preamble preserved via `policyRejected`.

- **Constant:** `REFUND_TIMEOUT_MS = 10_000`.

### 4. H3 shell — `performHandshake` in `sentinel-service.ts`

For both the WireGuard and V2Ray branches:
- Wrap the SDK call: `const result = await withTimeout(sdkHandshake(sid, {...}, privKey, remoteUrl), HANDSHAKE_TIMEOUT_MS, 'node handshake')`.
- Validate before parse: `if (!result || typeof result.data !== 'string') throw new Error('Node returned an invalid handshake response')`, and wrap `JSON.parse(Buffer.from(result.data,'base64'))` so a bad body throws `'Node returned an unparseable handshake response'` rather than a raw `SyntaxError`.

A timed-out/garbage handshake now throws → caught by §3's `establishSessionOrRefund` → refund.

- **Constant:** `HANDSHAKE_TIMEOUT_MS = 15_000`.

### 5. H4 shell — reconnect epoch in `ipc-handlers.ts`

- Add module state `let connectionEpoch = 0`.
- `performDisconnect` increments `connectionEpoch++` (alongside setting
  `isIntentionalDisconnect = true`) — this is the signal that the current connection
  lifecycle has ended.
- Rewrite `attemptReconnect` to drive its decision through the pure functions and guard the
  async body with the epoch:
  1. `const decision = decideReconnect({ attempt: reconnectAttempt, maxAttempts: RECONNECT_MAX_ATTEMPTS, autoReconnect: loadSettings().autoReconnect, intentional: isIntentionalDisconnect, hasSession: !!activeSessionId })`.
  2. `abort` → return; `give-up` → existing teardown-to-idle path; `retry` → set
     `reconnectAttempt = decision.attempt`, `const myEpoch = connectionEpoch`,
     `if (reconnectTimer) clearTimeout(reconnectTimer)` (**fixes the latent double-schedule**),
     schedule `setTimeout(body, decision.delayMs)`.
  3. Timer `body`: `if (connectionEpoch !== myEpoch) return` (disconnected during the delay);
     load saved config (missing → teardown-to-idle); bring the tunnel up; **after the
     bring-up awaits, `if (connectionEpoch !== myEpoch) { await revertPostConnectSettings(); await disconnect(); stopWireGuardMonitor(); return }`** (user disconnected mid-bringup —
     undo what we just brought up, broadcast nothing); else commit: `reconnectAttempt = 0`,
     start monitor if WG, `sendStateChange('connected')`. On thrown error → `attemptReconnect()`.

The epoch invalidation lives in the imperative shell (it is timing, not a pure decision);
`decideReconnect` + `backoffDelayMs` carry the testable logic.

**Residual limitation (accepted):** the epoch guarantees the correct *final* state — after
any disconnect, the tunnel ends down and no stale `connected` is broadcast — but a reconnect
that completes its bring-up microseconds before the epoch check can leave the tunnel briefly
up before tearing it back down. Fully serializing connect/disconnect so the overlap can't
occur at all is M1 (a connect mutex), deliberately out of scope here.

## Data flow

```
subscribe handler
  └─ create session on-chain (funds locked)          [unchanged]
  └─ establishSessionOrRefund(sessionId, …, isDeposit)   [H1]
       ├─ resolveNodeRemoteUrl                         (throw → refund)
       └─ performHandshake                             [H3: withTimeout + shape check]
            └─ (throw incl. V2RayPolicyError → refund via withTimeout(endSession))
  └─ applySession + return                             [unchanged, only on success]

WG monitor / v2ray exit ── attemptReconnect ── decideReconnect (pure)
                                              └─ setTimeout(body): epoch-guarded  [H4]
```

## Error handling

- Refund failure inside `establishSessionOrRefund` is caught; the thrown message tells the
  user which session id to cancel manually (never a silent swallow).
- Handshake timeout and malformed responses become ordinary throws feeding the refund path.
- Reconnect body that detects `connectionEpoch` drift tears down any tunnel it brought up and
  emits **no** state change (the disconnect that bumped the epoch already broadcast idle).

## Testing

- `async-utils.test.ts` — resolves passthrough; rejects with label on timeout; clears timer.
- `connect-decisions.test.ts` — `sessionFailureMessage` across the refunded × isDeposit ×
  policyRejected matrix (id appears when not refunded); `decideReconnect` abort/give-up/retry
  boundaries; `backoffDelayMs` growth + 60s cap.
- `npm run typecheck` clean; `npm test` green (existing 79 + new).
- Epoch invalidation: verified by reasoning + typecheck (timing-dependent; not unit-tested).

## File touch summary

| File | Change |
|---|---|
| `src/main/async-utils.ts` | **new** — `withTimeout` |
| `src/main/async-utils.test.ts` | **new** |
| `src/main/connect-decisions.ts` | **new** — `sessionFailureMessage`, `decideReconnect`, `backoffDelayMs` |
| `src/main/connect-decisions.test.ts` | **new** |
| `src/main/provider-service.ts` | import `withTimeout` from `async-utils` (drop local copy) |
| `src/main/sentinel-service.ts` | H3: wrap `sdkHandshake` in `withTimeout` + validate shape |
| `src/main/ipc-handlers.ts` | H1: `establishSessionOrRefund` replaces `handshakeWithPolicy`; H4: `connectionEpoch` + rewritten `attemptReconnect` |
