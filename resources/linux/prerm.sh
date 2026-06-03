#!/bin/bash
# Runs before the .deb is removed (dpkg prerm). On a real removal (not an
# upgrade) tear down any live tunnel + kill switch FIRST — while the helper still
# exists — so removing the package never strands the user behind a DROP-all
# firewall, then stop the daemon.

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
  fi
fi

exit 0
