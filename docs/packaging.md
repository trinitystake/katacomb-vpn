# Packaging, portability and licensing

Verify packaging by installing, never by reading config.

`electron-builder.yml` targets Linux only (AppImage + deb). Bundled binaries live in
**The `v2ray` binary CANNOT be replaced by `xray`, so both ship.** Tested, not
assumed, because the reasoning that they could is seductive: xray-core IS a
v2ray-core fork, it DOES read the same JSON config, and multihop already runs
v2ray-shaped configs on the xray binary. `scripts/verify-xray-v2ray-parity.sh`
generates the real configs (the SDK's V2Ray shapes for all 81
transport x proxy x security combinations, then the app's own transform chain) and
runs both binaries' config validators over them. Against Xray 26.3.27: **v2ray
accepts 162/162, xray accepts 0**. Two blockers have no config-level workaround:
`allowInsecure` has been **removed** (migrated to `pinnedPeerCertSha256`, and there is
no certificate pin for a plain V2Ray node to migrate to — see the node-trust
invariant, nothing on chain authenticates a node's certificate), and the
`http`/`quic`/`domainsocket`/`gun` transports are gone. Two more are rewritable and
are listed only so nobody re-derives them: the SDK's global `transport` block, and
`routing.balancers` with `leastping`, which needs an observatory in xray. Re-run the
script after any xray bump; if it ever prints PARITY, the change is
`resolveV2RayBinary()` plus the pin in `binary-integrity.ts`.

`resources/linux/bin/`, beside their `LICENSE.*` texts, and reach the package through the
ONE `extraResources` entry for `resources/linux/` (copyDir preserves the `bin/` and
`privileged/` subfolders). That entry excludes `packaging/` on purpose: fpm embeds a
macro-EXPANDED copy of postinstall/postrm in the control archive, and the copy the glob
used to leave at `/opt/.../resources/linux/` was root-owned, +x and macro-UNexpanded, so
running it by hand would set `APP_DIR` to `/opt/` and install the helper and unit from
the wrong place. Nothing reads it.

**Every custom key in `electron-builder.yml` REPLACES its default, never merges.**
This cost three of the four defects in the portability audit: `deb.depends` dropped
all nine of Chromium's GUI libraries, `deb.recommends` dropped `libappindicator3-1`,
and `afterInstall` dropped electron-builder's own postinst (the AppArmor profile and
the chrome-sandbox SUID logic — `resources/linux/packaging/postinstall.sh` now begins with that
generated block verbatim, then appends ours). Each site says so inline; if you add a
custom key, re-add whatever the default supplied.

**getDefaultDepends is not the whole truth: `libasound2` and `libgbm1` are ours to
declare.** Both are hard `DT_NEEDED` entries of the Electron binary, not dlopen'd
extras, so a missing one is not degraded audio or degraded graphics — the dynamic
linker refuses to exec the app at all (`error while loading shared libraries:
libasound.so.2: cannot open shared object file`), before any window, log line or
error dialog can exist. Neither is in electron-builder's default list, so the
"repeat the nine verbatim" rule above was necessary but NOT sufficient.
Measured in a `debian:bookworm` container carrying only this package's declared
dependencies: plain install → `libasound.so.2` missing, app dead at exec;
`apt-get --no-install-recommends` → `libgbm.so.1` missing as well, since the GL stack
(libGL, libEGL, the mesa DRI drivers) arrives through **Recommends** somewhere in this
dependency set and never through anyone's Depends. That second case is also a machine
with no system GL whatsoever, which the Map tab now survives by construction (it draws
SVG, not WebGL) rather than by falling back.

**`libasound2t64 | libasound2` must stay an alternation with the t64 name FIRST, and
Ubuntu is the only place that shows why.** On Ubuntu 24.04 `libasound2` is a *virtual*
name with several providers, and the one apt picks unprompted is
`liboss4-salsa-asound2`, an OSS4 shim implementing a subset of the ALSA API. The real
`libasound2t64` is never installed, the package installs cleanly, `ldd` reports **zero**
unresolved libraries, and the app dies the instant it is run:
`symbol lookup error: undefined symbol: snd_device_name_get_hint, version ALSA_0.9`.
Debian 12/13 and Ubuntu 22.04 all resolved the bare name to the real library, so
**testing Debian only would have shipped a package that cannot start on the single most
common desktop target.** Naming the real package first makes the choice deterministic;
older releases have no `libasound2t64` and fall through to the second alternative, where
`libasound2` is a real package and therefore beats any provider.

**A container is enough to catch this class of bug and costs minutes, but `ldd` alone is
not a sufficient check and Debian alone is not sufficient coverage.** Run all five
(`debian:bookworm`, `debian:trixie`, `ubuntu:22.04`, `ubuntu:24.04`, `ubuntu:26.04`):
`apt-get install -y --no-install-recommends /tmp/app.deb`, then
`ldd "/opt/Katacomb VPN/katacomb-vpn" | grep "not found"` (must print nothing) **and**
actually execute the binary (`--no-sandbox --version`), which must reach Chromium's own
startup rather than `symbol lookup error` or `error while loading shared libraries`.
Reaching a dbus or `Missing X server or $DISPLAY` complaint is the expected pass in a
headless container. Do that on any dependency change before reaching for the full
interactive script below. All five re-run green on 2026-08-26 after the d3-geo globe (26.04 resolves
`libasound2t64` like 24.04 does, so the alternation still decides it correctly);
note the deb's `Depends` are NOT affected by renderer dependencies, since `libgbm.so.1`
and `libasound.so.2` are `DT_NEEDED` on the Electron binary itself (`objdump -p`).

**Do not test "no GL" by purging mesa: `Xvfb` links `libGL.so.1` itself** and dies with
`error while loading shared libraries` the moment you remove it, which looks exactly like
the app failing to open a window. Measured, after wasting a run on it. There is no such
thing as a GUI machine with no `libGL.so.1` at all, so the state worth testing is "no
acceleration", not "no library": keep mesa installed so the X server runs, and take GL
away from Chromium instead with `--disable-gpu --disable-software-rasterizer`. Both
bookworm and ubuntu:24.04 map and paint a window under those flags (2026-08-25).

**The AppImage bundles `libasound.so.2`, and deliberately does NOT bundle `libgbm.so.1`.**
An AppImage has no package metadata, so it cannot declare either of the two libraries
the deb declares above, and both are `DT_NEEDED` on the main Electron binary — a host
missing one gets a linker error and no dialog. `AppRun` exports
`LD_LIBRARY_PATH=$APPDIR/usr/lib`, so `linux.extraFiles` stages our copy there beside
electron-builder's own `libXtst`/`libnotify`/`libXss`. It has to be `linux.extraFiles`,
not `appImage.extraFiles`: the schema has no per-target `extraFiles`. Landing in the deb
as well is harmless **because the binary's RPATH is bare `$ORIGIN`, not
`$ORIGIN/usr/lib`** — moving it up to the app root would shadow the system library for
deb users, which is the opposite of what the deb's own `Depends` is for.
The asymmetry is the point: `libgbm` is bound to the host's mesa DRI drivers and
`LD_LIBRARY_PATH` outranks the system, so bundling it would shadow mesa for **every**
AppImage user including the ones it works for today, to rescue hosts that have no
graphics stack to run a GUI on regardless. `libasound` has no such coupling and the app
never plays audio; it only needs the symbols to resolve, which is also what makes it
immune to Ubuntu's partial OSS4 shim. Vendored **from a `debian:bookworm` container**,
never from the maintainer's desktop: a native copy inherits this machine's glibc and would refuse to load on older
targets (floor is GLIBC_2.34; re-check on any refresh). It is LGPL-2.1, so unlike the
five executables it is *linked into* the process and carries a source offer in
`THIRD-PARTY-LICENSES.md` — keep that entry in step if the file is ever refreshed.

**The AppImage runs UNSANDBOXED on Ubuntu 24.04+ — this is known, documented, and not
to be "fixed" in code.** With `kernel.apparmor_restrict_unprivileged_userns=1`,
electron-builder's `AppRun` probes `unshare -Ur true`, fails, and appends
`--no-sandbox` rather than crashing (verified live, both sysctl states: flag present at
1, absent at 0). An AppImage can't install an AppArmor profile and can't use a SUID
`chrome-sandbox` (squashfs is `nosuid`), so it has neither mechanism Chromium accepts.
The `.deb` is unaffected — its profile makes the probe succeed. The README steers
Ubuntu users to the deb; don't patch `AppRun` (diverges from upstream) and don't add
`--no-sandbox` anywhere yourself.

**Root cannot read a running AppImage, so anything handed to `pkexec` must be staged
off the mount first.** The runtime mounts the squashfs as
`fuse … user_id=<uid>,group_id=<gid>` with neither `allow_root` nor `allow_other`
(measured; the runtime embeds neither string and `/etc/fuse.conf` leaves
`user_allow_other` off), and FUSE's default denies every other uid — root is not
exempt, because the check is FUSE's own, not DAC. `ensurePolkitSetup` (`main/index.ts`)
used to hand `pkexec sh -c 'cp -- "$1" …'` a `$1` on that mount: root's `cp` got EACCES,
the `&&` chain stopped, and the `catch {}` swallowed it — so the "VPN Helper Setup"
dialog came back on every launch, and an AppImage-only user could NEVER get the helper
(then `privileged.ts` fails every root-requiring connect with "VPN helper not
installed"). Confirmed 2026-09-02: three authenticated Install clicks, nothing on disk,
while the identical code path worked from `/opt` (deb) and from the repo (dev). Latent
since the first commit, because the QA script's `dismiss_helper_dialog` deliberately
answered Skip. The fix stages both files through a private `mkdtempSync` dir under
`tmpdir()` (a 0700 dir is enough — plain DAC lets root through) and removes it in a
`finally`. `verify-deb-portability.sh` section 7 (and the phased `appimage` step) now
click **Install** once, assert the helper is 755 root:root and byte-identical to
`resources/linux/privileged/`, assert that root really cannot `cat` the mount (a FAIL
there means the runtime started passing `allow_root` — re-read this before "simplifying"
the staging away), and then remove both files again so the deb phases keep their clean
slate. Anything else in main that ever hands a resource path to `pkexec`, `sudo`, or the
daemon inherits this: copy it out first. `tun-up` no longer does: the tun2socks engine is
compiled into the helper, which self-execs from `/usr/local/bin`, so AppImage
V2Ray/XRAY/Hysteria2 tunnel mode works there. `awg-up` no longer does either: since
Phase 3 the AmneziaWG device is compiled into the helper (`_amneziawg`, self-exec'd from
`/usr/local/bin`), so all six protocols work on the AppImage. The preflight guard that
refused AmneziaWG there (added 2026-09-14 after session 61449769 paid for a tunnel root
could never bring up — the trio lived on the mount, and only the preflight, running as
the user, could see it) is gone with the trio. The lesson stands for anything future:
if a verb ever again depends on a path root must read, the refusal belongs in
`protocolRuntimeError`, BEFORE the purchase, because `establishSessionOrRefund` only
ever covers a failed handshake.

**Verify packaging by installing, not by reading config** —
`scripts/verify-deb-portability.sh` (interactive, needs root, pauses for GUI steps)
does the full install/launch/connect/upgrade/remove cycle, plus an `appimage` phase for
the sandbox check above; re-run it after touching
`electron-builder.yml`, either maintainer script, or the systemd unit. The AppArmor defect was
invisible in development because Linux Mint ships
`/etc/sysctl.d/20-apparmor-mint.conf` setting `kernel.apparmor_restrict_unprivileged_userns=0`,
while stock Ubuntu 24.04+ leaves it at 1. With it at 1 and no profile installed, the
app dies with `FATAL … chrome-sandbox … mode 4755` before a window ever appears.
Flip the sysctl to reproduce stock behaviour on this hardware.

Licensing (required for any public distribution): the app is **GPL-3.0-or-later**
(`LICENSE`, `package.json` `license` → the deb's `License:` field). All three bundled
binaries carry their upstream text as `resources/linux/bin/LICENSE.<name>`, and
`THIRD-PARTY-LICENSES.md` records each one's pinned version/commit. Nothing shipped is
under GPL-2.0 since Phase 3 replaced the `awg`/`awg-quick`/`amneziawg-go` trio with the
embedded device. The privileged helper statically LINKS tun2socks v2.6.0 (MIT, despite
the v1 series having been GPL-3.0) and the AmneziaWG device (`amneziawg-go` v0.2.19, MIT)
and their dependencies (gvisor Apache-2.0, `golang.org/x` BSD-3, …): `scripts/gen-go-notices.sh`
regenerates `daemon/THIRD-PARTY-NOTICES.md` from `go list -deps` — rerun it after any
change to `daemon/go.mod` — and it ships beside `THIRD-PARTY-LICENSES.md`. `LICENSE`,
`THIRD-PARTY-LICENSES.md` and `THIRD-PARTY-NOTICES.md` ship via explicit
`extraResources` entries so the notices travel with the binaries.
**When bumping a bundled binary, re-check its LICENSE at the new tag** — it can change
between versions.
