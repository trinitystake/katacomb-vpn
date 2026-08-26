# Katacomb VPN 1.4.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

A maintenance release for the Provider console. It now checks what the chain will
actually accept before offering you an action, so transactions that could only ever
be rejected are no longer presented.

##Highlights

- The Provider console stops offering transactions the chain refuses. Creating a plan and leasing a node both need an active provider, and registration lands you inactive, so a freshly registered console was showing two buttons that were guaranteed to fail. They are held back until you activate, with the reason on screen.
- Bad provider details are caught before they cost gas. Name, identity and website are capped at 64 bytes and the description at 256, and a website has to be a full URL, matching the chain's own rules instead of finding out after the fee.
- Editing your provider details no longer wipes the fields you did not touch. The chain overwrites identity, website and description whether or not the message carries them, so the edit form is filled in from your record on chain first.
- Deactivating a provider says what it really does. It ends every lease, unlinks every node from every plan, and deactivates every plan you have, and the registration deposit is not returned. The confirmation counts all three off your own state.
- Plan privacy and lease terms can be changed after the fact. Three messages the SDK ships but never registers are now wired up, so a plan's private flag is no longer write once and a lease's renewal policy is no longer a dead end. Extending a lease replaces its term rather than adding to it, and is priced in full.
- Settled subscriptions no longer offer Manage. Once a subscription is settling, the chain refuses both renew and cancel, and its raw error was reaching you verbatim

## Fixes in 1.4.0

- Audit the Provider tab against sentinelhub v12.0.2
- Stop offering actions a settled subscription cannot take
- Check which BUILD is installed, not just which version
- Add ship.sh: the whole release as one command
- Automate publishing, and encode the unwind
- Point the documented release flow at --edit

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
sudo apt install ./katacomb-vpn_1.4.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.4.0.AppImage
./katacomb-vpn-1.4.0.AppImage
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
