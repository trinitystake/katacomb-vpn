# Third-party licenses

Katacomb VPN itself is **GPL-3.0-or-later** (see [LICENSE](LICENSE)).

The packages (`.deb`, AppImage) additionally ship six third-party executables under
`resources/linux/v2ray/`. Each is a **separate program**, executed as its own process —
Katacomb VPN never links their code into its own. Their licenses apply to those files
only, and the full text of each accompanies the binary in the same directory.

| Binary | Upstream | Pinned version | Commit | License | Text |
|---|---|---|---|---|---|
| `v2ray` | [v2fly/v2ray-core](https://github.com/v2fly/v2ray-core) | v5.47.0 | — | MIT | `LICENSE.v2ray` |
| `tun2socks` | [xjasonlyu/tun2socks](https://github.com/xjasonlyu/tun2socks) | v2.6.0 | `4127937` | MIT | `LICENSE.tun2socks` |
| `xray` | [XTLS/Xray-core](https://github.com/XTLS/Xray-core) | v26.3.27 | `d2758a0` | MPL-2.0 | `LICENSE.xray` |
| `hysteria` | [apernet/hysteria](https://github.com/apernet/hysteria) | app/v2.10.0 | `f2ad1de` | MIT | `LICENSE.hysteria` |
| `amneziawg-go` | [amnezia-vpn/amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) | v0.0.20250522 | `1cc9427` | MIT | `LICENSE.amneziawg-go` |
| `awg`, `awg-quick` | [amnezia-vpn/amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools) | v1.0.20260618-2 | `61e7417` | GPL-2.0 | `LICENSE.amneziawg-tools` |

Every one of these is SHA-256 pinned in [`src/main/binary-integrity.ts`](src/main/binary-integrity.ts);
the app and the root daemon both refuse to execute a binary whose hash doesn't match.

`openvpn`, `wireguard-tools` and `pkexec` are **not** bundled — they are declared as
`.deb` dependencies and come from your distribution under its own packaging.

## Bundled shared library (AppImage)

Unlike the six executables above, this one is **linked into the application process**,
so its license governs distribution of the combined work rather than just the file.

| Library | Upstream | Pinned version | License | Text |
|---|---|---|---|---|
| `libasound.so.2` | [alsa-project/alsa-lib](https://github.com/alsa-project/alsa-lib) | 1.2.8-1+b1 (Debian 12) | LGPL-2.1-or-later | `LICENSE.libasound` |

It ships at `usr/lib/libasound.so.2`, which only the AppImage's `AppRun` puts on the
library search path; the `.deb` declares `libasound2t64 | libasound2` and uses the
distribution's copy instead. It is an **unmodified** binary copy of Debian 12's
`libasound2` package, taken verbatim from that package and not rebuilt or patched.

**As required by LGPL-2.1 §6**, the complete corresponding source for this library is
the `libasound2` source package of Debian 12 (`alsa-lib` 1.2.8-1+b1), available from
<https://sources.debian.org/src/alsa-lib/> and from the Debian mirror network. The
maintainers of this repository will also, for at least three years, supply that source
on request via the repository's issue tracker. Because the library is dynamically
linked and shipped as a separate file with its SONAME intact, a recipient may replace
it with their own build of alsa-lib by substituting the file.

## Source code offer

Four of the six binaries are vendored from an upstream release; two are built from
source by this repository.

**`awg` / `awg-quick` (GPL-2.0) and `amneziawg-go` (MIT)** are compiled here, not
downloaded, by [`scripts/build-amneziawg.sh`](scripts/build-amneziawg.sh). That script
*is* the complete corresponding source instruction: it clones each upstream repository
at the commit pinned above and builds it (`amneziawg-go` statically with
`CGO_ENABLED=0`, `awg` inside a `debian:bullseye` container so its glibc floor stays low
enough for Debian 11+). Run it to reproduce the shipped binaries byte-for-byte:

```bash
./scripts/build-amneziawg.sh
sha256sum resources/linux/v2ray/{amneziawg-go,awg,awg-quick}   # must match binary-integrity.ts
```

The upstream sources themselves:

```bash
git clone https://github.com/amnezia-vpn/amneziawg-tools && git -C amneziawg-tools checkout 61e741780e8465a67a7d7fb6cffe14a8a15d624a
git clone https://github.com/amnezia-vpn/amneziawg-go   && git -C amneziawg-go   checkout 1cc94272ca8e9e223a5fe76382f5880f09d3c12d
```

**As required by GPL-2.0 §3(b), the maintainers of this repository offer, for at least
three years from the date of distribution, to supply a complete machine-readable copy of
the corresponding source for `awg` and `awg-quick` — at no charge beyond the cost of
physically performing the distribution — to anyone who asks.** In practice, use the
commands above; they fetch the exact same source.

**`v2ray`, `tun2socks`, `xray` and `hysteria`** are vendored verbatim from their
upstream release archives at the versions in the table. `xray` is MPL-2.0, whose §3.2
source obligation is satisfied by the upstream release page for the pinned tag; the
other two are MIT and carry no source obligation.

## Runtime dependencies

Node/npm dependencies (Electron, React, CosmJS, `@sentinel-official/sentinel-js-sdk`, …)
are not vendored in this repository — they are resolved from the npm registry at build
time and their licenses ship inside `node_modules/`. Electron bundles Chromium and
Node.js under their own licenses (BSD-3-Clause and MIT respectively), reproduced in the
packaged app under `LICENSES.chromium.html`.
