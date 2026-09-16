# Provider console

Acting AS a provider. `src/main/ipc/provider.ts` registers the handlers;
`src/main/provider/` holds the ops, messages and caches.

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

**Chain facts (verified against sentinelhub v12.0.2 + live mainnet, not inferred):**
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
  `MsgEndLease` refunds the remainder and unlinks (via x/plan's `LeaseInactivePreHook`,
  which sends a `MsgUnlinkNode` for every plan the node served).
- **ACTIVE is a precondition for almost everything, and registration lands INACTIVE.**
  `MsgCreatePlan`, `MsgStartLease` and `MsgUpdatePlanStatus → active` are all rejected
  under an inactive provider, so a freshly registered console that offers Create plan or
  Lease & link is offering transactions the chain will refuse. Both surfaces are gated on
  `providerActive`, which `ProviderPlans` threads down to `PlanNodesManager`.
- **There is NO deregister message.** `x/provider` has only register / update-details /
  update-status / update-params. Deactivating is the only exit and the deposit is never
  returned, so "cancel my provider" can only ever mean `MsgUpdateProviderStatus → INACTIVE`.
- **…and that deactivation CASCADES, through three hooks.** x/lease's
  `ProviderInactivePreHook` ends **every** lease (refunding unspent escrow); each ended
  lease fires x/plan's `LeaseInactivePreHook`, unlinking that node from every plan; and
  x/plan's `ProviderInactivePreHook` deactivates every active plan. Reactivating costs no
  new deposit but every lease must be re-bought and every node re-linked. The confirm
  dialog (`deactivateQuestion` in `ProviderIdentityCard.tsx`) counts all three off state
  and says so; do not weaken it back to "your plans stop being offered".
  `NodeInactivePreHook` does the same for a single node going inactive, so a provider can
  lose a lease and a link without doing anything.
- **`MsgUpdateProviderDetails` is ASYMMETRIC**: the handler keeps the stored `name` when
  the message carries an empty one, but overwrites `identity`, `website` and
  `description` **unconditionally**. So the edit form MUST be pre-filled from the current
  record (`ProviderDetailsModal`) or a partial save wipes three fields on chain.
- **ValidateBasic caps**, mirrored in `shared/provider-details.ts` so bad input fails
  before it costs gas: `name`/`identity`/`website` ≤ 64 **bytes** (Go `len()`, which is
  why the counter uses `TextEncoder`, not `.length`), `description` ≤ 256, `website` must
  parse the way Go's `url.ParseRequestURI` does (absolute URI **or** absolute path, so
  `/about` is valid and `example.com` is not), and `name` is required to register but
  optional to update. `MsgUpdateProviderStatus` accepts only active/inactive.
- **The renewal price policy gates a MANUAL renew, not just the automatic one.**
  `MsgRenewLease` runs the same `RenewalPricePolicy.Validate(current, stored)` the
  BeginBlocker does, so `UNSPECIFIED (0)` is a dead end: such a lease can never be
  extended by any route until `MsgUpdateLease` changes the policy. The conditional
  policies compare the node's price NOW against the price stored on the lease, so an
  Extend can be refused by a move the user never chose. `shared/renewal-policy.ts`
  mirrors all eight cases and is what both the handler and the button read.
- **`MsgRenewLease` REPLACES the term, it does not extend it**: the hub resets `Hours` to
  0, sets `MaxHours` to the requested duration, refunds the old escrow and charges a
  fresh `hourlyPrice × hours`. Price it in full, never as a difference.
- There is **no private/public flag and no test/testnet flag on a Provider** at v1, v2 or
  v3 — the record is exactly `{address, name, identity, website, description, status,
  status_at}`. `private` exists only on a **Plan** (`plan/v3` field 6). Don't invent
  either one in the UI.

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
- **`MsgUpdatePlanDetailsRequest` is absent from the SDK registry**, though its codec
  ships: `modules/plan/consts.js` declares no type URL for it and `SentinelRegistry` never
  registers one, which made a plan's `private` flag settable at creation and never again.
  `PROVIDER_REGISTRY` now names it (`MsgUpdatePlanDetailsTypeUrl`) alongside the lease
  types, and `provider-msgs.test.ts` asserts the SDK still omits it so the workaround can
  be dropped once upstream fixes it. Same treatment for `MsgUpdateLeaseRequest` and
  `MsgRenewLeaseRequest`, which the missing lease module never registered either.
- Two provider-module defects to note but leave alone, both on governance-only paths the
  app already avoids: `MsgUpdateParamsTypeUrl` is misspelled
  (`…MsgUpdateParamsReques`, no trailing `t`), and
  `setupProviderExtension().provider.params()` passes the codec object instead of
  `fromPartial({})`. `getProviderDeposit` goes through the v3 protobuf query instead.
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

**Where the pure logic lives.** `provider-msgs.ts` owns message building and stays
main-only (it has no relative imports, so the native runner can resolve it). The two rules
the RENDERER also needs live in `src/shared/` instead, because it cannot import from
`src/main/`: `provider-details.ts` (the ValidateBasic mirror, so a bad form is refused
before it costs gas AND re-checked in the handler, since the renderer is not a trust
boundary) and `renewal-policy.ts` (the policy mirror plus the offered options, so the
Extend button and the `LEASE_RENEW` handler apply the identical rule). Both are
unit-tested; don't duplicate a chain limit into a component.
Money figures (deposit, lease total) are computed in main from on-chain values and never
taken from the renderer, the same rule `cachedPlanCost` follows.

v9.0.0 nodes expose a `service_metadata` array on `/info` (Xray Reality keys,
Hysteria2 obfs, transport variants) that the SDK's `NodeInfo` type lacks — the xray
and hysteria2 paths read the equivalent from the handshake response, not `/info`.
The amneziawg and openvpn paths likewise read everything from the handshake response.
(The only two OpenVPN nodes on the network are v8.3.1 and don't expose it at all; one
reports `service_type: "openvpn"` at its ROOT path, which is what the preflight needs.)
