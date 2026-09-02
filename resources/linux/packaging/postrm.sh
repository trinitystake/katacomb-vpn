#!/bin/bash
# Runs after the .deb is removed (dpkg postrm). On a real removal (not an
# upgrade): tear down any live tunnel + kill switch FIRST — the helper is still
# present here and runs as root — so removing the package never strands the user
# behind a DROP-all firewall, then stop+disable the daemon and remove everything.
#
# Like postinstall.sh, this REPLACES electron-builder's after-remove template
# rather than extending it — see the note there. The template's block is
# reproduced below; without it an uninstall would leave the AppArmor profile
# loaded in the kernel and a dangling /usr/bin symlink behind.
#
# Macro-replacer caveat applies here too: electron-builder expands the
# letters-only names executable and sanitizedProductName, and fails the build on
# any other letters-only `${...}` placeholder — comments included.

# ============================================================================
# Reproduced from electron-builder templates/linux/after-remove.tpl
# Unconditional (not guarded by the upgrade check below) because dpkg runs the
# OLD postrm before the NEW postinst, which re-creates both.
# ============================================================================

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# ============================================================================
# Katacomb VPN specifics
# ============================================================================

if [ "$1" != "upgrade" ]; then
  HELPER="/usr/local/bin/katacomb-vpn-helper"
  if [ -x "$HELPER" ]; then
    "$HELPER" killswitch-off 2>/dev/null || true
    "$HELPER" tun-down 2>/dev/null || true
    "$HELPER" down 2>/dev/null || true
    "$HELPER" awg-down 2>/dev/null || true
    "$HELPER" dns-restore 2>/dev/null || true
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop katacomb-vpn-daemon.service 2>/dev/null || true
    systemctl disable katacomb-vpn-daemon.service 2>/dev/null || true
  fi

  rm -f /etc/systemd/system/katacomb-vpn-daemon.service
  rm -f /opt/katacomb-vpn
  rm -f "$HELPER"
  rm -f /usr/share/polkit-1/actions/com.katacomb.vpn.policy

  # Remove the socket-access group (finding C1). Best-effort — harmless if it has
  # members or is already gone.
  groupdel katacomb-vpn 2>/dev/null || true

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
  fi
fi

exit 0
