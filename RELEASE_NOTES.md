# Katacomb VPN 1.9.1

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.9.1 is a fixes release. The headline is a bug that could take down a VPN this app
did not create: disconnecting Katacomb deleted every WireGuard tunnel on the machine,
including one belonging to another provider.

## Highlights

- **Disconnecting no longer takes your other VPN down with it.** If you had a WireGuard
  tunnel from another provider running, Mullvad or IVPN or one you set up by hand,
  disconnecting Katacomb deleted it too. It happened as root, with nothing on screen to
  say so, and the app had already warned you that the other VPN was there. Only our own
  tunnel is torn down now. The warning about other VPNs stays a warning: it can be wrong
  about Tailscale, so it has never blocked a connection and still does not.
- **Ending or reconnecting a session survives switching tabs.** Those are on-chain
  transactions, and they keep running after you leave the Sessions tab. The screen
  tracking them did not. Coming back showed the row with no spinner and both buttons
  live while the first transaction was still being sent, so a second press could collide
  with it, and any error had nowhere left to appear. The same applied to Link and Unlink
  in the Provider console.
- **A dead node no longer stalls the node scan for two minutes.** The scan gave each node
  eight seconds, but that budget only started once a connection was established. A node
  that accepts nothing and answers nothing never got that far, so it ran until the
  operating system gave up, measured at over two minutes. Three of those in a row held up
  the whole batch.
- **An out-of-date background service is caught before you pay, not after.** Installing an
  update does not always restart the privileged service, and an older one may not know how
  to bring up the protocol you picked. That used to surface as a failure after the session
  had been bought. The app now asks the service what it can do before the transaction, and
  says to restart it instead.
- **IPsec VPNs are now detected.** The check for other active VPNs looked for network
  interfaces, and IPsec clients, including most corporate ones, do not create one, so
  they were invisible to it. They are included in the warning now. This one needs the
  .deb, because reading IPsec state requires the privileged service the AppImage does
  not install.
- **Fewer moving parts behind a connection.** The app no longer loads the bundled SDK's
  connection-management code to generate keys and configuration files. That code could
  start programs, write temporary files and generate QR codes, none of which a VPN client
  needs, and the V2Ray path was writing its configuration to a temporary file and reading
  it straight back, with the session credentials in that file the whole time. The
  replacements produce byte-for-byte identical output, which is enforced by tests.

## Fixes in 1.9.1

- Release notes for 1.9.1
- Stop using the SDK's connection managers to get key material and configs
- Stop root deleting other VPNs' tunnels, and bound the bypass route list
- Pin the daemon protocol to a shared corpus, and make the version probe useful
- Bound a node probe across the TCP connect, not just socket inactivity
- Record why the v2ray binary cannot be replaced by xray
- Keep in-flight transaction state alive across a tab switch
- Add the architecture diagram and check it in the test run
- ci: move the actions onto the Node 24 majors
- ci: install the pinned Go toolchain, not the newest patch of its minor

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
sudo apt install ./katacomb-vpn_1.9.1_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.9.1.AppImage
./katacomb-vpn-1.9.1.AppImage
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
