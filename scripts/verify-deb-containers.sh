#!/usr/bin/env bash
# Katacomb VPN — install the built .deb on the five supported distro images and
# prove it starts, without a GUI and without root on the host (docker only).
#
#     ./scripts/verify-deb-containers.sh                # newest dist/*.deb, all five
#     ./scripts/verify-deb-containers.sh ubuntu:24.04   # one image
#
# This is the container half of the packaging discipline in CLAUDE.md
# ("a container is enough to catch this class of bug and costs minutes, but `ldd`
# alone is not a sufficient check and Debian alone is not sufficient coverage").
# Per image, it runs `apt-get install --no-install-recommends` on the deb, then:
#   - `ldd` on the Electron binary must report nothing "not found";
#   - the Electron binary must reach Chromium's own startup (a dbus / "Missing X
#     server" complaint), never a linker or `symbol lookup error`;
#   - the privileged helper must be installed by the postinst, be statically
#     linked, report the deb's version, print its usage line (exit 1) on an
#     unknown verb, and — started by hand as root, since there is no systemd in a
#     container — answer protocol_version over its socket with the socket owned
#     root:katacomb-vpn 0660 (the postinst created the group);
#   - with NET_ADMIN and /dev/net/tun (granted to the container, never the host),
#     `tun-up -` must bring sntl-tun up with the EMBEDDED tun2socks engine
#     (self-exec'd from /usr/local/bin) and `tun-down` must remove it, and `awg-up`
#     must bring sntl0 up with the EMBEDDED AmneziaWG device the same way (no peer
#     is needed for the bring-up itself) and `awg-down` must remove it — on every
#     image's userland. The container is started with src_valid_mark preset because
#     /proc/sys is read-only under NET_ADMIN alone; the helper leaves a knob already
#     at the wanted value untouched.
# Nothing here touches the host. The deb's dependencies are downloaded into each
# throwaway container, so expect a few minutes per image on the first run.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEB="$(ls -t "$REPO_ROOT"/dist/katacomb-vpn_*_amd64.deb 2>/dev/null | head -1)"
[ -n "$DEB" ] || { echo "No dist/katacomb-vpn_*_amd64.deb found — run 'npm run dist' first." >&2; exit 1; }
VERSION="$(dpkg-deb -f "$DEB" Version)"
IMAGES=("$@")
[ ${#IMAGES[@]} -gt 0 ] || IMAGES=(debian:bookworm debian:trixie ubuntu:22.04 ubuntu:24.04 ubuntu:26.04)

INNER='
set -u
pass=0; fail=0
ok()  { printf "  PASS  %s\n" "$1"; pass=$((pass+1)); }
no()  { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else no "$2"; fi; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || { echo "apt-get update failed"; exit 2; }
if apt-get install -y -qq --no-install-recommends /tmp/app.deb file socat iproute2 procps >/tmp/install.log 2>&1; then ok "deb installs with --no-install-recommends"; else no "deb install FAILED"; tail -20 /tmp/install.log; exit 1; fi
BIN="/opt/Katacomb VPN/katacomb-vpn"
check "! ldd \"$BIN\" | grep -q \"not found\"" "ldd: no unresolved library"
out="$("$BIN" --no-sandbox --version 2>&1 | head -5)"
if printf "%s" "$out" | grep -qiE "symbol lookup error|error while loading shared libraries"; then no "Electron binary dies at exec: $out"; else ok "Electron binary reaches Chromium startup ($(printf "%s" "$out" | head -1 | cut -c1-70))"; fi
H=/usr/local/bin/katacomb-vpn-helper
check "[ -x $H ]" "helper installed by the postinst"
check "[ \"\$(stat -c %a:%U:%G $H)\" = 755:root:root ]" "helper is 755 root:root"
check "file $H | grep -q \"statically linked\"" "helper is statically linked"
check "[ \"\$($H --version)\" = \"$VERSION\" ]" "helper --version = $VERSION"
check "$H frobnicate 2>&1 | grep -q \"^Usage: katacomb-vpn-helper {up <config>|\"" "unknown verb prints the usage line"
check "! $H frobnicate >/dev/null 2>&1" "unknown verb exits non-zero"
check "[ ! -e /opt/katacomb-vpn ]" "no /opt/katacomb-vpn symlink"
check "[ ! -e \"/opt/Katacomb VPN/resources/linux/bin/tun2socks\" ]" "tun2socks not vendored (embedded in the helper)"
check "[ -f \"/opt/Katacomb VPN/THIRD-PARTY-NOTICES.md\" ]" "Go module notices shipped"
check "$H _tun2socks 2>&1 | grep -q \"^_tun2socks: -proxy must be\"" "_tun2socks refuses to start without a valid -proxy"
check "$H _amneziawg 2>&1 | grep -q \"^_amneziawg: usage\"" "_amneziawg refuses to start without a config"
check "[ ! -e \"/opt/Katacomb VPN/resources/daemon\" ]" "no Electron-run daemon bundle"
check "[ ! -e \"/opt/Katacomb VPN/resources/linux/packaging\" ]" "packaging/ (fpm input) not shipped"
check "[ ! -e \"/opt/Katacomb VPN/resources/linux/bin/awg-quick\" ] && [ ! -e \"/opt/Katacomb VPN/resources/linux/bin/amneziawg-go\" ]" "awg trio not vendored (AmneziaWG device embedded in the helper)"
check "getent group katacomb-vpn" "katacomb-vpn group created"
check "[ -f /usr/share/polkit-1/actions/com.katacomb.vpn.policy ]" "polkit policy installed"
check "[ -f /etc/systemd/system/katacomb-vpn-daemon.service ] || ! command -v systemctl" "unit installed when systemd is present"
mkdir -p /run/katacomb-vpn
$H daemon 2>/tmp/daemon.log & DP=$!
sleep 0.5
check "grep -q \"listening on /run/katacomb-vpn/daemon.sock (protocol v1)\" /tmp/daemon.log" "daemon logs its listening line"
check "[ \"\$(stat -c %a:%U:%G /run/katacomb-vpn/daemon.sock)\" = 660:root:katacomb-vpn ]" "socket is 0660 root:katacomb-vpn"
reply="$(printf "{\"id\":1,\"op\":\"protocol_version\"}\n" | socat -t 2 - UNIX-CONNECT:/run/katacomb-vpn/daemon.sock)"
if [ "$reply" = "{\"id\":1,\"ok\":true,\"result\":{\"version\":1}}" ]; then ok "protocol_version over the socket"; else no "protocol_version reply: $reply"; fi
reply="$(printf "{\"id\":2,\"op\":\"frob\"}\n" | socat -t 2 - UNIX-CONNECT:/run/katacomb-vpn/daemon.sock)"
if [ "$reply" = "{\"id\":2,\"ok\":false,\"error\":\"unknown op: frob\"}" ]; then ok "unknown op rejected over the socket"; else no "unknown op reply: $reply"; fi
kill -TERM $DP; sleep 0.3
check "[ ! -e /run/katacomb-vpn/daemon.sock ]" "SIGTERM unlinks the socket"
GW="$(ip route show default | awk "{print \$3}" | head -1)"
if [ -n "$GW" ] && [ -e /dev/net/tun ]; then
  if $H tun-up - 127.0.0.1:1080 203.0.113.7 "$GW" eth0 >/tmp/tunup.log 2>&1; then ok "tun-up - brings up the embedded engine ($(cat /tmp/tunup.log | tr -d "\n" | cut -c1-8) pid)"; else no "tun-up failed: $(cat /tmp/tunup.log)"; fi
  check "[ -e /sys/class/net/sntl-tun ]" "sntl-tun exists"
  check "ip route show | grep -q \"^0.0.0.0/1 dev sntl-tun\"" "the /1 routes point into the TUN"
  check "ps -o args= -C katacomb-vpn-helper | grep -q \"_tun2socks -device tun://sntl-tun\"" "the engine runs as <helper> _tun2socks"
  check "$H tun-down" "tun-down"
  sleep 0.3
  check "[ ! -e /sys/class/net/sntl-tun ]" "sntl-tun gone after tun-down"
  check "! ps -o args= -C katacomb-vpn-helper | grep -q _tun2socks" "engine process gone after tun-down"
  printf "%s\n" "[Interface]" "Address = 10.8.0.5/32" "PrivateKey = cHJpdmF0ZSBrZXkgcHJpdmF0ZSBrZXkgcHJpdmF0ZSE=" "Jc = 4" "Jmin = 128" "Jmax = 800" "S1 = 15" "S2 = 40" "S3 = 20" "S4 = 10" "H1 = 1234567891" "H2 = 987654321" "H3 = 246813579" "H4 = 1357924680" "" "[Peer]" "PublicKey = aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qga2V5ISE=" "AllowedIPs = 0.0.0.0/0" "Endpoint = 203.0.113.7:51820" > /tmp/sntl0.conf
  if $H awg-up /tmp/sntl0.conf - >/tmp/awgup.log 2>&1; then ok "awg-up - brings up the embedded AmneziaWG device"; else no "awg-up failed: $(cat /tmp/awgup.log)"; fi
  check "[ -e /sys/class/net/sntl0 ]" "sntl0 exists"
  check "ip -d link show sntl0 | grep -q \"tun type tun\"" "sntl0 is a userspace tun"
  check "ps -o args= -C katacomb-vpn-helper | grep -q \"_amneziawg /run/katacomb-vpn/sntl0.conf\"" "the device runs as <helper> _amneziawg <root-owned conf>"
  check "ip rule show | grep -q \"lookup 51820\"" "fwmark rule pair installed"
  check "ip route show table 51820 | grep -q sntl0" "default route in table 51820"
  check "$H awg-down" "awg-down"
  sleep 0.3
  check "[ ! -e /sys/class/net/sntl0 ]" "sntl0 gone after awg-down"
  check "! ip rule show | grep -q \"lookup 51820\"" "rule pair gone after awg-down"
  check "! ps -o args= -C katacomb-vpn-helper | grep -q _amneziawg" "device process gone after awg-down"
else
  echo "  ....  no default route or /dev/net/tun in this container, tun-up skipped"
fi
printf "\n%s: %d passed, %d failed\n" "$IMAGE" "$pass" "$fail"
[ "$fail" -eq 0 ]
'

overall=0
for img in "${IMAGES[@]}"; do
  printf '\n\033[1m== %s ==\033[0m\n' "$img"
  if docker run --rm --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.conf.all.src_valid_mark=1 -e IMAGE="$img" -e VERSION="$VERSION" -v "$DEB:/tmp/app.deb:ro" "$img" bash -c "$INNER"; then
    :
  else
    overall=1
  fi
done
[ "$overall" -eq 0 ] && echo "ALL IMAGES PASSED" || echo "SOME IMAGES FAILED"
exit $overall
