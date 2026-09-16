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
npm test             # Node unit tests (built-in TS test runner, zero deps) + `go test ./...` in daemon/
npm run test:daemon  # The Go tests alone
npm run build:daemon # Build the privileged helper (daemon/ → resources/linux/privileged/katacomb-vpn-helper)
npm run typecheck    # tsc --noEmit on both projects (must pass clean)
```

Tests use Node's native `--test` runner against `src/**/*.test.ts` (no Vitest/Jest,
no extra dependency — Node 22+ strips TS types and runs the tests directly). Cover
the pure security/IO helpers (`config-guard.ts`, `fs-utils.ts`). Test files are
excluded from the build tsconfigs and import the module-under-test with a `.ts`
extension (required by the native runner). No linter is configured; `tsc` is
`strict` with `noUnusedLocals`/`noUnusedParameters` on. The privileged helper is a
Go module in `daemon/` (toolchain pinned by `daemon/go.mod`; `scripts/build-daemon.sh`
refuses any other version and `go vet`s before it builds); `npm run dev`, `build` and
`dist` all build it, and `npm test` runs its tests after the node suite.

## Where the rest of this lives

This file is the router. It carries what is true of the whole repo and the rules
that must be in mind before reading any code; everything else is one file away,
under `docs/`. Read the linked file BEFORE touching the code it covers - each one
is an incident log, not a description, and the reasoning is the point.

| Read this first | Before touching |
|---|---|
| [docs/invariants/reliability.md](docs/invariants/reliability.md) - **the connect path spends real funds** | `ipc-handlers.ts`, `src/main/ipc/`, `src/main/vpn/`, `chain-service.ts` |
| [docs/invariants/node-trust.md](docs/invariants/node-trust.md) - **node data reaches root** | anything turning node data into a config, a spawn or a route |
| [docs/invariants/session-lifecycle.md](docs/invariants/session-lifecycle.md) | sessions, quotas, refunds, the Sessions tab |
| [docs/privileged-helper.md](docs/privileged-helper.md) | `daemon/`, `src/main/helper/`, any new verb or daemon op |
| [docs/protocols.md](docs/protocols.md) | `src/main/protocols/`, adding or changing a protocol |
| [docs/multihop.md](docs/multihop.md) | two-hop chains, `multihop-config.ts`, the Multi-hop tab |
| [docs/provider-console.md](docs/provider-console.md) | `src/main/provider/`, `src/main/plans/`, the Provider and Plans tabs |
| [docs/renderer.md](docs/renderer.md) | `src/renderer/` - conventions, palette, the no-WebGL rule |
| [docs/packaging.md](docs/packaging.md) | `electron-builder.yml`, maintainer scripts, the systemd unit, dependencies |
| [docs/main-modules.md](docs/main-modules.md) | orientation: what each `src/main/` module is for |

Two rules that outrank convenience, stated here so they are never missed:

- **Never make a privileged call synchronous.** `runPrivileged` is async because the
  pkexec path is a polkit dialog; `execFileSync` there freezes the whole main process
  until the user answers it. See `docs/invariants/reliability.md`.
- **Any flow that creates an on-chain session must run through
  `establishSessionOrRefund`**, or a failure strands money. See the same file.

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

### Main process layout

`src/main/` is grouped by what the modules are for. `docs/main-modules.md` has the
per-module detail; this is the map.

```
src/main/
  index.ts          app entry, tray, single-instance lock, startup healing
  ipc-handlers.ts   the connection state machine + the IPC channels that touch it
  settings.ts       settings + the multi-wallet store
  config-guard.ts   THE trust boundary for node data (mirrored by daemon/internal/guard)
  async-utils.ts  fs-utils.ts  disk-cache.ts  socks-agent.ts  net-fetch.ts

  ipc/         peeled handler groups (diagnostics, provider) + validate, handle
  helper/      the app side of root: privileged, daemon-client, daemon-protocol
  chain/       RPC clients, tx helpers, queries, guards, and the wallet that signs
  vpn/         tunnel lifecycle, monitoring, and the pure connect decisions
  protocols/   the six config builders, the chain builder, the node handshake
  nodes/       the aggregator feed, its cache, node probing
  provider/    provider console ops, messages, caches
  plans/       plan service, the smart-connect ladder, cache
```

`config-guard.ts` stays at the root deliberately rather than under `protocols/`: it
is the trust boundary the whole node-trust invariant rests on, and burying it one
level down weakens the signal.

IPC handler groups take the `handle` trust wrapper as a parameter rather than
importing `ipcMain`, so there is exactly one door into main. The connection state
machine (the module-level `let`s, the quota watchdog, the reconnect loop) stays in
`ipc-handlers.ts` as one unit - splitting that state across files would make it a
side channel between modules, which is the antipattern below.

### Vite Bundling (Critical)

`electron.vite.config.ts` must bundle the entire CosmJS/dVPN SDK dependency tree (listed in `DEPS_TO_BUNDLE`). Electron loads main process output as CJS, but these deps have ESM-only transitive dependencies (`@scure/base`, `@noble/*`). Only `bufferutil` and `utf-8-validate` are externalized (ws optional native deps that gracefully no-op).

**If you add a new `@cosmjs/*` or dVPN SDK dependency, add it to `DEPS_TO_BUNDLE` or the build will fail at runtime with `ERR_REQUIRE_ESM`.**

### Architecture diagram (docs/architecture/)

`docs/architecture/katacomb-vpn.architecture.json` is the typed source for the runtime
map; the Archify agent skill renders it (install and commands in that directory's
README, and the rendered HTML is gitignored because it is ~800 KB of vendored template
rewritten whole on every render). **Update it in the same change that changes the
architecture** — a main-process module added or removed, a new helper verb or daemon op,
a new external service, a process or privilege boundary that moves — and re-run
`deliver`, which refuses to write an artifact that fails its own checks.
`npm test` runs `scripts/check-architecture-doc.sh`: it re-pins the JSON to HEAD and
validates, so a pinned module that was renamed or deleted goes red (and it SKIPS,
without failing, when the skill is not installed, since it is not a repo dependency).
Nothing mechanical catches a component that quietly stopped meaning what it says, which
is why this rule exists. It is twelve components on purpose: an orientation map, not an
index of `src/main/` — detail belongs in this file, not in more boxes.

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
