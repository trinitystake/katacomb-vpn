#!/bin/bash
# Sentinel dVPN helper — runs as root via polkit
# Handles WireGuard up/down and tun2socks spawn/routing/teardown
set -euo pipefail

ALLOWED_IFACE="sntl0"
TUN_IFACE="sntl-tun"
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
RUN_DIR="/run/sentinel-dvpn"
STATE_FILE="${RUN_DIR}/tun.state"
# Persistent (non-tmpfs) state. Only the resolv.conf backup lives here: it must
# survive a crash/reboot-while-connected so DNS can be restored to the user's
# original (a tmpfs backup would be wiped while the static /etc/resolv.conf the
# helper wrote survives on disk, stranding DNS on the tunnel resolver).
PERSIST_DIR="/var/lib/sentinel-dvpn"

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
CHAIN6="SENTINEL_KILLSWITCH6"

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
  ipv6_killswitch_off
  # &&-chained so a partial failure short-circuits and the caller can clean up.
  ip6tables -w 5 -N "$CHAIN6" &&
  ip6tables -w 5 -A "$CHAIN6" -o lo -j ACCEPT &&
  ip6tables -w 5 -A "$CHAIN6" -o "$vpn_iface" -j ACCEPT &&
  ip6tables -w 5 -A "$CHAIN6" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT &&
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

    validate_iface "$VPN_IFACE"
    validate_ipv4 "$REMOTE_HOST"
    if [[ -n "$DNS_IP" ]]; then
      validate_ipv4 "$DNS_IP"
    fi

    CHAIN="SENTINEL_KILLSWITCH"

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
    # Allow established/related connections (for the tunnel itself)
    iptables -w 5 -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Drop everything else
    iptables -w 5 -A "$CHAIN" -j DROP

    # Insert jump rule
    iptables -w 5 -A OUTPUT -j "$CHAIN"

    # IPv6: no v6 server/DNS to whitelist, so block all native v6 egress except
    # loopback + the tunnel. Best-effort — must never abort the IPv4 kill switch.
    if ipv6_available; then
      ipv6_killswitch_on "$VPN_IFACE" || { ipv6_killswitch_off; echo "Warning: IPv6 kill switch setup failed; IPv4 kill switch active" >&2; }
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
    CHAIN="SENTINEL_KILLSWITCH"
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
    # the file/symlink via `cp -P`, or — if there was none — a sentinel marker so
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
    echo "Usage: sentinel-vpn-helper {up <config>|down|awg-up <config> <bindir>|awg-down|tun-up <bin> <socks> <remote> <gw> <if>|tun-down|killswitch-on <iface> <host> [dns]|killswitch-off|dns-set <ip>|dns-restore}" >&2
    exit 1
    ;;
esac
