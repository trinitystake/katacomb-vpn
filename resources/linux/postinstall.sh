#!/bin/bash
# Post-install script for Sentinel dVPN .deb package
# Installs the polkit policy and VPN helper script to system paths

HELPER_SRC="/opt/Sentinel dVPN/resources/linux/sentinel-vpn-helper.sh"
POLICY_SRC="/opt/Sentinel dVPN/resources/linux/com.sentinel.dvpn.policy"

HELPER_DEST="/usr/local/bin/sentinel-vpn-helper"
POLICY_DEST="/usr/share/polkit-1/actions/com.sentinel.dvpn.policy"

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
