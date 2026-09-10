# Katacomb VPN 1.6.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

The Nodes tab is redesigned with a modern dashboard experience: 48 px rows show protocol
marks, stacked prices with units, full node addresses with copy-to-clipboard buttons, and
a status pill that reads "Connected" on the active tunnel. The Multi-hop tab now shares
the same cells and design. The toolbar fits one line at typical widths—search, protocol
select, six visible filter chips, then count and refresh. A country picked on the Map tab
arrives as a dismissible chip, so you can start there and narrow it down.

## Highlights

- **Nodes tab redesign.** Every row is an identity cell (moniker + full address with copy
  button) over location, type (protocol mark + name + version), stacked prices, leases,
  sessions, peers, latency probe button, and status pill. All six protocols show their
  original monochrome glyphs, chosen for privacy over vendored logos (WireGuard's
  trademark policy forbids logos in third-party graphics).
- **Visible filter chips.** The six boolean filters—Active, Healthy, Residential,
  Whitelisted, Hide duplicates, and Bookmarked—now toggle as icon chips in the toolbar
  instead of hiding in a dropdown. Click any chip to filter instantly. The count
  ("1,150 of 1,697 nodes") updates live and shows when the list was last refreshed.
- **Copy buttons everywhere.** Node addresses appear in full in both the table and the
  node modal, with copy buttons beside them. Clicking copies the address to the
  clipboard and shows a green checkmark for 1.5 seconds. The copy does not open the
  modal if clicked in the table.
- **One-line toolbar.** At your typical window width the toolbar is a single row. Below
  ~1440 px the count and refresh buttons wrap to a second line, right-aligned. The
  search field now matches monikers, addresses, countries and cities.
- **Multi-hop parity.** The Multi-hop table uses the same cells, widths and 48 px rows
  as the Nodes tab, so both tabs read as one consistent interface. The Eligibility
  column is unchanged.
- **Modal improvements.** Address and Endpoint rows in the node connection modal now
  have copy buttons. The protocol type shows its mark beside the label.
- **Map handoff.** Click a country on the globe and the Nodes tab opens with that
  country filtered as a dismissible chip. Pick it on the sidebar, same result. Click
  the × to see all countries again.
- **Keyboard navigation.** Tab through a row: moniker button (opens the modal on Enter),
  bookmark toggle, address copy, and latency probe button. All four are keyboard-native,
  no tab traps.

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
sudo apt install ./katacomb-vpn_1.6.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.6.0.AppImage
./katacomb-vpn-1.6.0.AppImage
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
