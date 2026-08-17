<div align="center">
  <img src="build/icons/128x128.png" alt="Katacomb VPN" width="96" height="96">
  <h1>Katacomb VPN</h1>
  <p><strong>A desktop client for the Sentinel decentralized VPN network.</strong></p>
</div>

Pick a node anywhere in the world, pay for a session on-chain, and Katacomb brings up the
tunnel — WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or Hysteria2, whichever that node
speaks. No accounts, no subscriptions to a single provider: bandwidth is bought directly
from independent node operators with a wallet you hold the keys to.

Electron 41 + React 18 + TypeScript. **Linux x86_64 only.**

> **Status:** release (1.0.1). Connecting spends real funds — see
> [Money](#money-this-app-spends-real-funds).

---

## Features

**Finding a node**

- **Map** — 3D globe with per-country node counts, plus a country sidebar.
- **Nodes** — virtualized table over the whole network (thousands of nodes). Filter by
  country, city, protocol, residential/whitelisted, bookmarks; hide duplicates; sort on
  any column. Latency probes (single or batch) and a download speed test.
- **Multi-Hop** — Your device -> Entry node -> Exit Node -> The internet.
- **Plans** — discover provider plans, subscribe, then start sessions on any node in the
  plan. Includes a subscription manager for cancelling and for the auto-renewal policy.
- **Sessions** — every active session with usage, price and remaining allowance;
  reconnect or end it from here.

**Connecting**

- **Kill switch** — iptables rules that drop everything outside the tunnel, armed on
  connect and torn down on disconnect (with a self-healing marker if the app dies mid-way).
- **DNS** — pick a resolver (Cloudflare, Quad9, NextDNS, …) applied on connect. On the
  V2Ray-family protocols the queries go out over DoH, so the node can't read them.
- **Split tunneling** — CIDR routes that bypass the tunnel; private ranges are excluded
  by default.
- **Localt Network Sharing** — each other devices on your network (SSH, printers, NAS) while the    kill switch is on. This traffic stays on your LAN and is not encrypted by the VPN.
- **Auto-reconnect** — up to 5 attempts with backoff when a tunnel drops.
- **Proxy mode** — for the SOCKS-capable protocols, run just the local listener at
  `127.0.0.1:1080` without touching system routing or asking for root.
- **Multi-hop** — chain two V2Ray/XRAY nodes, so the entry node sees your IP but not
  where you go and the exit sees where you go but not your IP. Candidates are checked
  against each node's own advertised inbounds *before* anything is paid for, the two
  ends are filtered by different rules, and the two hops can be paid from two different
  wallets so neither node can find the other on chain. Read the honest limits below.
- Live traffic stats, real egress IP/geo check, tray connect.

**Wallet**

- BIP-39 import or generate (12 or 24 words), multiple wallets, subaccounts derived at a
  chosen account index.
- Seeds are encrypted at rest with Electron `safeStorage` (the OS keyring — libsecret on
  Linux). If the keyring is unavailable, secrets are **not** written in plaintext instead.

**Selling bandwidth** — the other side of the network

- **Provider** — a fifth tab, hidden by default. Turn on *Provider mode* in Settings (the
  switch is per wallet, not global), or it appears on its own if the active wallet already
  has a provider registered on chain.
- Register a provider, create plans and activate them, lease nodes from their operators
  and link them into a plan, and read per-plan subscriber counts off the chain.
- An economics strip across the top: daily burn from running leases, funds escrowed (yours
  again when you end a lease) and revenue net of the hub's cut — you pay nodes **by the
  hour** whether anyone connects or not, but sell plans **by the gigabyte**.
- Every step is one transaction and the intermediate state lives on chain, so a flow
  interrupted half-way — registered but not activated, leased but not linked — is
  resumable from the console rather than lost.

## Protocol support

`type` is the numeric protocol tag from the node-list feed. Each node runs exactly one.

| # | Protocol | Interface | How it runs | Notes |
|---|----------|-----------|-------------|-------|
| 1 | WireGuard | `sntl0` | root (`wg-quick`) | Uses the distro `wireguard-tools` |
| 2 | V2Ray | `sntl-tun` | userspace core + tun2socks | Bundled `v2ray`; encrypted DNS via DoH |
| 3 | OpenVPN | `sntl-ovpn` | root (`openvpn`) | Distro client; the node's PKI issues the client cert |
| 4 | XRAY | `sntl-tun` | userspace core + tun2socks | VLESS + Reality; bundled `xray` |
| 5 | AmneziaWG | `sntl0` | root (`awg-quick`) | WireGuard fork with DPI-evasion params; bundled userspace trio |
| 6 | Hysteria2 | `sntl-tun` | userspace core + tun2socks | QUIC; refuses to connect without a TLS pin |

Type 0 (unknown) is the only kind the client will not connect to.

Multi-hop chains only work on types 2 and 4: the mechanism is v2ray-core's
`proxySettings.tag`, which the other protocols have no equivalent for. A chain always
runs on the `xray` binary, since xray-core reads the same config and is a strict
superset of what the builder emits. The exit hop additionally has to serve plain TCP —
grpc and websocket bring their own dialer and fail when carried inside another hop.

Bundled binaries live in [resources/linux/v2ray/](resources/linux/v2ray/) and are
SHA-256 pinned in [binary-integrity.ts](src/main/binary-integrity.ts) — both the app and
the root daemon refuse to execute one whose hash doesn't match. The AmneziaWG trio is
built from source at the commits upstream pins (no prebuilt `amneziawg-go` exists), via
[scripts/build-amneziawg.sh](scripts/build-amneziawg.sh).

## Install

Both artifacts land in `dist/` after a packaging build.

### Verifying a download

Releases ship a `SHA256SUMS` file covering **both** artifacts. Put it next to the
download and run:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

A checksum on its own only proves the file arrived intact — anyone who can replace the
download can replace `SHA256SUMS` with it. It is meaningful only when the checksums come
from somewhere the binaries don't, which for a VPN client handling wallet seeds means a
detached signature you verify against a key obtained separately:

```bash
gpg --verify SHA256SUMS.asc SHA256SUMS   # then check the fingerprint you expect
```

Maintainers: regenerate after every packaging build with `npm run checksums`, and sign
with `gpg --armor --detach-sign dist/SHA256SUMS`.

### .deb — recommended

```bash
sudo apt install ./dist/katacomb-vpn_1.0.1_amd64.deb
```

Pulls in Electron's GUI libraries (GTK, NSS, libsecret and friends) plus
`wireguard-tools`, `openvpn`, `iptables` and polkit (`pkexec`, or `policykit-1` on older
releases). The postinstall also installs and enables
a small root daemon (systemd unit `katacomb-vpn-daemon`), so **connect and disconnect
never prompt for a password**. The GUI talks to it over a Unix socket at
`/run/katacomb-vpn/daemon.sock`.

Access to that socket is granted by the `katacomb-vpn` group, which the postinstall adds
you to — **log out and back in once** for it to take effect. Until then connecting still
works, just with a password prompt each time. If you installed through a graphical app
store rather than `sudo apt`, the postinstall may not be able to tell which account is
yours; run `sudo usermod -aG katacomb-vpn $USER` if prompts persist.

**Compatibility.** x86_64, Debian 11+ / Ubuntu 20.04+ and derivatives (Mint, Pop!_OS,
Zorin). Wallet storage needs an OS keyring — GNOME and KDE ship one by default; on a bare
XFCE/LXQt install, `apt install gnome-keyring`. Saving a wallet is refused outright rather
than falling back to weak encryption, so a missing keyring is visible, not silent.

### AppImage

```bash
chmod +x dist/katacomb-vpn-1.0.1.AppImage
./dist/katacomb-vpn-1.0.1.AppImage
```

No daemon here, so each privileged operation goes through `pkexec` (one prompt, cached
for a while). On first run the app offers to install the polkit helper for you. Install
`wireguard-tools` and `openvpn` yourself if you want those protocols.

**Needs FUSE 2.** This is a type-2 AppImage, so it mounts itself with `libfuse.so.2`.
Ubuntu dropped that from the default install at 22.04, so on 22.04/24.04 you may see
`dlopen(): error loading libfuse.so.2` before the app starts at all. Either install it —
`sudo apt install libfuse2t64` (24.04+) or `libfuse2` (22.04) — or skip FUSE entirely:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./katacomb-vpn-1.0.1.AppImage
```

which unpacks to a temp directory and runs from there (verified working, no mount).

**Needs `libgbm1`.** An AppImage cannot declare dependencies, so a handful of Chromium's
libraries have to come from your system. The AppImage carries its own `libasound.so.2`,
but not `libgbm.so.1`: that one is tied to your graphics drivers, and shipping our own
would override yours. Any normal desktop already has it, since it comes with Mesa. If
the app exits immediately with `error while loading shared libraries: libgbm.so.1`,
install it (`sudo apt install libgbm1`) or use the `.deb`, which declares it properly.

> **On Ubuntu 24.04+ (and any distro with
> `kernel.apparmor_restrict_unprivileged_userns=1`) the AppImage runs with Chromium's
> sandbox disabled — prefer the `.deb` there.**
>
> An AppImage has no install step, so it can neither ship an AppArmor profile granting
> `userns` nor make `chrome-sandbox` SUID (its squashfs is mounted `nosuid`). With
> unprivileged user namespaces restricted, Chromium has neither mechanism available, and
> electron-builder's `AppRun` wrapper responds by appending `--no-sandbox` rather than
> failing to start — silently, with nothing shown in the UI. Since this renderer displays
> data supplied by untrusted node operators, that sandbox is a layer worth keeping. The
> `.deb` is unaffected: its postinstall installs the AppArmor profile that makes the
> namespace probe succeed. Verify either build with
> `sudo ./scripts/verify-deb-portability.sh appimage`.

## Build from source

Requires **Node 22 or newer** (the test runner relies on native TypeScript type
stripping) and a Linux x86_64 host.

```bash
npm ci
npm run dev            # Electron + Vite dev server with HMR
npm run typecheck      # tsc --noEmit on both projects — must pass clean
npm test               # unit tests (Node's built-in runner, zero test deps)
npm run dist:deb       # package the .deb
npm run dist:appimage  # package the AppImage
npm run dist           # both
```

## How a connection is made

The order matters, because step 2 costs money:

1. **Preflight** — bundled binaries present and hash-verified, privilege escalation
   available, and the node's *own* `service_type` matches what the aggregator claims.
   Nothing has been spent yet, so a mismatch here is free.
2. **Pay** — a session transaction on-chain, priced per GB or per hour in `udvpn`.
3. **Handshake** — exchange key material with the node's API; its answer becomes a
   WireGuard/OpenVPN config or a proxy-core JSON config.
4. **Validate** — everything the node sent goes through `config-guard` before a byte of
   it is written to disk or handed to root.
5. **Bring up** — the daemon (or `pkexec`) raises the interface, then the kill switch,
   DNS and split-tunnel routes are applied.

Any failure in step 3 or 4 **cancels the session, refunding it**. A failure in step 5
keeps the already-paid config in memory, so the connect dialog offers "Retry connection"
rather than making you buy a second session.

## Security model

The design assumption worth stating plainly: **node operators are adversaries.** Their
handshake data turns into configs that `wg-quick`, `openvpn` and `iptables` execute as
root, and a single `PostUp = …` line in a WireGuard config is a root shell. So:

- Every node-supplied config passes through [config-guard.ts](src/main/config-guard.ts)
  first — **allow-lists**, not blocklists. Anything not explicitly permitted is rejected,
  including every OpenVPN directive that can run a script (`up`, `down`, `route-up`,
  `plugin`, `tls-verify`, …).
- The privileged helper re-validates in bash, independently, because its socket is the
  real trust boundary.
- Binary blobs from a node (certificates, keys, TLS pins) are decoded and re-armored by
  us, so no node byte can become a config directive. A malformed one throws before the
  handshake completes, which means the session is refunded.
- Operational flags that must not come from a node (`--script-security 0`, `--dev`, …)
  are passed on the command line by the helper, after `--config`.
- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  The only bridge is `window.api`, and IPC calls from any frame that isn't our own
  renderer are rejected.
- Split-tunnel routes are sanitized: a node cannot hand back `0.0.0.0/1` and quietly
  exclude your traffic from the tunnel.

**What multi-hop does and does not do.** It protects against *one* dishonest node: with
two hops, neither end holds both your identity and your destinations. Both hops are
required to be wrapped in TLS or Reality, which is stricter than an ordinary connection,
because the first hop is the one your own ISP can see. It does **not** make you
anonymous. Two operators working together can still correlate the circuit on traffic
volume and timing, since the same bytes cross both hops at the same moments — that is a
hard ceiling, not something this client can close. And a session's paying account is
public on chain, so paying for both hops from one wallet lets either node look up the
other; paying each hop from a different wallet removes that, but only if the second
wallet was funded independently, since a transfer between them is public too.

More detail — including the invariants that must not regress — is in
[CLAUDE.md](CLAUDE.md).

## Money: this app spends real funds

Connecting is a blockchain transaction. Prices are in `udvpn` (1 DVPN = 1,000,000 udvpn),
paid to the node operator, and the wallet needs a balance before you connect (the app
checks first). Failures on the client side are refunded automatically; a session you
actually used is not. Cancelling a subscription marks it inactive-pending — it is not an
instant refund.

A multi-hop chain is **two** sessions and two deposits, and it is also considerably
slower: expect roughly a second of added latency, more when the hops are far apart. If
any part of building one fails, both sessions are cancelled.

The provider side spends too, and differently: the registration deposit goes to the
community pool, so it is gone rather than escrowed (a governance parameter — the app reads
it live instead of hardcoding it). A lease escrows `hourly price × max hours` up front and
pays the node hourly from it; ending the lease refunds the remainder and unlinks the node.

## Architecture

Three process boundaries, with everything sensitive in the main process:

```
src/
├── main/        Node.js — wallet crypto, chain RPC, tunnel management, root ops
├── preload/     the single contextBridge surface (window.api)
├── renderer/    React UI, no Node access
└── shared/      IPC channel names, error markers, chain constants
```

Notable modules:

| File | Role |
|------|------|
| [wallet.ts](src/main/wallet.ts) | BIP-39 import, key derivation, `safeStorage` encryption |
| [chain-service.ts](src/main/chain-service.ts) | On-chain sessions, node handshakes per protocol |
| [vpn-manager.ts](src/main/vpn-manager.ts) | Tunnel lifecycle for all six protocols |
| [config-guard.ts](src/main/config-guard.ts) | Validators for untrusted node data |
| [daemon-core.ts](src/main/daemon-core.ts) | Root daemon: socket server, op dispatch, validation |
| [privileged.ts](src/main/privileged.ts) | Routes privileged ops to the daemon, else `pkexec` |
| [ipc-handlers.ts](src/main/ipc-handlers.ts) | Every IPC channel; connect orchestration, refunds, reconnect |
| [kill-switch.ts](src/main/kill-switch.ts) | iptables kill switch |
| [provider-console.ts](src/main/provider-console.ts) | Provider side: registration, plans, leases, node links |

Per-protocol config builders are pure, Electron-free and unit-tested:
[openvpn-config.ts](src/main/openvpn-config.ts),
[amneziawg-config.ts](src/main/amneziawg-config.ts),
[xray-config.ts](src/main/xray-config.ts),
[hysteria-config.ts](src/main/hysteria-config.ts).

Privileged surface: [resources/linux/](resources/linux/) holds the polkit helper script,
its policy, the systemd unit and the install/remove hooks.

## Development notes

- **No linter.** `tsc` runs `strict` with `noUnusedLocals`/`noUnusedParameters`;
  `npm run typecheck` is the gate. CI runs typecheck, tests and `npm audit`.
- **Tests** use Node's native `--test` against `src/**/*.test.ts`. They import the
  module under test with a `.ts` extension (the native runner requires it) and cover the
  pure security/IO/decision helpers. No Vitest, no Jest, no extra dependency.
- **Bundling.** `electron.vite.config.ts` must bundle the whole CosmJS/dVPN SDK tree
  (`DEPS_TO_BUNDLE`) — those packages have ESM-only transitive deps and the main process
  loads as CJS. Adding a `@cosmjs/*` dependency without listing it there fails at
  runtime with `ERR_REQUIRE_ESM`.
- **Dark theme only**, on purpose. Semantic tokens live in `tokens.css`; components read
  those and never a `dark:` variant.
- App data lives in `~/.config/katacomb-vpn`.

## Troubleshooting

**Connect fails with a DNS provisioning error.** `wg-quick`/`awg-quick` need
`resolvconf` and fail the whole bring-up without it. Install it, or accept the offered
retry — that one strips the `DNS =` lines, which means DNS queries leave the tunnel.
The app says so before you agree.

**"Restart katacomb-vpn-daemon" after an upgrade.** The GUI is newer than the running
daemon: `sudo systemctl restart katacomb-vpn-daemon`.

**Wallet asks to re-import after upgrading from Sentinel dVPN.** `safeStorage` keys its
libsecret entry by application name, so seeds encrypted under the old name cannot be
decrypted under the new one. Settings, the wallet list and sessions migrate; the seed has
to be re-imported once from your mnemonic.

**No internet after a crash while connected.** The kill switch may still be armed.
Starting the app again heals the stranded rules.

**`npm run dev` exits immediately inside VS Code's terminal.** VS Code leaks
`ELECTRON_RUN_AS_NODE=1`; run `env -u ELECTRON_RUN_AS_NODE npm run dev`.

## Relationship to Sentinel

The product is Katacomb VPN; the network is [Sentinel](https://sentinel.co), a Cosmos SDK
chain. The client talks to it over `rpc.sentinel.co` (configurable, with a public RPC
picker in Settings) using the `sentinel-js-sdk`, address prefix `sent`. Node discovery
uses the `api.sentnodes.com` aggregator. Those names stay in the code because they are
the chain's, not the product's.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

The packages also ship six third-party executables (v2ray, tun2socks, xray, hysteria,
amneziawg-go, awg/awg-quick), each a separate program under its own license, with the
full text alongside it in `resources/linux/v2ray/`. Pinned versions, licenses and the
GPL-2.0 source offer for `awg` are in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
