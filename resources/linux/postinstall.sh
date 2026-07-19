#!/bin/bash
# Post-install for the Sentinel dVPN .deb. Installs the polkit helper + policy
# (fallback path) AND the persistent root daemon (so connect/disconnect never
# prompt for a password — Mullvad-style).

APP_DIR="/opt/Sentinel dVPN"

HELPER_SRC="$APP_DIR/resources/linux/sentinel-vpn-helper.sh"
POLICY_SRC="$APP_DIR/resources/linux/com.sentinel.dvpn.policy"
UNIT_SRC="$APP_DIR/resources/linux/sentinel-dvpn-daemon.service"

HELPER_DEST="/usr/local/bin/sentinel-vpn-helper"
POLICY_DEST="/usr/share/polkit-1/actions/com.sentinel.dvpn.policy"
UNIT_DEST="/etc/systemd/system/sentinel-dvpn-daemon.service"

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
groupadd -f sentinel-dvpn
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  usermod -aG sentinel-dvpn "$SUDO_USER" || true
fi

# --- Persistent root daemon ---
# Space-free symlink so the systemd unit's ExecStart needs no quoting.
ln -sfn "$APP_DIR" /opt/sentinel-dvpn

if [ -f "$UNIT_SRC" ] && command -v systemctl >/dev/null 2>&1; then
  cp "$UNIT_SRC" "$UNIT_DEST"
  chmod 644 "$UNIT_DEST"
  systemctl daemon-reload
  systemctl enable sentinel-dvpn-daemon.service
  # `restart` (not just start) so an upgrade replaces a still-running old daemon.
  systemctl restart sentinel-dvpn-daemon.service
fi

exit 0
