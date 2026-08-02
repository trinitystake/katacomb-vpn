#!/usr/bin/env bash
# Katacomb VPN — manual .deb portability/QA verification (not part of the build).
#
# Interactive, needs root, and pauses for you to drive the GUI — this is a runbook,
# not a CI script. Installs and removes the real package on this machine. Re-run
# after touching electron-builder.yml, either maintainer script (postinstall.sh /
# postrm.sh), or the systemd unit — those are exactly what regressed the AppArmor
# profile and the deb dependency list before (see CLAUDE.md "Packaging").
#
# Run each phase in order, as root, from the repo root:
#     sudo ./scripts/verify-deb-portability.sh phase1
#     ... manual step ...
#     sudo ./scripts/verify-deb-portability.sh phase2
#
# Phases:
#   phase1  reproduce stock-Ubuntu AppArmor, install the deb, check what postinst did
#   phase2  after you have launched the GUI: confirm the profile is what allowed it
#   phase3  upgrade path (reinstall over itself)
#   phase4  removal — tunnel, kill switch, files, and INTERNET STILL WORKS
#   appimage  does the AppImage launch under stock-Ubuntu AppArmor? (independent of
#             the deb phases; run it with the deb UNINSTALLED, self-reverting)
#   revert  put kernel.apparmor_restrict_unprivileged_userns back to 0 (Mint default)
#
# Nothing here spends money or touches the chain. Only phase4 removes the package.
# DEB below picks the newest built package by mtime — rebuild with `npm run dist`
# first if dist/ is stale or empty.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEB="$(ls -t "$REPO_ROOT"/dist/katacomb-vpn_*_amd64.deb 2>/dev/null | head -1)"
APPIMAGE="$(ls -t "$REPO_ROOT"/dist/katacomb-vpn-*.AppImage 2>/dev/null | head -1)"
SYSCTL=kernel.apparmor_restrict_unprivileged_userns

# Only the deb phases need the deb; the appimage phase checks its own artifact.
if [ -z "$DEB" ] && [ "${1:-}" != "appimage" ]; then
  echo "No dist/katacomb-vpn_*_amd64.deb found — run 'npm run dist' first." >&2
  exit 1
fi

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
info() { printf '  ....  %s\n' "$1"; }
head_() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else no "$2"; fi; }
summary() {
  printf '\n%s: %d passed, %d failed\n' "$1" "$pass" "$fail"
  [ "$fail" -eq 0 ] || printf '\033[31mSTOP — investigate before continuing.\033[0m\n'
  [ "$fail" -eq 0 ]
}

need_root() { [ "$(id -u)" -eq 0 ] || { echo "run me with sudo"; exit 1; }; }

phase1() {
  need_root
  head_ "1. Reproduce stock Ubuntu 24.04 (Mint overrides this sysctl to 0)"
  sysctl -w "$SYSCTL=1"

  head_ "2. Install"
  apt install -y "$DEB" || { echo "install FAILED — read the output above"; exit 1; }

  head_ "3. What postinst actually did"
  check "[ -f /etc/apparmor.d/katacomb-vpn ]"                 "AppArmor profile installed at /etc/apparmor.d/katacomb-vpn"
  check "aa-status 2>/dev/null | grep -q katacomb || apparmor_status 2>/dev/null | grep -q katacomb" \
                                                              "profile loaded into the kernel"
  check "[ -x /usr/local/bin/katacomb-vpn-helper ]"           "helper installed and executable"
  check "[ -e /usr/bin/katacomb-vpn ]"                        "/usr/bin/katacomb-vpn launcher exists"
  check "[ -f /usr/share/polkit-1/actions/com.katacomb.vpn.policy ]" "polkit policy installed"
  check "systemctl is-active --quiet katacomb-vpn-daemon"     "katacomb-vpn-daemon active"
  check "systemctl is-enabled --quiet katacomb-vpn-daemon"    "katacomb-vpn-daemon enabled at boot"
  check "[ -L /opt/katacomb-vpn ]"                            "/opt/katacomb-vpn space-free symlink"
  check "getent group katacomb-vpn | grep -q '${SUDO_USER:-neo}'" \
                                                              "user ${SUDO_USER:-neo} is in group katacomb-vpn"
  info  "helper perms: $(stat -c '%a %U:%G' /usr/local/bin/katacomb-vpn-helper 2>&1)"
  info  "launcher:     $(ls -l /usr/bin/katacomb-vpn 2>&1)"
  info  "sandbox:      $(stat -c '%a' '/opt/Katacomb VPN/chrome-sandbox' 2>&1) (0755 expected — the profile, not SUID, is what permits userns)"
  info  "group:        $(getent group katacomb-vpn 2>&1)"

  summary "phase1"
  cat <<'EOM'

NEXT — manual, and this is the actual Task 1 test:

  1. As your normal user (not root), run:  katacomb-vpn
     PASS = the window opens.
     FAIL = "The SUID sandbox helper binary was found, but is not configured
            correctly" or a user-namespace error. Then read the postinst output:
            sudo grep -A40 katacomb /var/log/apt/term.log | tail -60

  2. Close it, then run:  sudo ./scripts/verify-deb-portability.sh phase2
EOM
}

phase2() {
  need_root
  head_ "Negative control — proves the launch above was the profile's doing"
  cp /etc/apparmor.d/katacomb-vpn /tmp/katacomb-apparmor-backup
  apparmor_parser --remove /etc/apparmor.d/katacomb-vpn && rm -f /etc/apparmor.d/katacomb-vpn
  info "profile removed. Sysctl is now: $(sysctl -n $SYSCTL)"
  cat <<'EOM'

  As your normal user, run  katacomb-vpn  again — it SHOULD NOW FAIL.
  (If it still launches, the profile was not what was allowing it and Task 1
  proved nothing — say so rather than recording a pass.)

  Then press Enter here to restore the profile.
EOM
  read -r _
  cp /tmp/katacomb-apparmor-backup /etc/apparmor.d/katacomb-vpn
  apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/katacomb-vpn
  rm -f /tmp/katacomb-apparmor-backup
  check "[ -f /etc/apparmor.d/katacomb-vpn ]" "profile restored"
  summary "phase2"
  cat <<'EOM'

NEXT — the Task 2 payoff, and it needs a real session boundary:

  1. LOG OUT and LOG BACK IN (group membership only applies to new sessions).
  2. Launch Katacomb VPN, connect to any node.
     PASS = it connects with NO password prompt. That is the whole point of the
            daemon and has never been verified from a GUI-style install.
     FAIL = a polkit dialog appears -> the daemon socket was not reachable and it
            fell back to pkexec. Check:  systemctl status katacomb-vpn-daemon
                                         ls -l /run/katacomb-vpn/daemon.sock
  3. Disconnect. Then:  sudo ./scripts/verify-deb-portability.sh phase3
EOM
}

phase3() {
  need_root
  head_ "Upgrade path (postrm-then-postinst ordering — both scripts changed)"
  apt install -y --reinstall "$DEB" || { echo "reinstall FAILED"; exit 1; }
  check "systemctl is-active --quiet katacomb-vpn-daemon" "daemon still active after reinstall (not orphaned)"
  check "[ -f /etc/apparmor.d/katacomb-vpn ]"             "AppArmor profile re-installed, not left removed"
  check "[ -x /usr/local/bin/katacomb-vpn-helper ]"       "helper still present"
  check "[ -e /usr/bin/katacomb-vpn ]"                    "launcher still present"
  summary "phase3"
  echo
  echo "NEXT:  sudo ./scripts/verify-deb-portability.sh phase4"
}

phase4() {
  need_root
  head_ "Removal"
  apt remove -y katacomb-vpn

  head_ "Nothing left behind"
  check "! ip link show sntl0"                                    "no sntl0 tunnel"
  check "! ip link show sntl-tun"                                 "no sntl-tun"
  check "! ip link show sntl-ovpn"                                "no sntl-ovpn"
  check "! iptables -S | grep -qi KATACOMB_KILLSWITCH"            "no kill-switch chain (iptables)"
  check "! ip6tables -S | grep -qi KATACOMB_KILLSWITCH"           "no kill-switch chain (ip6tables)"
  check "[ ! -e /etc/apparmor.d/katacomb-vpn ]"                   "AppArmor profile gone"
  check "[ ! -e /usr/bin/katacomb-vpn ]"                          "launcher gone"
  check "[ ! -e /usr/local/bin/katacomb-vpn-helper ]"             "helper gone"
  check "[ ! -e /etc/systemd/system/katacomb-vpn-daemon.service ]" "systemd unit gone"
  check "! systemctl is-active --quiet katacomb-vpn-daemon"       "daemon stopped"
  check "[ ! -e /opt/katacomb-vpn ]"                              "/opt symlink gone"

  head_ "CRITICAL — internet still works (a bad teardown strands the machine behind DROP-all)"
  code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com 2>&1)
  if [ "$code" = "200" ]; then ok "HTTPS reachable (example.com -> 200)"; else no "HTTPS returned '$code' — CHECK THE FIREWALL NOW: sudo iptables -S"; fi
  if getent hosts github.com >/dev/null 2>&1; then ok "DNS resolves"; else no "DNS broken — check /etc/resolv.conf"; fi

  summary "phase4"
  echo
  echo "NEXT:  sudo ./scripts/verify-deb-portability.sh revert   (restores the Mint sysctl)"
}

appimage() {
  need_root
  [ -n "$APPIMAGE" ] || { echo "No dist/katacomb-vpn-*.AppImage found — run 'npm run dist' first." >&2; exit 1; }

  head_ "AppImage under stock-Ubuntu AppArmor"
  cat <<EOM
  The AppImage has NO install step, so unlike the deb there is no postinst to
  install /etc/apparmor.d/katacomb-vpn and no chance to make chrome-sandbox SUID
  (the squashfs is mounted nosuid — SUID can never work from inside an AppImage).
  So it has neither of the two things Chromium accepts. This phase asks whether
  it still launches when unprivileged user namespaces are restricted.

  Testing: $APPIMAGE
EOM
  sysctl -w "$SYSCTL=1"
  check "[ ! -e /etc/apparmor.d/katacomb-vpn ]" "no katacomb AppArmor profile present (deb must be uninstalled for a clean read)"

  cat <<'EOM'

  Now launch the AppImage as your normal user:

      ./dist/katacomb-vpn-*.AppImage

  Then check HOW it started — the window opening is not the interesting part:

      ps -eo args | grep -F .mount_kataco | grep -v grep

  KNOWN RESULT (2026-08-02): it launches, but the cmdline reads
  "katacomb-vpn --no-sandbox". electron-builder's AppRun probes
  'unshare -Ur true', fails under this sysctl, and disables Chromium's sandbox
  rather than crashing. At sysctl=0 the flag is absent and the sandbox is on.
  This is documented in the README (prefer the .deb on Ubuntu 24.04+); it is
  upstream behaviour, not ours. Re-run this phase after an electron-builder
  upgrade to see whether the wrapper still behaves this way.

  REGRESSION = no window at all, or a "SUID sandbox helper binary ... is not
  configured correctly" abort. That would mean the AppImage stopped launching
  on stock Ubuntu entirely.

  Press Enter when done — the sysctl is restored to Mint's default either way.
EOM
  read -r _
  sysctl -w "$SYSCTL=0"
  info "sysctl restored to $(sysctl -n $SYSCTL) (Mint default)"
  summary "appimage"
}

revert() {
  need_root
  sysctl -w "$SYSCTL=0"
  echo "Mint default restored. Reinstall the app when you want it back:"
  echo "  sudo apt install $DEB"
}

case "${1:-}" in
  phase1|phase2|phase3|phase4|appimage|revert) "$1" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
