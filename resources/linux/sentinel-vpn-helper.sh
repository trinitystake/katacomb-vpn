#!/bin/bash
# Sentinel dVPN helper — runs as root via polkit
# Handles WireGuard up/down and tun2socks spawn/routing/teardown
set -euo pipefail

ALLOWED_IFACE="sntl0"
TUN_IFACE="sntl-tun"
TUN_ADDR="198.18.0.1/15"
RUN_DIR="/run/sentinel-dvpn"
STATE_FILE="${RUN_DIR}/tun.state"

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

# Ensure state directory exists with restrictive permissions
ensure_run_dir() {
  if [[ ! -d "$RUN_DIR" ]]; then
    mkdir -p "$RUN_DIR"
    chmod 700 "$RUN_DIR"
    chown root:root "$RUN_DIR"
  fi
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
    wg-quick up "$CONFIG"
    ;;
  down)
    for iface in $(ip -o link show type wireguard 2>/dev/null | awk -F'[ :]+' '{print $2}'); do
      validate_iface "$iface"
      wg-quick down "$iface" 2>/dev/null || ip link delete "$iface" 2>/dev/null || true
    done
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

    # Spawn tun2socks fully detached
    nohup "$TUN2SOCKS_BIN" -device "tun://$TUN_IFACE" -proxy "socks5://$SOCKS_ADDR" -loglevel silent \
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
    iptables -D OUTPUT -j "$CHAIN" 2>/dev/null || true
    iptables -F "$CHAIN" 2>/dev/null || true
    iptables -X "$CHAIN" 2>/dev/null || true

    # Create chain
    iptables -N "$CHAIN"

    # Allow loopback
    iptables -A "$CHAIN" -o lo -j ACCEPT
    # Allow traffic on the VPN interface
    iptables -A "$CHAIN" -o "$VPN_IFACE" -j ACCEPT
    # Allow traffic to VPN server (needed to maintain the tunnel)
    iptables -A "$CHAIN" -d "$REMOTE_HOST/32" -j ACCEPT
    # Allow DHCP client
    iptables -A "$CHAIN" -p udp --dport 67:68 -j ACCEPT
    # Allow DNS to configured resolver
    if [[ -n "$DNS_IP" ]]; then
      iptables -A "$CHAIN" -d "$DNS_IP/32" -p udp --dport 53 -j ACCEPT
      iptables -A "$CHAIN" -d "$DNS_IP/32" -p tcp --dport 53 -j ACCEPT
    fi
    # Allow established/related connections (for the tunnel itself)
    iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Drop everything else
    iptables -A "$CHAIN" -j DROP

    # Insert jump rule
    iptables -A OUTPUT -j "$CHAIN"

    # Save state
    ensure_run_dir
    echo "$VPN_IFACE $REMOTE_HOST ${DNS_IP:-}" > "${RUN_DIR}/killswitch.state"
    chmod 600 "${RUN_DIR}/killswitch.state"
    ;;
  killswitch-off)
    # Disable kill switch — flush chain and remove jump
    CHAIN="SENTINEL_KILLSWITCH"
    iptables -D OUTPUT -j "$CHAIN" 2>/dev/null || true
    iptables -F "$CHAIN" 2>/dev/null || true
    iptables -X "$CHAIN" 2>/dev/null || true
    rm -f "${RUN_DIR}/killswitch.state"
    ;;
  dns-set)
    # Set DNS resolver — backs up current resolv.conf
    DNS_IP="${2:-}"
    validate_ipv4 "$DNS_IP"

    ensure_run_dir

    # Check if systemd-resolved is running
    if command -v resolvectl &>/dev/null && systemctl is-active --quiet systemd-resolved 2>/dev/null; then
      # Use resolvectl for systemd-resolved systems
      # Save current DNS for restore
      resolvectl dns 2>/dev/null > "${RUN_DIR}/dns-backup.resolved" || true
      # Set global DNS
      resolvectl dns --interface=all "$DNS_IP" 2>/dev/null || true
    else
      # Direct resolv.conf modification
      if [[ ! -f "${RUN_DIR}/resolv.conf.bak" ]]; then
        cp /etc/resolv.conf "${RUN_DIR}/resolv.conf.bak"
        chmod 600 "${RUN_DIR}/resolv.conf.bak"
      fi
      echo "nameserver $DNS_IP" > /etc/resolv.conf
    fi
    ;;
  dns-restore)
    # Restore original DNS configuration
    if command -v resolvectl &>/dev/null && systemctl is-active --quiet systemd-resolved 2>/dev/null; then
      # Restart systemd-resolved to restore defaults
      systemctl restart systemd-resolved 2>/dev/null || true
      rm -f "${RUN_DIR}/dns-backup.resolved"
    else
      if [[ -f "${RUN_DIR}/resolv.conf.bak" ]]; then
        cp "${RUN_DIR}/resolv.conf.bak" /etc/resolv.conf
        rm -f "${RUN_DIR}/resolv.conf.bak"
      fi
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
    echo "Usage: sentinel-vpn-helper {up <config>|down|tun-up <bin> <socks> <remote> <gw> <if>|tun-down|killswitch-on <iface> <host> [dns]|killswitch-off|dns-set <ip>|dns-restore}" >&2
    exit 1
    ;;
esac
