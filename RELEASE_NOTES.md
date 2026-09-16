# Katacomb VPN 1.9.2

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.9.2 is a small fixes release. The headline is a paid session that could go on being
spent against a tunnel that had already stopped working, with the app still reporting it
as connected, for as long as you were not actively using the connection.

## Highlights

- **A tunnel that has died is now noticed even when you are not using it.** Until now the
  app could only tell a tunnel was dead by watching traffic leave with nothing coming
  back. That is solid evidence, but it needs you to be doing something. Leave the
  connection idle and there is nothing to watch, so a node that had quietly dropped your
  peer left the app showing Connected, and your paid session being spent, against a tunnel
  that was carrying nothing. Measured on mainnet, that state lasted hours. The app now
  asks the kernel when the WireGuard peer last completed a handshake instead. A working
  peer refreshes that about every two minutes on its own, whether or not you are doing
  anything, so one that has not refreshed is a fact rather than an inference. The session
  is disconnected and stays open on chain, and the Sessions tab offers a reconnect. This
  covers WireGuard connections and needs the background service that the .deb installs.
  Every other protocol keeps exactly the checks it had before.
- **The usage time recorded for such a session stops where the tunnel did.** When a
  connection is ended this way, the time counted against it now runs to the last moment
  the tunnel was demonstrably alive, not to the moment the app worked out that it was not.
  The chain meters what the node reports, so counting the dead stretch would have shown
  you spending time you were never charged for.

## Fixes in 1.9.2

- Release notes for 1.9.2
- Stop pinning the whole op list in the container verification
- Catch an idle WireGuard tunnel whose peer has stopped answering

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
sudo apt install ./katacomb-vpn_1.9.2_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.9.2.AppImage
./katacomb-vpn-1.9.2.AppImage
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
