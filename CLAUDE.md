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
```

No test framework is configured yet. No linter is configured yet.

## Architecture

Sentinel dVPN desktop client: Electron 33 + React 18 + TypeScript + Vite + Tailwind CSS 3. Connects to the Sentinel blockchain (Cosmos SDK) to subscribe to decentralized VPN nodes and establish WireGuard/V2Ray tunnels. Linux-only target.

### Process Separation

Strict Electron security isolation with three process boundaries:

- **Main process** (`src/main/`): Node.js context. Wallet crypto, blockchain RPC, VPN tunnel management, OS-level operations. All sensitive operations live here.
- **Preload** (`src/preload/index.ts`): contextBridge exposing `window.api` — the only IPC channel between main and renderer. Channel constants in `src/shared/ipc-channels.ts`.
- **Renderer** (`src/renderer/`): Browser context with React. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. No Node.js access.

### Key Modules (Main Process)

- `wallet.ts`: BIP-39 mnemonic import, `DirectSecp256k1HdWallet` derivation with `sent` prefix, `safeStorage` encryption (OS keyring via libsecret on Linux), balance/session queries via `SentinelClient`.
- `settings.ts`: Multi-wallet store (`wallets/` dir with encrypted `.enc` files + `wallets-index.json`), app settings (`settings.json`), old single-wallet migration. Wallet entries have `id` (UUID), `name`, `address`.
- `sentinel-service.ts`: `SigningSentinelClient` for on-chain tx (node subscription via `nodeStartSession`), session ID extraction from tx events, cryptographic handshake with nodes (WireGuard/V2Ray branching). Session configs saved to disk for reconnect.
- `vpn-manager.ts`: V2Ray child process lifecycle, WireGuard via polkit helper, tun2socks TUN routing for V2Ray, connection status monitoring. Bundled binaries (v2ray, tun2socks) verified via SHA-256 before use, with system PATH fallback.
- `ipc-handlers.ts`: ~22 IPC channels, pre-connect balance validation, node list fetch from `api.sentnodes.com/v2/nodes` via `net.fetch`. Caches balance/sessions/nodes when VPN is active (RPC unreachable through tunnel).

### Privilege Escalation

VPN operations require root. Instead of raw `pkexec wg-quick`, the app uses a polkit helper:
- `resources/linux/sentinel-vpn-helper.sh` — installed to `/usr/local/bin/sentinel-vpn-helper`
- `resources/linux/com.sentinel.dvpn.policy` — polkit policy for cached auth
- `resources/linux/postinstall.sh` — deb postinstall that deploys the helper + policy
- Helper commands: `up <config>`, `down`, `tun-up <bin> <socks> <remote> <gw> <iface>`, `tun-down`
- WireGuard interface name: `sntl0`. TUN interface: `sntl-tun`.

### Vite Bundling (Critical)

`electron.vite.config.ts` must bundle the entire CosmJS/Sentinel SDK dependency tree (listed in `DEPS_TO_BUNDLE`). Electron loads main process output as CJS, but these deps have ESM-only transitive dependencies (`@scure/base`, `@noble/*`). Only `bufferutil` and `utf-8-validate` are externalized (ws optional native deps that gracefully no-op).

**If you add a new `@cosmjs/*` or Sentinel SDK dependency, add it to `DEPS_TO_BUNDLE` or the build will fail at runtime with `ERR_REQUIRE_ESM`.**

### Renderer Conventions

- Hooks in `src/renderer/hooks/`: `useWallet` (balance polling 300s), `useNodes` (node fetch + filter/sort, 60s refresh), `useConnection` (status polling 3s). Polling intervals are hardcoded per-hook — not user-tunable.
- Node table uses `@tanstack/react-virtual` for virtualized rendering (5000+ nodes).
- BIP-39 validation uses direct JSON wordlist import + Set lookup (not `bip39.validateMnemonic` — that function's dynamic require fails in Vite's renderer bundle).
- Cypherpunk dark theme: bg `#0a0a0f`, accent green `#00ff88`.
- `@` alias maps to `src/renderer/`.
- Types for renderer in `src/renderer/types/index.ts` — includes `ElectronAPI` interface matching preload bridge and `declare global` for `window.api`.

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
- CosmJS pinned at 0.38.x for peer compatibility with Sentinel SDK

### Packaging

`electron-builder.yml` targets Linux only (AppImage + deb). The deb declares `wireguard-tools` and `policykit-1` as dependencies. Bundled v2ray/tun2socks binaries are in `resources/linux/v2ray/` and copied to `extraResources`.
