# Katacomb VPN 1.9.3

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.9.3 is a maintenance release, and an unusually literal one: nothing about how the app
behaves has changed. It reorganises the source, splits the project's own documentation
apart, and adds tests. If you are running 1.9.2 and it is working, there is nothing here
you need.

## Highlights

Everything in this release is under the hood. The bullets below say what moved and why,
because the reason a codebase is rearranged is usually the only interesting part.

- **The main process now has folders.** It had grown to seventy files in a single
  directory, holding the wallet, the chain client, every protocol's config builder, the
  tunnel manager and the privileged-helper client side by side with no grouping at all.
  They are now split by what they are for: `chain/`, `vpn/`, `protocols/`, `nodes/`,
  `provider/`, `plans/` and `helper/`. The validator that guards node-supplied
  configuration deliberately stays at the top level, because it is the boundary the whole
  threat model rests on and burying it would weaken the signal.
- **The largest file lost a fifth of its bulk, and the largest screen lost half.** The IPC
  layer had accumulated the connection state machine, the quota watchdog, the reconnect
  loop and the node feed alongside all 74 of its channels. The provider console and the
  read-only diagnostics channels have moved into their own modules. The Settings screen's
  Wallets tab, with its four dialogs, is now its own file. No behaviour changed in either
  case; the same code runs, from a different place.
- **The project's documentation was split into a short index and a `docs/` folder.** It
  had reached 1,838 lines in one file. Every word is preserved, and it is verified: of the
  1,728 substantive lines in the original, 1,724 appear verbatim in the new files, and the
  four that differ are file paths corrected for the move above.
- **Thirty-four new tests**, covering the module that decides how privileged operations
  reach root, and the checks that validate everything arriving from the interface. Both
  became testable as a result of the reorganisation.

One caution for anyone building from source rather than installing a package: partway
through this work a path was broken that made `npm run dev` report V2Ray as missing, and
quietly skipped the integrity check on the bundled proxy binaries. It was found and fixed
before this release. Packaged builds were never affected, because they resolve those
binaries by a different route.

## Fixes in 1.9.3

- Release notes for 1.9.3
- Fix the bundled-binary path broken by the src/main folder move
- Split the Wallets tab out of Settings.tsx
- Split CLAUDE.md into a router and docs/, keeping every word
- Test the two modules the peel made testable
- Claim the last three renderer component clusters into folders
- Move the provider console handlers out of ipc-handlers
- Move the read-only diagnostics handlers out of ipc-handlers
- Give src/main domain folders instead of 70 flat files
- Tidy two structural nits found by the structure audit

## Known limitations

- **A chain has a hard life of about two hours.** Measured on mainnet: exit hops report
  no usage to the chain, so the exit's idle deadline is pinned at purchase and never
  moves, even while the entry still has quota. This is node-side behaviour, not a client
  bug, but it is yours to plan around.
- Chains can only be built from V2Ray and XRAY nodes. The other protocols have no
  equivalent of the relay mechanism a chain needs.
- Expect roughly 2 to 3 MB/s and a large latency increase on a chain. Chains are for
  privacy, not speed.
- Local-proxy mode tunnels only the apps you point at its SOCKS address. Everything else
  leaks, by design, and the kill switch does not apply.
- The TLS and Reality wrapping does not authenticate the node. There is nothing on chain
  to verify a node's certificate against, so an attacker on your local network can answer
  a handshake in a node's place.

## Platform support

**Linux x86_64 only.** Tested on Debian 11+, Ubuntu 20.04+, and derivatives (Mint,
Pop!\_OS, Zorin).

## Installation

**Recommended: .deb**

```bash
sudo apt install ./katacomb-vpn_1.9.3_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.9.3.AppImage
./katacomb-vpn-1.9.3.AppImage
```

No install needed. Every privileged operation prompts for a password instead.

## Verifying your download

```bash
sha256sum -c SHA256SUMS --ignore-missing
gpg --verify SHA256SUMS.asc SHA256SUMS
```

Signed with key `740A F267 B0D8 162B E477 779D 7315 246A 6E67 F3C6`. Import it first if
you have not already:

```bash
curl -sS https://github.com/trinitystake.gpg | gpg --import
```

## Important

- **Connecting spends real funds.** Sessions are blockchain transactions priced in
  `udvpn`, and a failed connection is refunded automatically, but an expired one is not.
- **AppImage on Ubuntu 22.04 and 24.04** needs `libfuse2`, or the
  `APPIMAGE_EXTRACT_AND_RUN=1` workaround. See the README.
- **AppImage on Ubuntu 24.04+** runs with the Chromium sandbox disabled. An AppImage can
  install neither an AppArmor profile nor a SUID sandbox helper, so prefer the .deb there.

## Security model

Node operators are treated as adversaries. Everything a node sends is validated before it
reaches a privileged operation, because a VPN config can otherwise run shell commands as
root. See [CLAUDE.md](https://github.com/trinitystake/katacomb-vpn/blob/main/CLAUDE.md)
for the full threat model and architecture.

## License

GPL-3.0-or-later. Bundled binaries (v2ray, xray, hysteria) are under their respective
licenses. See
[THIRD-PARTY-LICENSES.md](https://github.com/trinitystake/katacomb-vpn/blob/main/THIRD-PARTY-LICENSES.md).
