#!/usr/bin/env bash
# Katacomb VPN — prove the EMBEDDED AmneziaWG device completes a real handshake.
#
#     ./scripts/verify-awg-handshake.sh          # needs docker; no root on the host
#     KEEP=1 ./scripts/verify-awg-handshake.sh   # leave the containers up to inspect
#
# Phase 3 compiled the AmneziaWG device into the helper (daemon/internal/amneziawg)
# and reimplemented awg-quick(8)'s addressing/MTU/DNS/routing natively
# (daemon/internal/ops/amneziawg.go). Two things can only be proven on a real
# kernel against a real peer, and this is the test for both:
#
#   1. the INI -> UAPI translation (base64 keys to hex, the S/H/J/I obfuscation
#      params) — a wrong translation means the peers' framing disagrees and the
#      handshake simply never completes;
#   2. the native routing — the fwmark rule pair, table 51820, src_valid_mark —
#      without which the tunnel's own outer UDP loops into the tunnel or is
#      dropped by rp_filter, and again there is no handshake.
#
# The SERVER is the reference implementation: amneziawg-go + amneziawg-tools built
# from upstream at the AmneziaWG 3.1 commits dvpnd pins in its Dockerfile, with only
# the default tier's parameters set — which is the wire format every Sentinel node
# speaks — brought up by the real awg-quick. (While the
# trio was still vendored in the tree it was mounted instead; since Phase 3 removed
# it, the server container builds it, ~2 min.) The CLIENT is the freshly built helper's
# `awg-up <conf> -`. S1-S4/H1-H4 must match on both ends (handshake-affecting);
# Jc/Jmin/Jmax are per-sender. Traffic to the server's tunnel address is the proof.
#
# Run 1 has no DNS line (pure handshake + routing). Run 2 adds DNS and asserts the
# resolvconf exec path recorded our nameserver for sntl0 and removed it on down.
# Both containers are --privileged (TUN device + writing /proc/sys/net); nothing
# here touches the host.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO/resources/linux/privileged/katacomb-vpn-helper"
BIN="$REPO/resources/linux/bin"
[ -x "$HELPER" ] || { echo "no helper at $HELPER — run scripts/build-daemon.sh first" >&2; exit 1; }
command -v wg >/dev/null 2>&1 || { echo "wg (wireguard-tools) is needed on the host to generate the peer keys" >&2; exit 1; }
# The reference peer is what dvpnd builds and runs (its Dockerfile's AWG_GO_COMMIT /
# AWG_TOOLS_COMMIT, tags v3.1.20260828 and v3.1.20260812). Mount the vendored trio if
# the tree still has it, else build both from upstream inside the server container.
AWG_GO_COMMIT=b5928efb6ca19f0153958460c3d141f04abc5c2e
AWG_TOOLS_COMMIT=ee0f0a9aa34ff0a0da4b3433b9512781cfe02843
if [ -x "$BIN/awg-quick" ] && [ -x "$BIN/awg" ] && [ -x "$BIN/amneziawg-go" ]; then PEER=vendored; else PEER=upstream; fi
docker info >/dev/null 2>&1 || { echo "docker is not reachable" >&2; exit 1; }

NET=kv-awg-net; SRV=kv-awg-server; CLI=kv-awg-client
WORK="$(mktemp -d)"
teardown() { docker rm -f "$SRV" "$CLI" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
finish() { [ "${KEEP:-}" = 1 ] || teardown; rm -rf "$WORK"; }
trap finish EXIT
teardown # a previous run's leftovers

# Keys via wg(8): the same Curve25519 key format AmneziaWG uses.
genkey() { wg genkey; }
pubkey() { wg pubkey; }
SRV_PRIV="$(genkey)"; SRV_PUB="$(printf '%s' "$SRV_PRIV" | pubkey)"
CLI_PRIV="$(genkey)"; CLI_PUB="$(printf '%s' "$CLI_PRIV" | pubkey)"

# Handshake-affecting params, identical on both ends; the junk params are local.
OBFS='Jc = 4
Jmin = 128
Jmax = 800
S1 = 15
S2 = 40
S3 = 20
S4 = 10
H1 = 1234567891
H2 = 987654321
H3 = 246813579
H4 = 1357924680'

mkdir -p "$WORK/srv" "$WORK/cli"
cat > "$WORK/srv/awg0.conf" <<EOF
[Interface]
Address = 10.99.0.1/24
ListenPort = 51820
PrivateKey = $SRV_PRIV
$OBFS

[Peer]
PublicKey = $CLI_PUB
AllowedIPs = 10.99.0.2/32
EOF
chmod 600 "$WORK/srv/awg0.conf"

pass=0; fail=0
ok() { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
c()  { docker exec "$CLI" bash -c "$1"; }
check() { if c "$1" >/dev/null 2>&1; then ok "$2"; else no "$2"; fi; }

echo "== server: the reference peer ($PEER) under the real awg-quick"
docker network create "$NET" >/dev/null
if [ "$PEER" = vendored ]; then
  docker run -d --name "$SRV" --privileged --network "$NET" \
    -v "$BIN:/awgbin:ro" -v "$WORK/srv:/cfg:ro" debian:bookworm sleep infinity >/dev/null
  docker exec "$SRV" bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends iproute2 python3 procps >/dev/null 2>&1' \
    || { echo "server: apt failed" >&2; exit 1; }
  AWGQ=/awgbin/awg-quick
else
  # dvpnx's own recipe: both repos at the pinned commits, amneziawg-go CGO-off, awg via make.
  docker run -d --name "$SRV" --privileged --network "$NET" \
    -v "$WORK/srv:/cfg:ro" golang:1.27-bookworm sleep infinity >/dev/null
  docker exec "$SRV" bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends iproute2 python3 procps build-essential >/dev/null 2>&1' \
    || { echo "server: apt failed" >&2; exit 1; }
  if ! docker exec "$SRV" bash -c "set -e
    git clone -q https://github.com/amnezia-vpn/amneziawg-go /src/go && git -C /src/go checkout -q $AWG_GO_COMMIT
    (cd /src/go && CGO_ENABLED=0 go build -trimpath -o /usr/local/bin/amneziawg-go .)
    git clone -q https://github.com/amnezia-vpn/amneziawg-tools /src/tools && git -C /src/tools checkout -q $AWG_TOOLS_COMMIT
    make -s -C /src/tools/src
    make -s -C /src/tools/src install DESTDIR=/out PREFIX=/usr WITH_BASHCOMPLETION=no WITH_SYSTEMDUNITS=no
    install -m 0755 /out/usr/bin/awg /out/usr/bin/awg-quick /usr/local/bin/" >"$WORK/srv-build.log" 2>&1; then
    echo "server: building the reference peer failed:" >&2; tail -20 "$WORK/srv-build.log" >&2; exit 1
  fi
  AWGQ=/usr/local/bin/awg-quick
fi
# awg-quick prepends its own directory to PATH, so awg and amneziawg-go resolve beside it.
if docker exec "$SRV" bash -c "$AWGQ up /cfg/awg0.conf" >"$WORK/srv-up.log" 2>&1; then
  ok "server awg-quick up (userspace amneziawg-go fallback)"
else
  no "server awg-quick up"; cat "$WORK/srv-up.log"; exit 1
fi
docker exec -d "$SRV" bash -c 'cd /tmp && python3 -m http.server 8080 --bind 10.99.0.1 >/dev/null 2>&1'
SRV_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SRV")"
echo "  server $SRV_IP, tunnel 10.99.0.1, HTTP on 10.99.0.1:8080"

echo "== client: the embedded device via awg-up (run 1: no DNS)"
cat > "$WORK/cli/sntl0.conf" <<EOF
[Interface]
Address = 10.99.0.2/32
PrivateKey = $CLI_PRIV
$OBFS

[Peer]
PublicKey = $SRV_PUB
AllowedIPs = 0.0.0.0/0,::/0
Endpoint = $SRV_IP:51820
PersistentKeepalive = 15
EOF
docker run -d --name "$CLI" --privileged --network "$NET" \
  -v "$HELPER:/usr/local/bin/katacomb-vpn-helper:ro" -v "$WORK/cli:/cfg:ro" debian:bookworm sleep infinity >/dev/null
# Core tools first — what run 1 (the acceptance criterion) needs; fatal, and shown.
docker exec "$CLI" bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends iproute2 iputils-ping curl procps' >"$WORK/cli-apt.log" 2>&1 \
  || { echo "client: apt failed:" >&2; tail -20 "$WORK/cli-apt.log" >&2; exit 1; }
# resolvconf separately and tolerated: its postinst wants to own /etc/resolv.conf,
# which docker bind-mounts, so unmount that first (we are --privileged) and keep DNS
# working for the fetch with a plain file. If it still will not install here, run 2
# is skipped — the handshake must never hinge on a DNS tool's install quirk.
HAVE_RESOLVCONF=0
if docker exec "$CLI" bash -c 'umount /etc/resolv.conf 2>/dev/null; printf "nameserver 8.8.8.8\n" > /etc/resolv.conf; export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq --no-install-recommends resolvconf' >"$WORK/cli-apt-resolvconf.log" 2>&1; then
  HAVE_RESOLVCONF=1
else
  echo "  ....  resolvconf would not install in this container; run 2 skipped: $(tail -1 "$WORK/cli-apt-resolvconf.log")"
fi

if c '/usr/local/bin/katacomb-vpn-helper awg-up /cfg/sntl0.conf -' >"$WORK/cli-up.log" 2>&1; then ok "awg-up exit 0"; else no "awg-up: $(cat "$WORK/cli-up.log")"; fi
check '[ -e /sys/class/net/sntl0 ]'                                                   "sntl0 exists"
check 'ip -d link show sntl0 | grep -q "tun type tun"'                                "sntl0 is a userspace tun, not kernel wireguard"
check 'ps -o args= -C katacomb-vpn-helper | grep -q "_amneziawg /run/katacomb-vpn/sntl0.conf"' "device is <helper> _amneziawg <root-owned conf>"
check 'ip -4 addr show sntl0 | grep -q "10.99.0.2"'                                   "tunnel address assigned"
check 'ip link show sntl0 | grep -q "mtu 1420"'                                       "MTU 1420 (eth0 1500 - 80)"
check 'ip rule show | grep -q "not from all fwmark 0xca6c lookup 51820"'              "fwmark rule installed"
check 'ip rule show | grep -q "from all lookup main suppress_prefixlength 0"'         "suppress_prefixlength rule installed"
check 'ip route show table 51820 | grep -q "^default dev sntl0"'                      "default route in table 51820 via sntl0"
check '[ "$(cat /proc/sys/net/ipv4/conf/all/src_valid_mark)" = 1 ]'                   "src_valid_mark = 1"
check 'ip route get 1.1.1.1 | grep -q "dev sntl0"'                                    "a public address routes into the tunnel"
check 'ip route get '"$SRV_IP"' | grep -q "dev eth0"'                                  "the endpoint itself still routes via eth0"
check 'grep -Eq "^[0-9]+$" /run/katacomb-vpn/awg.state'                               "awg.state holds the device pid"
# --- THE acceptance criterion: traffic through the tunnel means the handshake completed
check 'ping -c 3 -W 3 10.99.0.1'                                                      "HANDSHAKE: ICMP to the server's tunnel address answers"
check 'curl -s --max-time 10 http://10.99.0.1:8080/ | grep -qi "<html\|directory"'    "HANDSHAKE: HTTP through the tunnel"

echo "== awg-down: nothing left behind"
check '/usr/local/bin/katacomb-vpn-helper awg-down'                                   "awg-down exit 0"
check '[ ! -e /sys/class/net/sntl0 ]'                                                 "sntl0 gone"
check '! ps -o args= -C katacomb-vpn-helper 2>/dev/null | grep -q _amneziawg'         "device process gone"
check '! ip rule show | grep -q "lookup 51820"'                                       "no fwmark rule left"
check '! ip rule show | grep -q suppress_prefixlength'                                "no suppress rule left"
check '[ ! -e /run/katacomb-vpn/awg.state ] && [ ! -e /run/katacomb-vpn/sntl0.conf ]' "awg.state and sntl0.conf removed"

if [ "$HAVE_RESOLVCONF" = 1 ]; then
echo "== run 2: awg-up WITH DNS — the resolvconf exec path"
sed -i 's|^PrivateKey = |DNS = 10.99.0.1\nPrivateKey = |' "$WORK/cli/sntl0.conf"
if c '/usr/local/bin/katacomb-vpn-helper awg-up /cfg/sntl0.conf -' >"$WORK/cli-up2.log" 2>&1; then ok "awg-up with DNS exit 0"; else no "awg-up with DNS: $(cat "$WORK/cli-up2.log")"; fi
check 'resolvconf -l sntl0 2>/dev/null | grep -q 10.99.0.1 || grep -qs 10.99.0.1 /run/resolvconf/interface/sntl0 /run/resolvconf/interfaces/sntl0' "resolvconf -a recorded our nameserver for sntl0"
check 'ping -c 2 -W 3 10.99.0.1'                                                      "handshake again with DNS configured"
check '/usr/local/bin/katacomb-vpn-helper awg-down'                                   "awg-down"
check '! { resolvconf -l sntl0 2>/dev/null; cat /run/resolvconf/interface/sntl0 /run/resolvconf/interfaces/sntl0 2>/dev/null; } | grep -q 10.99.0.1' "resolvconf -d removed the record"
check '[ ! -e /sys/class/net/sntl0 ]'                                                 "sntl0 gone again"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -eq 0 ]; then
  echo "ALL PASSED — the embedded AmneziaWG device handshakes with the Sentinel-pinned server code"
else
  echo "SOME CHECKS FAILED (KEEP=1 to inspect the containers)"; exit 1
fi
