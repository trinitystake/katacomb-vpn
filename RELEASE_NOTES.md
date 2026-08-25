# Katacomb VPN 1.2.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

A feature release. The app now chooses its own blockchain RPC endpoint, and it
refuses to start a second paid session while one is already running.

## Highlights

- **Smart RPC picks the blockchain endpoint for you, and switches away from a bad one
  without asking.** Candidates come from the public RPC feed, but the feed only
  nominates: an endpoint has to answer, report the right chain, and sit within ten
  blocks of the tallest candidate probed before it qualifies. Whatever is in use is
  kept unless it stops qualifying or is clearly beaten, so the choice does not flap.
  This is the new default. Picking an endpoint by hand in Settings turns it off, and
  "Retest and reselect" there shows you the exact measurements the choice was made on.
- **One connection at a time, enforced where the money is spent.** Buying a session
  while another was live used to overwrite the first, leaving it open on chain with
  your deposit against it and nothing watching its quota. Every path that can spend
  funds now refuses while a tunnel is up, and the connect screens say so instead of
  offering a pay form that cannot work.
- **The Plans tab comes back to life as soon as you disconnect.** Its buttons are
  disabled while a tunnel is up, because your own connection puts the chain out of
  reach, but nothing used to notice the tunnel going away, so they stayed dead for up
  to five minutes afterwards. A plan's node list now also tells "this plan has no
  nodes" apart from "I cannot check right now", rather than reporting the first when
  it means the second.
- **The tray icon no longer lingers after you quit**, and on desktops that draw no
  tray at all, stock GNOME among them, closing the window quits the app instead of
  leaving it running with no way back to it.
- **Confirmations are part of the app now.** The eight remaining OS dialogs are themed
  modals that match the rest of the window and do not freeze it, with destructive
  actions in red. There is also a proper About box, reachable from the version chip in
  the status bar or from the tray.

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
