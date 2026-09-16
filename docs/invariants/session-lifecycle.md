# Session lifecycle

Verified against live mainnet, not inferred from the protobufs.

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
