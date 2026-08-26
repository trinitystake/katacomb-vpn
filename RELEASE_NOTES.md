# Katacomb VPN 1.3.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

A feature release. The Map tab no longer needs a GPU to draw, and the app no longer
leaves a VPN tunnel running after a crash.

## Highlights

- **The Map tab no longer needs a GPU.** The globe was drawn with WebGL, and on a machine
  that cannot give the browser a WebGL context it failed as soon as it was drawn. The Map
  tab is the one that opens first, so that took the whole app down with it: you could set
  up a wallet, restart, and never see the app again. It is drawn as plain SVG now, which
  works on any machine, costs nothing while nobody is dragging it, and has no graphics
  context left to lose.
- **A tunnel no longer outlives the app.** If the app was killed while you were connected,
  the tunnel stayed up with nothing supervising it. That matters because the quota
  watchdog is the only thing that ends a session once its paid limit is reached, so the
  session could keep running, and keep being charged for, with nothing watching it. The
  next launch now closes that tunnel and tells you it did. The session itself stays open
  on the chain, and the Sessions tab will reconnect you to it.
- **Quitting while connected records what the session used.** The usage on a session card
  used to fall back to the chain's own figure after a quit, and the chain can be tens of
  minutes behind, so a session you had just spent an hour on could read as barely used.
- **Both downloads are smaller.** Dropping the 3D globe library and minifying the packaged
  bundles takes several megabytes off the deb and the AppImage alike.

## Fixes in 1.3.0

- Scaffold release notes from the commit range
- Stop the tunnel outliving the app
- Add ubuntu:26.04 to the deb portability matrix
- Give the globe spin-down, and stop recenter unwinding every turn
- Record the deb portability re-run and the Xvfb no-GL trap
- Fix the stale disc and the sluggish redraw when the globe is resized
- Draw the globe with d3-geo instead of three.js
- Stop shipping the square flag set
- Minify the packaged bundles
- Rewrite 1.2.0's notes to describe the Smart RPC release
- Make the notes title the marker that step 0 happened

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
sudo apt install ./katacomb-vpn_1.3.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.3.0.AppImage
./katacomb-vpn-1.3.0.AppImage
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
