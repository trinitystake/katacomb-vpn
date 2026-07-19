#!/bin/bash
# Runs after the .deb is removed (dpkg postrm). On a real removal (not an
# upgrade): tear down any live tunnel + kill switch FIRST — the helper is still
# present here and runs as root — so removing the package never strands the user
# behind a DROP-all firewall, then stop+disable the daemon and remove everything.

if [ "$1" != "upgrade" ]; then
  HELPER="/usr/local/bin/sentinel-vpn-helper"
  if [ -x "$HELPER" ]; then
    "$HELPER" killswitch-off 2>/dev/null || true
    "$HELPER" tun-down 2>/dev/null || true
    "$HELPER" down 2>/dev/null || true
    "$HELPER" dns-restore 2>/dev/null || true
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop sentinel-dvpn-daemon.service 2>/dev/null || true
    systemctl disable sentinel-dvpn-daemon.service 2>/dev/null || true
  fi

  rm -f /etc/systemd/system/sentinel-dvpn-daemon.service
  rm -f /opt/sentinel-dvpn
  rm -f "$HELPER"
  rm -f /usr/share/polkit-1/actions/com.sentinel.dvpn.policy

  # Remove the socket-access group (finding C1). Best-effort — harmless if it has
  # members or is already gone.
  groupdel sentinel-dvpn 2>/dev/null || true

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
  fi
fi

exit 0
