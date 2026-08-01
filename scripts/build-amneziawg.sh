#!/usr/bin/env bash
# Vendors the AmneziaWG userspace trio at the exact commits Sentinel pins in the
# sentinel-dvpnx / sentinel-dvpncli Dockerfiles. Re-run only to upgrade; update
# BUNDLED_HASHES in src/main/binary-integrity.ts with the printed SHA-256s.
#
# WHY THIS BUILDS IN A CONTAINER
# ------------------------------
# These binaries are SHIPPED, so they must run on the user's glibc, not the
# maintainer's. Building `awg` natively on a modern distro silently pinned it to
# the build host: on Ubuntu 24.04 the C headers rewrite strtoul/strtoll into
# __isoc23_* symbols, giving a hard GLIBC_2.38 floor that fails to even load on
# Debian 12 (2.36), Ubuntu 22.04 (2.35) or Mint 21 (2.35). Nothing in the
# upstream source asks for that — it is purely an artifact of the build machine.
# It also fails LOUDLY at connect time and cannot fall back, because
# resolveAmneziaWgBinDir refuses to run an unpinned system binary by design.
#
# So: build `awg`/`awg-quick` in oldstable (glibc 2.31), which covers every
# Debian >= 11 and Ubuntu >= 20.04, and assert the floor afterwards so a future
# toolchain bump cannot reintroduce this quietly.
#
# `awg` is NOT statically linked on purpose: it resolves hostname Endpoints via
# getaddrinfo, and static glibc needs matching libnss_* shared objects at run
# time — trading a clear load-time failure for a confusing DNS one.
# amneziawg-go, by contrast, needs no libc at all (CGO_ENABLED=0).
set -euo pipefail
AWG_GO_COMMIT=1cc94272ca8e9e223a5fe76382f5880f09d3c12d
AWG_TOOLS_COMMIT=61e741780e8465a67a7d7fb6cffe14a8a15d624a
DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/linux/v2ray"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# debian:bullseye == glibc 2.31. Raise only with a deliberate decision to drop
# distros, and update MAX_GLIBC to match.
BUILD_IMAGE=debian:bullseye
MAX_GLIBC=2.31

# Fail the build if a binary demands a newer glibc than MAX_GLIBC. A binary with
# no versioned glibc symbols at all (static) passes trivially.
assert_glibc_floor() {
  local bin="$1" name worst
  name="$(basename "$bin")"
  worst="$(objdump -T "$bin" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//' | sort -uV | tail -1 || true)"
  if [ -z "$worst" ]; then
    echo "  OK   $name: no dynamic glibc symbols (static)"
    return 0
  fi
  if [ "$(printf '%s\n%s\n' "$worst" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
    echo "  FAIL $name: requires glibc $worst, above the $MAX_GLIBC ceiling" >&2
    objdump -T "$bin" | grep -E "GLIBC_$worst" | awk '{print "         " $(NF-1), $NF}' | sort -u >&2
    return 1
  fi
  echo "  OK   $name: requires glibc $worst (<= $MAX_GLIBC)"
}

go version   # requires Go >= 1.24.4

# --- amneziawg-go: pure Go, no libc dependency whatsoever ---------------------
# CGO_ENABLED=0 is what makes this immune to the host glibc. It only costs the
# cgo DNS resolver, which this binary never uses (awg parses the config; this
# process just owns the tun device and UDP socket).
git clone https://github.com/amnezia-vpn/amneziawg-go "$WORK/go"
git -C "$WORK/go" checkout --quiet "$AWG_GO_COMMIT"
(cd "$WORK/go" && CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o "$DEST/amneziawg-go" .)

# --- awg + awg-quick: built against oldstable glibc inside a container --------
git clone https://github.com/amnezia-vpn/amneziawg-tools "$WORK/tools"
git -C "$WORK/tools" checkout --quiet "$AWG_TOOLS_COMMIT"
# SYSCONFDIR redirected too — the default install step tries to mkdir /etc/amnezia (root)
# The container builds as root, so hand the artifacts back to the invoking user
# before exiting — otherwise the mktemp dir is left full of root-owned files that
# the EXIT trap cannot unlink, leaking a directory into /tmp on every run.
docker run --rm -v "$WORK/tools:/src" -v "$WORK:/out" \
  -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" "$BUILD_IMAGE" bash -euc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends build-essential >/dev/null
  make -C /src/src --jobs="$(nproc)"
  make -C /src/src install PREFIX=/out/prefix SYSCONFDIR=/out/prefix/etc \
       WITH_BASHCOMPLETION=no WITH_SYSTEMDUNITS=no
  chown -R "$HOST_UID:$HOST_GID" /out/prefix
'
cp "$WORK/prefix/bin/awg" "$WORK/prefix/bin/awg-quick" "$DEST/"
chmod 755 "$DEST/amneziawg-go" "$DEST/awg" "$DEST/awg-quick"
cp "$WORK/go/LICENSE" "$DEST/LICENSE.amneziawg-go"        # MIT
cp "$WORK/tools/COPYING" "$DEST/LICENSE.amneziawg-tools"  # GPLv2 — must ship with the binaries

echo
echo "glibc floor check (ceiling $MAX_GLIBC):"
assert_glibc_floor "$DEST/amneziawg-go"
assert_glibc_floor "$DEST/awg"

echo
sha256sum "$DEST/amneziawg-go" "$DEST/awg" "$DEST/awg-quick"
