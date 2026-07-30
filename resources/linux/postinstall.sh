#!/bin/bash
# Post-install for the Katacomb VPN .deb. Installs the polkit helper + policy
# (fallback path) AND the persistent root daemon (so connect/disconnect never
# prompt for a password — Mullvad-style).

APP_DIR="/opt/Katacomb VPN"

HELPER_SRC="$APP_DIR/resources/linux/katacomb-vpn-helper.sh"
POLICY_SRC="$APP_DIR/resources/linux/com.katacomb.vpn.policy"
UNIT_SRC="$APP_DIR/resources/linux/katacomb-vpn-daemon.service"

HELPER_DEST="/usr/local/bin/katacomb-vpn-helper"
POLICY_DEST="/usr/share/polkit-1/actions/com.katacomb.vpn.policy"
UNIT_DEST="/etc/systemd/system/katacomb-vpn-daemon.service"

# --- Transitional: remove the pre-rename (Sentinel dVPN) install ---
# Nothing owns those files after the rename, and leaving them behind would keep a
# root-capable helper on disk with a live polkit grant pointing at it.
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now sentinel-dvpn-daemon.service 2>/dev/null || true
fi
rm -f /usr/local/bin/sentinel-vpn-helper \
      /usr/share/polkit-1/actions/com.sentinel.dvpn.policy \
      /etc/systemd/system/sentinel-dvpn-daemon.service \
      /opt/sentinel-dvpn
groupdel sentinel-dvpn 2>/dev/null || true

# --- Privileged helper + polkit policy (used by the daemon and the fallback) ---
if [ -f "$HELPER_SRC" ]; then
  cp "$HELPER_SRC" "$HELPER_DEST"
  chmod 755 "$HELPER_DEST"
  chown root:root "$HELPER_DEST"
fi

if [ -f "$POLICY_SRC" ]; then
  cp "$POLICY_SRC" "$POLICY_DEST"
  chmod 644 "$POLICY_DEST"
  chown root:root "$POLICY_DEST"
fi

# --- Socket access group (finding C1) ---
# Only members of this group can drive the privileged daemon socket (0660),
# instead of every local user. The invoking desktop user is added so connect/
# disconnect stays password-free. Group membership takes effect on their NEXT
# login; until then the GUI transparently falls back to the pkexec helper.
groupadd -f katacomb-vpn
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  usermod -aG katacomb-vpn "$SUDO_USER" || true
fi

# --- Persistent root daemon ---
# Space-free symlink so the systemd unit's ExecStart needs no quoting.
ln -sfn "$APP_DIR" /opt/katacomb-vpn

if [ -f "$UNIT_SRC" ] && command -v systemctl >/dev/null 2>&1; then
  cp "$UNIT_SRC" "$UNIT_DEST"
  chmod 644 "$UNIT_DEST"
  systemctl daemon-reload
  systemctl enable katacomb-vpn-daemon.service
  # `restart` (not just start) so an upgrade replaces a still-running old daemon.
  systemctl restart katacomb-vpn-daemon.service
fi

exit 0
