#!/bin/bash
# Runs after the .deb is removed (dpkg postrm). On a real removal (not an
# upgrade) disable + remove the daemon unit, the symlink, the helper and the
# polkit policy. /run/sentinel-dvpn is a tmpfs RuntimeDirectory and clears itself.

if [ "$1" != "upgrade" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable sentinel-dvpn-daemon.service 2>/dev/null || true
  fi
  rm -f /etc/systemd/system/sentinel-dvpn-daemon.service
  rm -f /opt/sentinel-dvpn
  rm -f /usr/local/bin/sentinel-vpn-helper
  rm -f /usr/share/polkit-1/actions/com.sentinel.dvpn.policy
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
  fi
fi

exit 0
