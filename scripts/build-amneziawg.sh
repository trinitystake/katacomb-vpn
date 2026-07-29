#!/usr/bin/env bash
# Vendors the AmneziaWG userspace trio at the exact commits Sentinel pins in the
# sentinel-dvpnx / sentinel-dvpncli Dockerfiles. Re-run only to upgrade; update
# BUNDLED_HASHES in src/main/binary-integrity.ts with the printed SHA-256s.
set -euo pipefail
AWG_GO_COMMIT=1cc94272ca8e9e223a5fe76382f5880f09d3c12d
AWG_TOOLS_COMMIT=61e741780e8465a67a7d7fb6cffe14a8a15d624a
DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/linux/v2ray"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
go version   # requires Go >= 1.24.4

git clone https://github.com/amnezia-vpn/amneziawg-go "$WORK/go"
git -C "$WORK/go" checkout --quiet "$AWG_GO_COMMIT"
(cd "$WORK/go" && go build -trimpath -ldflags '-s -w' -o "$DEST/amneziawg-go" .)

git clone https://github.com/amnezia-vpn/amneziawg-tools "$WORK/tools"
git -C "$WORK/tools" checkout --quiet "$AWG_TOOLS_COMMIT"
make -C "$WORK/tools/src" --jobs="$(nproc)"
# SYSCONFDIR redirected too — the default install step tries to mkdir /etc/amnezia (root)
make -C "$WORK/tools/src" install PREFIX="$WORK/prefix" SYSCONFDIR="$WORK/prefix/etc" WITH_BASHCOMPLETION=no WITH_SYSTEMDUNITS=no
cp "$WORK/prefix/bin/awg" "$WORK/prefix/bin/awg-quick" "$DEST/"
chmod 755 "$DEST/amneziawg-go" "$DEST/awg" "$DEST/awg-quick"
cp "$WORK/go/LICENSE" "$DEST/LICENSE.amneziawg-go"        # MIT
cp "$WORK/tools/COPYING" "$DEST/LICENSE.amneziawg-tools"  # GPLv2 — must ship with the binaries
ldd "$DEST/awg" || true   # only C binary — confirm nothing exotic is linked
sha256sum "$DEST/amneziawg-go" "$DEST/awg" "$DEST/awg-quick"
