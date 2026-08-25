# Katacomb VPN 1.2.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

A feature release. The Plans tab is rebuilt around buying and using subscription
plans, and can now pick a node and connect for you.

## Highlights

- **The Plans tab is rebuilt, around My plans and Catalog.** Plans, subscriptions and
  allocations now arrive together in one round trip rather than from several independent
  polls, so the tab shows one consistent picture. It keeps showing it while a tunnel is
  up, marking the figures as cached and disabling anything that spends money, instead of
  blanking when your own connection puts the chain out of reach.
- **Smart connect picks a node for a plan, and spends the plan price at most once.** It
  ranks the plan's nodes on evidence it actually holds, then works down the list.
  A failure that spent nothing moves on freely, a refunded one is retried within a
  limit, and anything that could buy a second subscription stops the ladder cold.
- **Plans priced in anything other than `udvpn` now show their real price.** They used to
  render as free, which also sorted them to the top as the cheapest thing on offer.
- **Plans you cannot buy are hidden by default**, and each plan's node count is worked out
  during the rescan rather than left blank.
- **Resuming a session is now labelled Reconnect**, with a tooltip for how its cost
  differs from buying a new one. Plan and subscription calls also ride the faster connect
  path, and plan sessions get the same cache and quota protection node sessions had.

## Fixes in 1.2.0

- Replace native confirm() dialogs with in-app modals
- Fix double-connect and stale plan data while connected
- Add About modal with GitHub link; move About from tray to app UI
- Destroy tray on quit; quit on window close when no tray host exists
- Refresh chain-backed lists on disconnect
- Add Smart RPC: automatic endpoint selection
- Enforce proxy mode node eligibility in plan connections
- Name Known limitations as a step 0 review item
- Rewrite 1.1.0's notes to describe the Plans release
- Refuse to cut a release whose notes prose was never rewritten

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
sudo apt install ./katacomb-vpn_1.2.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.2.0.AppImage
./katacomb-vpn-1.2.0.AppImage
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

GPL-3.0-or-later. Bundled binaries (v2ray, xray, hysteria, awg, amneziawg-go, tun2socks)
are under their respective licenses. See
[THIRD-PARTY-LICENSES.md](https://github.com/trinitystake/katacomb-vpn/blob/main/THIRD-PARTY-LICENSES.md).
