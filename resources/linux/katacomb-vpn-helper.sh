#!/bin/bash
# Katacomb VPN helper — runs as root via polkit
# Handles WireGuard up/down and tun2socks spawn/routing/teardown
set -euo pipefail

ALLOWED_IFACE="sntl0"
TUN_IFACE="sntl-tun"
# OpenVPN's own interface — sntl0 is taken by WireGuard/AmneziaWG, and a shared
# name would make teardown ambiguous between awg-down and ovpn-down.
OVPN_IFACE="sntl-ovpn"
TUN_ADDR="198.18.0.1/15"
# tun2socks terminates TCP in a userspace netstack and advertises MSS = MTU-40 to
# local apps. With no explicit MTU, its default is too large for the proxy-wrapped
# path (V2Ray/Xray add TLS/VLESS overhead to a possibly-far node), so big TLS
# handshakes (e.g. Chrome's large ClientHello to sites like eBay) stall while
# smaller ones succeed. A conservative MTU makes those fit. Set here so it applies
# at tun2socks startup — setting it on the interface afterward is ignored (the
# netstack caches MTU at creation). Lower to 1280 (IPv6 min, always deliverable)
# if a site still stalls; raise toward 1500 only if throughput matters more.
TUN_MTU="1400"
RUN_DIR="/run/katacomb-vpn"
STATE_FILE="${RUN_DIR}/tun.state"
OVPN_PID_FILE="${RUN_DIR}/openvpn.pid"
OVPN_LOG_FILE="${RUN_DIR}/openvpn.log"
# Persistent (non-tmpfs) state. Only the resolv.conf backup lives here: it must
# survive a crash/reboot-while-connected so DNS can be restored to the user's
# original (a tmpfs backup would be wiped while the static /etc/resolv.conf the
# helper wrote survives on disk, stranding DNS on the tunnel resolver).
PERSIST_DIR="/var/lib/katacomb-vpn"

# --- Local network sharing ---
# Destinations that stay reachable while the kill switch is armed, so the user can
# still reach their own LAN. Hardcoded HERE on purpose: the app sends one boolean
# and never a range, so nothing a compromised renderer — or the unauthenticated
# daemon socket — can say turns this into a hole to a public address.
# An ACCEPT in OUTPUT only permits; it does not route. A packet reaches the
# physical NIC only if the routing table already decided the destination was
# local, so these rules cannot pull tunnel traffic out of the tunnel.
LAN_SHARING_ARG="lan-sharing"
LAN_RANGES_V4=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 224.0.0.0/4 255.255.255.255/32)
# fe80::/10 also unbreaks neighbour discovery, which the v6 chain drops today.
LAN_RANGES_V6=(fe80::/10 fc00::/7 ff00::/8)

# --- Input validation helpers ---

# Validate an IPv4 address (strict: digits and dots only)
validate_ipv4() {
  local ip="$1"
  if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: invalid IPv4 address: $ip" >&2
    exit 1
  fi
}

# Validate a network interface name (alphanumeric, hyphens, max 15 chars)
validate_iface() {
  local iface="$1"
  if [[ ! "$iface" =~ ^[a-zA-Z0-9_-]{1,15}$ ]]; then
    echo "Error: invalid interface name: $iface" >&2
    exit 1
  fi
}

# Validate a file path (no shell metacharacters)
validate_path() {
  local path="$1"
  if [[ "$path" =~ [\'\"\;\&\|\`\$\(\)\{\}] ]]; then
    echo "Error: invalid characters in path: $path" >&2
    exit 1
  fi
}

# Validate a host:port SOCKS address
validate_socks_addr() {
  local addr="$1"
  if [[ ! "$addr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$ ]]; then
    echo "Error: invalid SOCKS address: $addr" >&2
    exit 1
  fi
}

# Validate WireGuard config CONTENT — allow-list [Interface]/[Peer] keys and
# reject any script-executing directive (PostUp/PreUp/PostDown/PreDown) or
# routing-table override. Mirror of assertSafeWireguardConfig in config-guard.ts.
# This is the last line of defense: it holds even if the daemon/app validation
# is bypassed or the helper is invoked directly.
validate_wg_config() {
  local config="$1"
  local section="" line key lc_key sec
  while IFS= read -r line || [[ -n "$line" ]]; do
    # trim surrounding whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      sec="${BASH_REMATCH[1],,}"
      if [[ "$sec" != "interface" && "$sec" != "peer" ]]; then
        echo "Error: WireGuard config section [$sec] is not allowed" >&2; exit 1
      fi
      section="$sec"; continue
    fi
    if [[ "$line" != *"="* ]]; then
      echo "Error: malformed WireGuard config line is not allowed" >&2; exit 1
    fi
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    lc_key="${key,,}"
    if [[ -z "$section" ]]; then
      echo "Error: WireGuard key outside any section is not allowed" >&2; exit 1
    fi
    if [[ "$section" == "interface" ]]; then
      case "$lc_key" in
        privatekey|address|dns|mtu|listenport) ;;
        *) echo "Error: WireGuard [Interface] key '$lc_key' is not allowed" >&2; exit 1 ;;
      esac
    else
      case "$lc_key" in
        publickey|presharedkey|allowedips|endpoint|persistentkeepalive) ;;
        *) echo "Error: WireGuard [Peer] key '$lc_key' is not allowed" >&2; exit 1 ;;
      esac
    fi
  done < "$config"
}

# Validate AmneziaWG config CONTENT — the WireGuard allow-list plus the AWG
# obfuscation keys (awg-quick is a wg-quick fork, so PostUp/PreUp execute as
# root identically and must be rejected the same way). Mirror of
# assertSafeAmneziaWgConfig in config-guard.ts; last line of defense like
# validate_wg_config above.
validate_awg_config() {
  local config="$1"
  local section="" line key lc_key sec
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      sec="${BASH_REMATCH[1],,}"
      if [[ "$sec" != "interface" && "$sec" != "peer" ]]; then
        echo "Error: AmneziaWG config section [$sec] is not allowed" >&2; exit 1
      fi
      section="$sec"; continue
    fi
    if [[ "$line" != *"="* ]]; then
      echo "Error: malformed AmneziaWG config line is not allowed" >&2; exit 1
    fi
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    lc_key="${key,,}"
    if [[ -z "$section" ]]; then
      echo "Error: AmneziaWG key outside any section is not allowed" >&2; exit 1
    fi
    if [[ "$section" == "interface" ]]; then
      case "$lc_key" in
        privatekey|address|dns|mtu|listenport) ;;
        jc|jmin|jmax|s1|s2|s3|s4|h1|h2|h3|h4|i1|i2|i3|i4|i5) ;;
        *) echo "Error: AmneziaWG [Interface] key '$lc_key' is not allowed" >&2; exit 1 ;;
      esac
    else
      case "$lc_key" in
        publickey|presharedkey|allowedips|endpoint|persistentkeepalive) ;;
        *) echo "Error: AmneziaWG [Peer] key '$lc_key' is not allowed" >&2; exit 1 ;;
      esac
    fi
  done < "$config"
}

# Validate OpenVPN config CONTENT — allow-list directives and inline PKI blocks,
# rejecting everything else. openvpn executes up/down/route-up/ipchange/plugin/
# tls-verify/client-connect/learn-address as ROOT, and script-security would
# re-enable them, so the allow-list is the security boundary (same discipline as
# validate_wg_config). Mirror of assertSafeOpenVpnConfig in config-guard.ts; last
# line of defense if the daemon is bypassed or the helper is invoked directly.
# Operational flags the app needs (--daemon/--writepid/--log/--script-security)
# are intentionally NOT allowed in the file — ovpn-up passes them on the command
# line, so they can only come from us.
validate_openvpn_config() {
  local config="$1"
  local line directive lc_dir block="" tag
  local -A seen_block=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    # trim surrounding whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    # Inside an inline PKI block: PEM armor or base64/hex body only.
    if [[ -n "$block" ]]; then
      if [[ "$line" == "</$block>" ]]; then block=""; continue; fi
      [[ -z "$line" ]] && continue
      if [[ ! "$line" =~ ^-----(BEGIN|END)\ [A-Za-z0-9\ ]{1,48}-----$ && ! "$line" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
        echo "Error: OpenVPN inline block contains a non-PEM line" >&2; exit 1
      fi
      continue
    fi
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    if [[ "$line" =~ ^\<([A-Za-z0-9-]+)\>$ ]]; then
      tag="${BASH_REMATCH[1],,}"
      case "$tag" in
        ca|cert|key|tls-crypt) ;;
        *) echo "Error: OpenVPN inline block <$tag> is not allowed" >&2; exit 1 ;;
      esac
      if [[ -n "${seen_block[$tag]:-}" ]]; then
        echo "Error: OpenVPN inline block <$tag> is repeated" >&2; exit 1
      fi
      seen_block[$tag]=1
      block="$tag"; continue
    fi
    if [[ "$line" == \<* ]]; then
      echo "Error: OpenVPN stray tag is not allowed" >&2; exit 1
    fi
    directive="${line%%[[:space:]]*}"
    lc_dir="${directive,,}"
    case "$lc_dir" in
      client|dev|dev-type|proto|remote|nobind|auth-nocache|auth) ;;
      data-ciphers|data-ciphers-fallback|tls-cipher|tls-client|tls-version-min) ;;
      remote-cert-tls|redirect-gateway|topology|explicit-exit-notify) ;;
      persist-key|persist-tun) ;;
      *) echo "Error: OpenVPN directive '$lc_dir' is not allowed" >&2; exit 1 ;;
    esac
  done < "$config"
  if [[ -n "$block" ]]; then
    echo "Error: OpenVPN inline block <$block> is unterminated" >&2; exit 1
  fi
  for tag in ca cert key tls-crypt; do
    if [[ -z "${seen_block[$tag]:-}" ]]; then
      echo "Error: OpenVPN inline block <$tag> is missing" >&2; exit 1
    fi
  done
}

# Resolve the system openvpn from an absolute allow-list. Never a $PATH lookup and
# never a caller-supplied path: this runs as root.
resolve_openvpn_bin() {
  local candidate
  for candidate in /usr/sbin/openvpn /sbin/openvpn /usr/bin/openvpn; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "Error: openvpn is not installed" >&2
  exit 1
}

# Ensure state directory exists with restrictive permissions
ensure_run_dir() {
  if [[ ! -d "$RUN_DIR" ]]; then
    mkdir -p "$RUN_DIR"
    chmod 700 "$RUN_DIR"
    chown root:root "$RUN_DIR"
  fi
}

# Ensure the persistent state directory exists (survives reboot).
ensure_persist_dir() {
  if [[ ! -d "$PERSIST_DIR" ]]; then
    mkdir -p "$PERSIST_DIR"
    chmod 700 "$PERSIST_DIR"
    chown root:root "$PERSIST_DIR"
  fi
}

# --- IPv6 kill switch ---
# The tunnel, the VPN server, and the DNS resolver are all IPv4, so the correct
# fail-closed behaviour for IPv6 is to permit it ONLY out loopback and the VPN
# interface (so v6 carried inside the tunnel still works) and drop every other
# v6 egress — closing the native-IPv6 real-IP leak that an IPv4-only kill switch
# leaves open. Best-effort: skipped when ip6tables is unavailable (IPv6-disabled
# host) and never allowed to abort the IPv4 kill switch (callers use `|| ...`).
CHAIN6="KATACOMB_KILLSWITCH6"

# --- wg-quick policy-routing rule cleanup ---
# wg-quick/awg-quick install a rule PAIR per bring-up for a full-tunnel config:
#   not from all fwmark 0xca6c lookup 51820
#   from all lookup main suppress_prefixlength 0
# Their own `down` removes them, but ours almost never runs it: `wg-quick down
# sntl0` resolves the name against /etc/wireguard and our config lives elsewhere,
# so the `down` verb falls through to `ip link delete` (and `awg-down` only ever
# did that). The interface goes, the rules stay, and they accumulate one pair per
# connect. Measured 2026-08-19: three pairs against a single live sntl0.
#
# Scoped tightly, because these rules are not ours alone:
#  - runs only once NO tunnel that could own them is left;
#  - deletes a fwmark table only if it is in wg-quick's own allocation range
#    (it starts at 51820 and counts up), so another VPN's table 100 is untouched;
#  - every loop is bounded, so a delete that keeps failing can never spin.
WG_TABLE_MIN=51820
WG_TABLE_MAX=51899

wg_rule_tables() {
  # Tables named by a wg-quick-shaped fwmark rule, restricted to its own range.
  ip "$1" rule show 2>/dev/null | awk -v lo="$WG_TABLE_MIN" -v hi="$WG_TABLE_MAX" '
    /fwmark/ {
      for (i = 1; i <= NF; i++)
        if ($i == "lookup" && $(i+1) + 0 >= lo && $(i+1) + 0 <= hi) print $(i+1)
    }' | sort -u
}

cleanup_wg_rules() {
  # A second WireGuard tunnel (or our own, still up) means these rules are in use.
  ip -o link show type wireguard 2>/dev/null | grep -q . && return 0
  ip link show "$ALLOWED_IFACE" &>/dev/null && return 0

  local fam table n
  for fam in -4 -6; do
    for table in $(wg_rule_tables "$fam"); do
      n=0
      while [[ $n -lt 32 ]] && ip "$fam" rule show 2>/dev/null | grep -q "lookup $table"; do
        ip "$fam" rule delete table "$table" 2>/dev/null || break
        n=$((n + 1))
      done
    done
    n=0
    while [[ $n -lt 32 ]] && ip "$fam" rule show 2>/dev/null | grep -q "suppress_prefixlength 0"; do
      ip "$fam" rule delete table main suppress_prefixlength 0 2>/dev/null || break
      n=$((n + 1))
    done
  done
}

ipv6_available() {
  command -v ip6tables >/dev/null 2>&1 && ip6tables -S >/dev/null 2>&1
}

ipv6_killswitch_off() {
  ip6tables -w 5 -D OUTPUT -j "$CHAIN6" 2>/dev/null || true
  ip6tables -w 5 -F "$CHAIN6" 2>/dev/null || true
  ip6tables -w 5 -X "$CHAIN6" 2>/dev/null || true
}

ipv6_killswitch_on() {
  local vpn_iface="$1"
  local lan_sharing="${2:-0}"
  ipv6_killswitch_off
  # Short-circuited so a partial failure aborts and the caller can clean up.
  ip6tables -w 5 -N "$CHAIN6" &&
  ip6tables -w 5 -A "$CHAIN6" -o lo -j ACCEPT &&
  ip6tables -w 5 -A "$CHAIN6" -o "$vpn_iface" -j ACCEPT &&
  ip6tables -w 5 -A "$CHAIN6" -o "$vpn_iface" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  if [[ "$lan_sharing" == "1" ]]; then
    for range in "${LAN_RANGES_V6[@]}"; do
      ip6tables -w 5 -A "$CHAIN6" -d "$range" -j ACCEPT || return 1
    done
  fi
  ip6tables -w 5 -A "$CHAIN6" -j DROP &&
  ip6tables -w 5 -A OUTPUT -j "$CHAIN6"
}

case "${1:-}" in
  up)
    CONFIG="${2:-}"
    if [[ -z "$CONFIG" || ! -f "$CONFIG" || "$CONFIG" != *.conf ]]; then
      echo "Error: invalid config path" >&2
      exit 1
    fi
    validate_path "$CONFIG"
    IFACE="$(basename "$CONFIG" .conf)"
    if [[ "$IFACE" != "$ALLOWED_IFACE" ]]; then
      echo "Error: interface must be $ALLOWED_IFACE, got $IFACE" >&2
      exit 1
    fi
    validate_wg_config "$CONFIG"
    wg-quick up "$CONFIG"
    ;;
  down)
    for iface in $(ip -o link show type wireguard 2>/dev/null | awk -F'[ :]+' '{print $2}'); do
      validate_iface "$iface"
      wg-quick down "$iface" 2>/dev/null || ip link delete "$iface" 2>/dev/null || true
    done
    # The `ip link delete` fallback above is the normal path, not the exception,
    # and it leaves wg-quick's policy-routing rules behind.
    cleanup_wg_rules
    ;;
  awg-up)
    # AmneziaWG bring-up: same config rules as `up`, but via bundled awg-quick.
    # BINDIR holds the SHA-pinned trio (awg, awg-quick, amneziawg-go); the daemon
    # passes its own verified dir, the pkexec path is gated by polkit auth (same
    # trust model as tun-up's caller-supplied binary).
    CONFIG="${2:-}"
    BINDIR="${3:-}"
    if [[ -z "$CONFIG" || ! -f "$CONFIG" || "$CONFIG" != *.conf ]]; then
      echo "Error: invalid config path" >&2
      exit 1
    fi
    validate_path "$CONFIG"
    IFACE="$(basename "$CONFIG" .conf)"
    if [[ "$IFACE" != "$ALLOWED_IFACE" ]]; then
      echo "Error: interface must be $ALLOWED_IFACE, got $IFACE" >&2
      exit 1
    fi
    validate_awg_config "$CONFIG"
    if [[ -z "$BINDIR" || ! -d "$BINDIR" ]]; then
      echo "Error: invalid bin dir" >&2
      exit 1
    fi
    validate_path "$BINDIR"
    for b in awg awg-quick amneziawg-go; do
      if [[ ! -x "$BINDIR/$b" ]]; then
        echo "Error: $b missing from bin dir" >&2
        exit 1
      fi
    done
    # awg-quick shells out to `awg` and (userspace default) `amneziawg-go` by
    # bare name — prepend the verified dir so only the bundled trio is found.
    PATH="$BINDIR:$PATH" "$BINDIR/awg-quick" up "$CONFIG"
    ;;
  awg-down)
    # amneziawg-go exits when its TUN device is removed — same teardown fidelity
    # as the `down` fallback above (wg-quick down by name fails for our config
    # location there too and falls back to ip link delete).
    ip link delete "$ALLOWED_IFACE" 2>/dev/null || true
    # awg-quick installs the same rule pair wg-quick does, and nothing above
    # removes it.
    cleanup_wg_rules
    ;;
  ovpn-up)
    # OpenVPN bring-up. Unlike wg-quick/awg-quick, openvpn STAYS RESIDENT, so this
    # daemonizes it (--writepid/--log) and then waits for proof of success before
    # returning — otherwise a failed bring-up would look like a successful one.
    #
    # Every security-critical and operational flag is passed HERE, after --config,
    # so it wins (openvpn is last-one-wins) and can never come from a node:
    #   --script-security 0  no --up/--down/--plugin script can execute, ever
    #   --dev/--dev-type     pins the interface the kill switch and stats expect
    #   --connect-*          bounds the bring-up instead of retrying forever
    CONFIG="${2:-}"
    if [[ -z "$CONFIG" || ! -f "$CONFIG" || "$CONFIG" != *.conf ]]; then
      echo "Error: invalid config path" >&2
      exit 1
    fi
    validate_path "$CONFIG"
    validate_openvpn_config "$CONFIG"
    OPENVPN_BIN="$(resolve_openvpn_bin)"

    ensure_run_dir
    # Clean up any previous tunnel/state so a stale pid can't be killed later.
    if [[ -f "$OVPN_PID_FILE" ]]; then
      OLD_PID="$(cat "$OVPN_PID_FILE" 2>/dev/null || true)"
      if [[ "$OLD_PID" =~ ^[0-9]+$ ]]; then kill "$OLD_PID" 2>/dev/null || true; fi
      rm -f "$OVPN_PID_FILE"
    fi
    ip link delete "$OVPN_IFACE" 2>/dev/null || true
    rm -f "$OVPN_LOG_FILE"

    "$OPENVPN_BIN" --config "$CONFIG" \
      --dev "$OVPN_IFACE" --dev-type tun \
      --script-security 0 \
      --connect-timeout 10 --connect-retry-max 2 \
      --verb 3 --log "$OVPN_LOG_FILE" \
      --writepid "$OVPN_PID_FILE" --daemon katacomb-ovpn
    chmod 600 "$OVPN_LOG_FILE" 2>/dev/null || true

    # Wait for the tunnel to be genuinely up: the interface exists AND openvpn
    # reported a completed init (routes installed). 25s ≈ two connect attempts,
    # inside the daemon's 60s budget.
    OVPN_READY=0
    for _ in $(seq 1 125); do
      if ip link show "$OVPN_IFACE" &>/dev/null \
         && grep -q "Initialization Sequence Completed" "$OVPN_LOG_FILE" 2>/dev/null; then
        OVPN_READY=1
        break
      fi
      sleep 0.2
    done

    if [[ "$OVPN_READY" != "1" ]]; then
      OVPN_PID="$(cat "$OVPN_PID_FILE" 2>/dev/null || true)"
      if [[ "$OVPN_PID" =~ ^[0-9]+$ ]]; then kill "$OVPN_PID" 2>/dev/null || true; fi
      ip link delete "$OVPN_IFACE" 2>/dev/null || true
      rm -f "$OVPN_PID_FILE"
      # Surface the real reason (auth failure, TLS error, unreachable node) instead
      # of a bare timeout — this text reaches the connect modal.
      echo "Error: OpenVPN did not come up: $(tail -n 5 "$OVPN_LOG_FILE" 2>/dev/null | tr '\n' ' ')" >&2
      exit 1
    fi
    ;;
  ovpn-down)
    if [[ -f "$OVPN_PID_FILE" ]]; then
      OVPN_PID="$(cat "$OVPN_PID_FILE" 2>/dev/null || true)"
      if [[ "$OVPN_PID" =~ ^[0-9]+$ ]]; then
        kill "$OVPN_PID" 2>/dev/null || true
        # Give openvpn a moment to remove its routes and interface itself.
        for _ in $(seq 1 25); do
          kill -0 "$OVPN_PID" 2>/dev/null || break
          sleep 0.2
        done
        kill -9 "$OVPN_PID" 2>/dev/null || true
      fi
      rm -f "$OVPN_PID_FILE"
    fi
    # Belt and braces: drop the interface if openvpn died without cleaning up.
    ip link delete "$OVPN_IFACE" 2>/dev/null || true
    rm -f "$OVPN_LOG_FILE"
    ;;
  tun-up)
    # Spawn tun2socks + set up routing in one call
    # $2 = tun2socks binary, $3 = SOCKS addr, $4 = remote server IP, $5 = gateway, $6 = interface
    # $7 = bypass routes (optional, comma-separated CIDRs)
    TUN2SOCKS_BIN="${2:-}"
    SOCKS_ADDR="${3:-127.0.0.1:1080}"
    REMOTE_HOST="${4:-}"
    DEFAULT_GW="${5:-}"
    DEFAULT_IF="${6:-}"
    BYPASS_ROUTES="${7:-}"

    # Validate all inputs
    validate_path "$TUN2SOCKS_BIN"
    validate_socks_addr "$SOCKS_ADDR"
    validate_ipv4 "$REMOTE_HOST"
    validate_ipv4 "$DEFAULT_GW"
    validate_iface "$DEFAULT_IF"

    if [[ ! -x "$TUN2SOCKS_BIN" ]]; then
      echo "Error: tun2socks binary not found or not executable: $TUN2SOCKS_BIN" >&2
      exit 1
    fi

    # Clean up any previous state
    ip link delete "$TUN_IFACE" 2>/dev/null || true

    # Spawn tun2socks fully detached. -mtu is set at startup so the netstack
    # advertises a proxy-safe MSS (see TUN_MTU above) — fixes TLS handshakes that
    # stall on some sites through the tunnel.
    nohup "$TUN2SOCKS_BIN" -device "tun://$TUN_IFACE" -proxy "socks5://$SOCKS_ADDR" -mtu "$TUN_MTU" -loglevel silent \
      </dev/null >/dev/null 2>&1 &
    TUN2SOCKS_PID=$!

    # Wait for TUN interface to appear
    for _ in $(seq 1 50); do
      if ip link show "$TUN_IFACE" &>/dev/null; then
        break
      fi
      sleep 0.1
    done

    if ! ip link show "$TUN_IFACE" &>/dev/null; then
      kill "$TUN2SOCKS_PID" 2>/dev/null || true
      echo "Error: TUN interface did not appear" >&2
      exit 1
    fi

    # Direct route for V2Ray server via real gateway (bypass tunnel)
    ip route add "$REMOTE_HOST/32" via "$DEFAULT_GW" dev "$DEFAULT_IF" 2>/dev/null || true

    # Configure TUN interface
    ip addr add "$TUN_ADDR" dev "$TUN_IFACE" 2>/dev/null || true
    ip link set "$TUN_IFACE" up

    # Split-route: two half-ranges more specific than default route
    ip route add 0.0.0.0/1 dev "$TUN_IFACE"
    ip route add 128.0.0.0/1 dev "$TUN_IFACE"

    # Apply bypass routes (split tunneling) — route these through the real gateway
    if [[ -n "$BYPASS_ROUTES" ]]; then
      IFS=',' read -ra CIDRS <<< "$BYPASS_ROUTES"
      for cidr in "${CIDRS[@]}"; do
        cidr="$(echo "$cidr" | tr -d '[:space:]')"
        if [[ "$cidr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]]; then
          ip route add "$cidr" via "$DEFAULT_GW" dev "$DEFAULT_IF" 2>/dev/null || true
        fi
      done
    fi

    # Save state in root-only directory
    ensure_run_dir
    echo "$TUN2SOCKS_PID $REMOTE_HOST $BYPASS_ROUTES" > "$STATE_FILE"
    chmod 600 "$STATE_FILE"

    echo "$TUN2SOCKS_PID"
    ;;
  killswitch-on)
    # Enable kill switch — block all traffic except VPN
    # $2 = VPN interface, $3 = remote server IP, $4 = DNS IP (optional)
    VPN_IFACE="${2:-}"
    REMOTE_HOST="${3:-}"
    DNS_IP="${4:-}"
    # The LAN flag is a TRAILING sentinel token, so `killswitch-on <if> <host>` and
    # `killswitch-on <if> <host> <dns>` keep their exact meaning. It can collide
    # with neither $2 (an interface name) nor $3/$4 (IPv4 literals).
    LAN_SHARING=0
    if [[ "${!#}" == "$LAN_SHARING_ARG" ]]; then
      LAN_SHARING=1
      [[ "$DNS_IP" == "$LAN_SHARING_ARG" ]] && DNS_IP=""
    fi

    validate_iface "$VPN_IFACE"
    validate_ipv4 "$REMOTE_HOST"
    # A 0.0.0.0 whitelist matches no packet, so the DROP-all rule below would
    # swallow the tunnel's own outer traffic — the interface stays up and nothing
    # ever gets through. Refuse instead of installing a self-defeating chain.
    if [[ "$REMOTE_HOST" == "0.0.0.0" ]]; then
      echo "Error: killswitch remote host 0.0.0.0 whitelists nothing" >&2
      exit 1
    fi
    if [[ -n "$DNS_IP" ]]; then
      validate_ipv4 "$DNS_IP"
    fi

    CHAIN="KATACOMB_KILLSWITCH"

    # Flush existing chain if present
    iptables -w 5 -D OUTPUT -j "$CHAIN" 2>/dev/null || true
    iptables -w 5 -F "$CHAIN" 2>/dev/null || true
    iptables -w 5 -X "$CHAIN" 2>/dev/null || true

    # Create chain
    iptables -w 5 -N "$CHAIN"

    # Allow loopback
    iptables -w 5 -A "$CHAIN" -o lo -j ACCEPT
    # Allow traffic on the VPN interface
    iptables -w 5 -A "$CHAIN" -o "$VPN_IFACE" -j ACCEPT
    # Allow traffic to VPN server (needed to maintain the tunnel)
    iptables -w 5 -A "$CHAIN" -d "$REMOTE_HOST/32" -j ACCEPT
    # Allow DHCP client
    iptables -w 5 -A "$CHAIN" -p udp --dport 67:68 -j ACCEPT
    # Allow DNS to the configured resolver ONLY through the tunnel. Scoping to
    # the VPN interface stops plaintext DNS from egressing the physical NIC
    # during a tunnel-down window (it is already covered by the "-o $VPN_IFACE"
    # accept above; the explicit rule documents the intent and the scope).
    if [[ -n "$DNS_IP" ]]; then
      iptables -w 5 -A "$CHAIN" -o "$VPN_IFACE" -d "$DNS_IP/32" -p udp --dport 53 -j ACCEPT
      iptables -w 5 -A "$CHAIN" -o "$VPN_IFACE" -d "$DNS_IP/32" -p tcp --dport 53 -j ACCEPT
    fi
    # Allow established/related connections (for the tunnel interface only)
    iptables -w 5 -A "$CHAIN" -o "$VPN_IFACE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Local network sharing — must precede the DROP below.
    if [[ "$LAN_SHARING" == "1" ]]; then
      for range in "${LAN_RANGES_V4[@]}"; do
        iptables -w 5 -A "$CHAIN" -d "$range" -j ACCEPT
      done
    fi
    # Drop everything else
    iptables -w 5 -A "$CHAIN" -j DROP

    # Insert jump rule
    iptables -w 5 -A OUTPUT -j "$CHAIN"

    # IPv6: no v6 server/DNS to whitelist, so block all native v6 egress except
    # loopback + the tunnel. Best-effort — must never abort the IPv4 kill switch.
    if ipv6_available; then
      ipv6_killswitch_on "$VPN_IFACE" "$LAN_SHARING" || { ipv6_killswitch_off; echo "Warning: IPv6 kill switch setup failed; IPv4 kill switch active" >&2; }
    fi

    # Save state
    ensure_run_dir
    echo "$VPN_IFACE $REMOTE_HOST ${DNS_IP:-}" > "${RUN_DIR}/killswitch.state"
    chmod 600 "${RUN_DIR}/killswitch.state"
    ;;
  killswitch-off)
    # Disable kill switch — flush chain and remove jump. The `-w 5` lock-wait is
    # load-bearing: without it, a concurrent xtables-lock holder (NetworkManager,
    # ufw, docker) makes the `-D OUTPUT` fail, and the `|| true` then swallows it,
    # leaving the DROP chain jumped from OUTPUT — which black-holes ALL traffic
    # once the tunnel is gone (a stranded kill switch). `-w 5` waits for the lock
    # so the removal actually happens. (The `|| true` now only covers the benign
    # "chain doesn't exist" case.)
    CHAIN="KATACOMB_KILLSWITCH"
    iptables -w 5 -D OUTPUT -j "$CHAIN" 2>/dev/null || true
    iptables -w 5 -F "$CHAIN" 2>/dev/null || true
    iptables -w 5 -X "$CHAIN" 2>/dev/null || true
    # Tear down the IPv6 kill switch too — unconditional: ipv6_killswitch_off is
    # fully `|| true`-guarded (incl. a missing ip6tables binary), so it's a safe
    # no-op when nothing was installed, and it can't be skipped if ip6tables
    # availability transiently flips between connect and disconnect.
    ipv6_killswitch_off
    rm -f "${RUN_DIR}/killswitch.state"
    ;;
  dns-set)
    # Route DNS through the tunnel: point the system resolver directly at $DNS_IP
    # (which routes via the VPN interface) by replacing /etc/resolv.conf. This is
    # resolver-manager-agnostic (systemd-resolved / resolvconf / NetworkManager)
    # and — unlike the old `resolvectl --interface=all` path, which was invalid and
    # silently no-op'd — guarantees queries go to $DNS_IP, not a LAN resolver the
    # kill switch drops. Only used for V2Ray; WireGuard's DNS is owned by wg-quick.
    #
    # The prior resolv.conf is snapshotted ONCE per session for an exact restore:
    # the file/symlink via `cp -P`, or — if there was none — a marker file so
    # dns-restore returns to the no-file state. The new file is written via a temp
    # file on the SAME filesystem + atomic rename, so there is never a window with
    # no /etc/resolv.conf.
    DNS_IP="${2:-}"
    validate_ipv4 "$DNS_IP"
    ensure_persist_dir

    BAK="${PERSIST_DIR}/resolv.conf.bak"
    NONE_MARKER="${PERSIST_DIR}/resolv.conf.none"
    TMP="/etc/.resolv.conf.sntl-tmp"
    if [[ ! -e "$BAK" && ! -L "$BAK" && ! -e "$NONE_MARKER" ]]; then
      if [[ -e /etc/resolv.conf || -L /etc/resolv.conf ]]; then
        cp -P /etc/resolv.conf "$BAK"
      else
        : > "$NONE_MARKER"
      fi
    fi
    printf 'nameserver %s\n' "$DNS_IP" > "$TMP"
    chmod 644 "$TMP"
    mv -f "$TMP" /etc/resolv.conf
    ;;
  dns-restore)
    # Restore the resolv.conf captured by dns-set — the file/symlink, or the
    # no-file state. Copy to a temp on the same filesystem then atomically rename
    # so a copy failure never leaves the host with no resolver. Idempotent no-op
    # when there's nothing to restore.
    BAK="${PERSIST_DIR}/resolv.conf.bak"
    NONE_MARKER="${PERSIST_DIR}/resolv.conf.none"
    TMP="/etc/.resolv.conf.sntl-tmp"
    if [[ -e "$BAK" || -L "$BAK" ]]; then
      # No `2>/dev/null`: a copy failure should surface to the daemon log rather
      # than silently leaving resolv.conf pinned to the tunnel resolver.
      if cp -P "$BAK" "$TMP"; then
        mv -f "$TMP" /etc/resolv.conf
        rm -f "$BAK"
      fi
    elif [[ -e "$NONE_MARKER" ]]; then
      rm -f /etc/resolv.conf
      rm -f "$NONE_MARKER"
    fi
    ;;
  tun-down)
    # Kill tun2socks, tear down routing, remove TUN interface
    BYPASS_ROUTES=""
    if [[ -f "$STATE_FILE" ]]; then
      read -r TUN2SOCKS_PID REMOTE_HOST BYPASS_ROUTES < "$STATE_FILE" || true
      kill "$TUN2SOCKS_PID" 2>/dev/null || true
      rm -f "$STATE_FILE"
    else
      REMOTE_HOST=""
      pkill -f "tun://$TUN_IFACE" 2>/dev/null || true
    fi

    ip route del 0.0.0.0/1 dev "$TUN_IFACE" 2>/dev/null || true
    ip route del 128.0.0.0/1 dev "$TUN_IFACE" 2>/dev/null || true
    ip link delete "$TUN_IFACE" 2>/dev/null || true
    if [[ -n "${REMOTE_HOST:-}" ]]; then
      ip route del "$REMOTE_HOST/32" 2>/dev/null || true
    fi
    # Remove bypass routes
    if [[ -n "${BYPASS_ROUTES:-}" ]]; then
      IFS=',' read -ra CIDRS <<< "$BYPASS_ROUTES"
      for cidr in "${CIDRS[@]}"; do
        cidr="$(echo "$cidr" | tr -d '[:space:]')"
        if [[ "$cidr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]]; then
          ip route del "$cidr" 2>/dev/null || true
        fi
      done
    fi
    ;;
  *)
    echo "Usage: katacomb-vpn-helper {up <config>|down|awg-up <config> <bindir>|awg-down|ovpn-up <config>|ovpn-down|tun-up <bin> <socks> <remote> <gw> <if>|tun-down|killswitch-on <iface> <host> [dns] [lan-sharing]|killswitch-off|dns-set <ip>|dns-restore}" >&2
    exit 1
    ;;
esac
