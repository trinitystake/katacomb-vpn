# Katacomb VPN 1.0.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

## Multi-hop chains

The headline of this release. A chain routes you through two nodes, `you > entry >
exit > internet`, so neither one knows both who you are and where you are going.

- **Its own tab**, with the same node picker, filters and latency probes as the Nodes tab.
- **Per-hop wallets.** A session carries its buyer's address and that record is public,
  so paying both hops from one wallet lets either node find the other. You can assign a
  second wallet to the exit hop. The app never transfers between them, and it warns you
  if the chain shows the two wallets have funded each other.
- **Both hops must carry TLS or Reality.** Stricter than the single-hop rule, because a
  cleartext entry hop announces the circuit to your own ISP, which is the thing a chain
  is bought to prevent.
- **The exit hop is bought and provisioned through the entry**, never contacted directly,
  so it does not see your address at purchase time.
- **Both sessions are refunded if either half fails.**
- Nodes are graded for eligibility before you pay, not after.

## Local network sharing

A toggle that lets you reach printers, NAS boxes and other machines on your LAN while
the kill switch is armed. It adds firewall exceptions for the private ranges only, and
nothing else about your routing changes.

## Connection integrity

- **A live interface is no longer treated as a working tunnel.** `wg-quick` reports
  success whether or not the node ever answers, so the app now proves traffic actually
  flows after every connect, and stands the session down if a tunnel goes one-way.
- **Kill switch and LAN sharing apply immediately.** Previously they only took effect on
  the next connect.
- **The kill switch's established-connection rule is now scoped to the tunnel interface.**
  It previously matched any interface, which could have kept a pre-connect flow alive on
  the physical adapter.
- The node's TLS certificate is pinned on the single-hop XRAY path.

## Fixes

- Disconnect could freeze the whole app and then report that the kill switch could not be
  turned off, leaving no internet and no way to retry.
- An unanswered helper install prompt could hang startup indefinitely.
- The RPC health banner blamed a healthy endpoint every time a session ended, and offered
  to switch away from it.
- Save Routes in split tunnelling failed silently on invalid input.
- Errors from the main process reached the UI wrapped in IPC boilerplate, hiding their
  real cause.
- Tray icon badge position, and theme-switch latency.

## Interface

- The connect modal shows the node's full address, endpoint and ASN.
- Node filter checkboxes are collapsed, and eligibility is sortable.
- Session buttons and expiry wording are clearer about what actually happens on chain.

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
sudo apt install ./katacomb-vpn_1.0.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.0.0.AppImage
./katacomb-vpn-1.0.0.AppImage
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
