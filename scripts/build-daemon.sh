#!/usr/bin/env bash
# Builds the privileged helper (daemon/) into
# resources/linux/privileged/katacomb-vpn-helper, where electron-builder's
# extraResources picks it up and postinstall / ensurePolkitSetup install it from.
#
# Runs on every `npm run build`, `npm run dist` and (via predev) `npm run dev`.
#
# FAILS LOUDLY on purpose. electron-builder only WARNS when an extraResources source
# is missing, so a helper that silently failed to build would ship as a deb whose
# postinstall installs nothing and whose daemon unit points at a file that is not
# there. Every check below turns that into a build error instead:
#   - the Go toolchain must be exactly go.mod's `toolchain` line (GOTOOLCHAIN=local,
#     so nothing is auto-downloaded and CI builds what the maintainer built);
#   - `go vet` and `go mod verify` must pass (go.sum + the checksum DB are the
#     dependency pin; there is no vendor/ directory);
#   - the output must be statically linked (CGO_ENABLED=0), so it runs on every
#     supported distro regardless of glibc — the same rule scripts/build-amneziawg.sh
#     enforces for amneziawg-go;
#   - the build is reproducible (-trimpath, -buildid=, no VCS stamp): building the
#     same tree twice gives the same bytes, which is what lets ensurePolkitSetup
#     compare the installed helper against the bundled one byte for byte instead of
#     re-prompting on every dev rebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/resources/linux/privileged/katacomb-vpn-helper"
cd "$ROOT/daemon"

fail() { echo "build-daemon: $*" >&2; exit 1; }

command -v go >/dev/null 2>&1 || fail "go is not on PATH (needs the toolchain named in daemon/go.mod)"
want="$(sed -n 's/^toolchain //p' go.mod)"
[ -n "$want" ] || fail "daemon/go.mod has no toolchain line"
have="$(go version | awk '{print $3}')"
[ "$have" = "$want" ] || fail "go version is $have, daemon/go.mod pins $want"

VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"
[ -n "$VERSION" ] || fail "could not read version from package.json"

export CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
go mod verify >/dev/null || fail "go mod verify failed"
go vet ./... || fail "go vet failed"
go build -trimpath -buildvcs=false \
  -ldflags "-s -w -buildid= -X main.version=$VERSION" \
  -o "$OUT" . || fail "go build failed"

command -v file >/dev/null 2>&1 || fail "the \`file\` utility is required to verify static linking"
file "$OUT" | grep -q 'statically linked' || fail "$OUT is not statically linked: $(file "$OUT")"
[ "$("$OUT" --version)" = "$VERSION" ] || fail "--version mismatch"

echo "built $OUT ($VERSION, $(stat -c %s "$OUT") bytes, sha256 $(sha256sum "$OUT" | cut -c1-12)…)"
