# Renderer conventions

Process-isolated React. `src/renderer/` has no Node access and cannot import
from `src/main/`; `src/shared/` is the only overlap.

- Hooks in `src/renderer/hooks/`: `useWallet` (active wallet + store, no polling), `useBalance` (balance, 30s), `useNodes` (filter/sort over `useNodesContext().allNodes` — it does NOT fetch), `useConnection` (status, state-dependent: 15s idle, 10s connected, 3s reconnecting). The node feed's own 60s refresh lives in main (`ipc-handlers.ts`) and reaches the renderer as `NODES_UPDATE` pushes. Intervals are hardcoded per-hook — not user-tunable.
- Node table uses `@tanstack/react-virtual` for virtualized rendering (5000+ nodes).
  Rows are a FIXED 48px (`ROW_HEIGHT`), so a cell is at most two lines with
  `leading-tight`; a third line clips silently. The Nodes and Multi-hop tables share
  their cells and column widths through `NodeCells.tsx` (`NODE_COL`), so a width or a
  rule (the directory-claim tooltips, whitelisted-never-green, the cleartext-red V2Ray
  badge, the status pill) changes in one place for both; NodeTable's doc comment holds
  the width arithmetic against the 960px window minimum. Icons are hand-drawn SVGs in
  `Icons.tsx`, never Unicode glyphs (U+29C9 is missing from DejaVu Sans on a minimal
  Debian). The protocol marks in `ProtocolIcon.tsx` are ORIGINAL glyphs, not the
  projects' logos: WireGuard's trademark policy forbids its logo in third-party
  application graphics without written permission and OpenVPN Inc. has a similar policy.
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
- **Smart RPC (`rpcMode: 'auto'`, the default) switches endpoints silently, and only
  through `runAutoRpcSelection` (rpc-monitor.ts).** Candidates are the sentnodes
  public-rpc feed plus the endpoint in use; `pickAutoRpc` (pure, unit-tested, in
  `rpc-health.ts`) requires POSITIVE qualification — reachable, chainId `sentinelhub-2`
  (strict, unlike `classifyRpc` a null chainId disqualifies), aggregator not reporting it
  failing, height within `AUTO_HEIGHT_TOLERANCE_BLOCKS` of the tallest probed candidate
  (cross-endpoint consensus: the feed only nominates, it cannot pick the winner) — and is
  sticky: the current endpoint survives unless it stops qualifying, goes degraded while a
  healthy candidate exists, or an ok candidate beats it by more than `AUTO_KEEP_MARGIN_MS`.
  Triggers are startup (+3s in index.ts), a CONFIRMED fault transition published by the
  monitor (so `needsConfirmation` gates it — never a single sample), the user flipping
  the mode to auto (SETTINGS_SET; the only trigger that fires for an endpoint already
  published down), wake from suspend (powerMonitor 'resume' +8s — a resumed laptop is
  often on a different network where the old endpoint is healthy but far, which no fault
  trigger notices), and the Settings tab's "Retest and reselect" button (RPC_AUTO_SELECT
  → `runAutoRpcSelectionReport`). Never periodic, never before a connect, and never while
  `unprobedState()` says suspended/blocked — re-checked after the probes, since a tunnel
  can come up during them. A dead feed or no qualifier keeps the current endpoint: doing
  nothing is always safe. The switch persists via `saveSettings` (so `getRpcEndpoint()`
  serves it everywhere) followed by `onRpcEndpointChanged()`. **The Settings list and the
  selection share ONE probe pass** (`probeFeedCandidates`, which RPC_PROBE_ALL also
  serves, and which always includes the endpoint in use): the report returns the exact
  rows the selection graded, so the list on screen can never disagree with the decision —
  don't reintroduce a second, display-only probe run. All triggers funnel through the
  in-flight guard (`startAutoSelect`), so concurrent triggers share one run; background
  entries swallow errors, the report entry propagates them to the button's error pane. The RPC choice is only ever
  latency-measured, never geolocated — the RPC is not in the VPN data path, so "close to
  the node" is meaningless and an IP-lookup service would be a privacy leak. In auto mode
  the RpcBanner keeps its warning but drops its "Switch to X" button (a surviving banner
  means the selection found no replacement); picking an endpoint in Settings flips the
  mode to manual in the same write, and `migrateRpcMode()` (settings.ts, must run before
  any `saveSettings`) turned pre-feature custom endpoints into `'manual'` once.
- **The Map tab uses NO WebGL, and that is load-bearing history.** `CountryGlobe` draws
  an orthographic `d3-geo` projection as SVG `<path>` elements. It used to be
  `react-globe.gl`, and the three.js `WebGLRenderer` it built threw
  `Error creating WebGL context.` whenever the browser refused a context. `mainTab`
  defaults to `'map'` and the only `ErrorBoundary` sat at the app root (`main.tsx`), so
  the throw replaced the entire client with a full-screen "Something went wrong": a user
  with no usable GPU could set up a wallet and never see the app again. Reported on 0.1.1
  (GitHub), reproduced on 1.0.0.
  **Chromium 146 (Electron 41) does not fall back to software WebGL by itself** —
  measured, not inferred: with no GPU, `getContext('webgl2')` *and* `('webgl')` both
  return null, silently, with no console warning, and `getGPUFeatureStatus().webgl` reads
  `disabled_off`. Older Chromium auto-fell back to SwiftShader, which is why this appeared
  without anyone touching the map code. That fact is why the rewrite, not a patch, was the
  fix: the whole defence it forced (an `enable-unsafe-swiftshader` switch in
  `main/index.ts`, a `hasWebgl()` probe, a `GlobeUnavailable` panel, a scoped
  `ErrorBoundary`, `forceContextLoss` cleanup for the context globe.gl never released, and
  a 60 Hz rAF loop idled by hand because it ran on a static choropleth) is now deleted,
  along with ~4.4 MB of three.js. **Do not reintroduce a WebGL dependency here** without
  re-reading this paragraph: SVG is retained-mode, so the globe costs zero CPU when
  nobody is dragging it, and there is no context to lose.
  Verify with the real app, not a unit test:
  `--disable-gpu --disable-software-rasterizer` must render the globe normally
  (confirmed on the rewrite, pixel-identical to a GPU launch).
  **Never give `ErrorBoundary` a new caller without a `fallback`** unless the whole
  window really is the right blast radius; it is back to its single root caller.
- **`CountryGlobe` owns ALL its geometry imperatively, and that is not a style choice.**
  `draw()` mutates one long-lived `projection` in place and runs from an effect or a
  rAF, i.e. always AFTER React commits. So any path whose `d` is computed in the render
  body reads the PREVIOUS frame's scale and translate. The limb-shade overlay was the one
  element left doing that, and it left a stale dark disc offset from the globe for a
  second or two after every resize, self-healing only when an unrelated render (hover, the
  60 s node refresh) happened to run. Measured, not guessed: instrumented, a resize logged
  `[RENDER] scale=297.6` against `[DRAW] scale=251.6` for the same size. Size lives in
  `sizeRef` + a one-shot `measured` flag rather than in state for the same reason resize
  used to feel sluggish: routing the ResizeObserver through `setState` re-ran
  `features.map()` over 177 `<path>` elements every frame of a window drag to change
  nothing but the svg's width and height. After the fix, four resizes cost **0 React
  renders and 4 draws**. Don't move any `d`, or the svg's width/height, back into JSX.
- **The globe's gesture handling: capture on movement, never on pointerdown.**
  `setPointerCapture` retargets the whole gesture to the `<svg>`, so the `pointerup`
  lands there rather than on the country `<path>` and the browser never synthesises the
  click that selects a country. Cost a live regression: hover labels worked, drag worked,
  clicking a country did nothing. The fix is `DRAG_THRESHOLD_PX` — a press only becomes a
  drag (and only then captures) once the pointer has travelled 4 px.
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
