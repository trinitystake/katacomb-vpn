#!/bin/bash
# Post-install for the Katacomb VPN .deb. Installs the polkit helper + policy
# (fallback path) AND the persistent root daemon (so connect/disconnect never
# prompt for a password — Mullvad-style).
#
# IMPORTANT — this file REPLACES electron-builder's own after-install template;
# it is not merged with it. FpmTarget's getResource() returns our path *instead
# of* templates/linux/after-install.tpl, so anything the template did and we
# don't is simply lost. It was: the AppArmor profile install (without which the
# app FAILS TO LAUNCH on stock Ubuntu 24.04+, where
# kernel.apparmor_restrict_unprivileged_userns=1 — Linux Mint sets it back to 0,
# which is why this stayed invisible in development), the chrome-sandbox SUID
# fallback, the /usr/bin launcher symlink and the desktop/MIME cache refresh.
# That block is reproduced verbatim below. Keep it in sync when upgrading
# electron-builder, and mirror removals in postrm.sh.
#
# NOTE: electron-builder runs this file through a macro replacer that expands
# every `${...}` reference whose name is letters-only, and THROWS on a name it
# does not know — comments included. It defines exactly two, both used below:
# executable and sanitizedProductName. So any other letters-only placeholder
# breaks the BUILD, not the install. Shell variables here therefore use the
# bare $NAME form, or a name containing an underscore.

APP_DIR="/opt/${sanitizedProductName}"

# ============================================================================
# Reproduced from electron-builder templates/linux/after-install.tpl
# ============================================================================

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# ============================================================================
# Katacomb VPN specifics
# ============================================================================

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
# instead of every local user. The installing desktop user is added so connect/
# disconnect stays password-free. Group membership takes effect on their NEXT
# login; until then the GUI transparently falls back to the pkexec helper.
#
# $SUDO_USER alone only covers `sudo apt install ./…deb`. GUI front ends
# (GNOME Software/PackageKit, Discover, gdebi) escalate via polkit and leave it
# unset, so nobody was added and the password-free daemon — the whole point of
# shipping it — silently never engaged for anyone who installed by double-click.
# $PKEXEC_UID covers the polkit path; logname covers a plain root shell on a tty.
# Deliberately NOT falling back to "every user with a session": this group is a
# privilege boundary, so an unattended guess is worse than the pkexec prompt.
groupadd -f katacomb-vpn
KATACOMB_INSTALL_USER=""
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  KATACOMB_INSTALL_USER="$SUDO_USER"
elif [ -n "${PKEXEC_UID:-}" ]; then
  KATACOMB_INSTALL_USER="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
elif command -v logname >/dev/null 2>&1; then
  KATACOMB_INSTALL_USER="$(logname 2>/dev/null || true)"
  [ "$KATACOMB_INSTALL_USER" = "root" ] && KATACOMB_INSTALL_USER=""
fi

if [ -n "$KATACOMB_INSTALL_USER" ]; then
  usermod -aG katacomb-vpn "$KATACOMB_INSTALL_USER" || true
else
  echo "katacomb-vpn: could not determine the desktop user, so nobody was added" >&2
  echo "katacomb-vpn: to the 'katacomb-vpn' group. Connecting will ask for a" >&2
  echo "katacomb-vpn: password each time until you run:" >&2
  echo "katacomb-vpn:     sudo usermod -aG katacomb-vpn \$USER" >&2
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
