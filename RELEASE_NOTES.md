# Katacomb VPN 1.0.3

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

A maintenance release. No new features: it corrects how a paid session is measured,
reported and recovered.

## Highlights

- **Usage is no longer billed against a tunnel that has gone away.** With
  auto-reconnect off, a dropped interface left the clock running, so a session could
  report hours it never ran, and that figure was written down as a floor the chain
  could not undercut. Time now accrues only up to the last confirmed sign of life.
- **Auto-reconnect works with the kill switch armed.** Names only resolve through the
  tunnel, so re-pinning the node's endpoint failed at precisely the moment reconnect
  needed it. The last known good address is kept for that case, and a reconnect that
  fails is now torn down before the next attempt instead of being left half-built.
- **A live session no longer reads as "No active sessions".** A paid, connected
  session could be missing from the Sessions tab for as long as the connection lasted.
- **The resolver you choose replaces the node's on WireGuard and AmneziaWG**, rather
  than being added behind it. A node that lists a dead resolver first cost roughly 30
  seconds of failed lookups on the first page you opened after connecting, once per
  connection, which is why it read as a slow start rather than a fault.
- **Stricter OpenVPN config validation.** Directives whose arguments cannot be parsed
  are now refused rather than passed through, in the privileged helper as well as in
  the app.

## Fixes in 1.0.3

- Dial IP lookups and tunnel probes on fresh sockets
- Refresh the public IP display without the artificial wait
- Speed up the connect flows
- updated README.md

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
sudo apt install ./katacomb-vpn_1.0.3_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.0.3.AppImage
./katacomb-vpn-1.0.3.AppImage
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
