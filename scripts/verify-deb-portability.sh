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
# Or, to do the whole thing from a clean slate (purge -> install -> launch ->
# negative control -> upgrade -> remove -> both AppImage states -> restore):
#     sudo ./scripts/verify-deb-portability.sh fullcycle
# It drives the GUI as $SUDO_USER, so it needs an X11 session plus xdotool and
# wmctrl (checked up front). ONE step needs you: section 7 leaves the AppImage's
# "VPN Helper Setup" dialog up and asks you to click Install and authenticate,
# because that install used to fail silently for every AppImage user (root cannot
# read the FUSE mount — see CLAUDE.md "Packaging") and nothing else exercises it.
# It leaves the deb UNINSTALLED and the sysctl at Mint's default. It cannot cover
# the password-free connect (needs a fresh login + real funds) — that stays manual.
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
if [ -z "$DEB" ] && [ "${1:-}" != "appimage" ] && [ "${1:-}" != "fullcycle" ]; then
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

# The unattended launches drive the desktop with these two. Fail loudly: with
# xdotool absent, dismiss_helper_dialog used to no-op behind its 2>/dev/null and
# the "unattended" run silently waited on a human to click Skip (2026-09-02).
need_gui_tools() {
  local missing=""
  command -v xdotool >/dev/null 2>&1 || missing="$missing xdotool"
  command -v wmctrl  >/dev/null 2>&1 || missing="$missing wmctrl"
  [ -z "$missing" ] || { echo "missing:$missing — apt install$missing" >&2; exit 1; }
}

# ---------------------------------------------------------------------------
# GUI helpers — let a root-run phase drive the desktop as the invoking user, so
# the launch tests don't need a human to alt-tab. X11 only (Type=x11 sessions).
# ---------------------------------------------------------------------------
GUI_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
GUI_HOME="$(getent passwd "$GUI_USER" | cut -d: -f6)"
GUI_DISPLAY="${GUI_DISPLAY:-:0}"

as_user() {
  sudo -u "$GUI_USER" env -u ELECTRON_RUN_AS_NODE \
    DISPLAY="$GUI_DISPLAY" XAUTHORITY="$GUI_HOME/.Xauthority" "$@"
}

# Any window belonging to the app, by WM_CLASS (the main window and the modal
# helper dialog differ only in case, and a bare name search also matches an
# editor tab titled "katacomb-vpn").
app_windows() { as_user wmctrl -lx 2>/dev/null | grep -i ' katacomb-vpn\.katacomb-vpn '; }

# The AppImage has no install step, so on a machine where the deb is not
# installed its first run puts up a MODAL "VPN Helper Setup" dialog
# (dialog.showMessageBoxSync). Until that is answered the main window never
# appears, so the launch check must dismiss it.
#
# It must be closed with WM_DELETE_WINDOW (xdotool windowclose) — verified by
# experiment: 'xdotool key --window ... Escape' uses XSendEvent, which GTK
# ignores, and even a real XTEST Escape after windowactivate does not dismiss
# it. WM_DELETE maps to the dialog's cancelId, i.e. "Skip": no pkexec runs and
# no helper is installed (asserted right after section 6). Section 7 deliberately
# does NOT call this — see launch_and_install_helper.
dismiss_helper_dialog() {
  local winid
  winid="$(as_user xdotool search --name '^VPN Helper Setup$' 2>/dev/null | head -1)"
  [ -n "$winid" ] || return 0
  as_user xdotool windowclose "$winid" 2>/dev/null
  return 0
}

# Launch $1 as the user and wait for the real window.
# Returns 0 if the main window appeared.
launch_and_wait() {
  local cmd="$1" logf="$2" secs="${3:-40}" i
  as_user bash -c "$cmd" >"$logf" 2>&1 &
  for i in $(seq 1 $((secs * 2))); do
    dismiss_helper_dialog
    app_windows | grep -qi 'Katacomb VPN$' && return 0
    sleep 0.5
  done
  return 1
}

# Section 7's launcher: leave the "VPN Helper Setup" dialog UP, ask the human to
# click Install and authenticate, and wait for pkexec to land the helper before
# waiting for the main window (which only appears once the modal is answered).
# This is the ONLY thing that exercises the AppImage's helper install. It used to
# fail silently for every AppImage user: the runtime's FUSE mount has no
# allow_root, so root's `cp` got EACCES and the app's catch{} swallowed it —
# three authenticated clicks, nothing on disk (2026-09-02). The app now stages
# the two files through mkdtemp; this proves that works from a real AppImage.
# Returns 0 if the helper landed AND the main window appeared.
launch_and_install_helper() {
  local cmd="$1" logf="$2" secs="${3:-120}" i
  as_user bash -c "$cmd" >"$logf" 2>&1 &
  for i in $(seq 1 60); do
    app_windows | grep -qi 'VPN Helper Setup' && break
    sleep 0.5
  done
  printf '\n  \033[1m>>> The AppImage is showing "VPN Helper Setup".\n'
  printf '  >>> Click INSTALL and enter your password at the polkit prompt (within %ss).\033[0m\n\n' "$secs"
  for i in $(seq 1 "$secs"); do
    [ -x /usr/local/bin/katacomb-vpn-helper ] && [ -f /usr/share/polkit-1/actions/com.katacomb.vpn.policy ] && break
    sleep 1
  done
  [ -x /usr/local/bin/katacomb-vpn-helper ] || return 1
  for i in $(seq 1 120); do
    app_windows | grep -qi 'Katacomb VPN$' && return 0
    sleep 0.5
  done
  return 1
}

# The AppImage's mount as seen from /tmp's listing only — readdir on /tmp is
# allowed to everyone, entering the mount is not (that is the whole point).
appimage_mount() { local m; m="$(ls -A /tmp 2>/dev/null | grep -m1 '^\.mount_kataco')"; [ -n "$m" ] && echo "/tmp/$m"; }

# Patterns are ANCHORED at the start of the cmdline on purpose. An unanchored
# 'katacomb-vpn' would also match any shell whose command line merely mentions the
# repo path (~/claude-projects/katacomb-vpn) — as root that would kill the user's
# terminal and editor, not just the app.
# [^ ] keeps each alternative inside the FIRST token of the cmdline: '.*' there
# would let '^/' match any shell that merely mentions an AppImage path later on.
# The bare 'katacomb-vpn' alternative matters because a PATH-resolved launch
# (bash -c "katacomb-vpn") gives the main process an argv[0] with NO leading
# slash — miss it and kill_app leaves the app running, which then swallows the
# next launch via requestSingleInstanceLock() and fakes a passing window check.
APP_PATTERN='^(katacomb-vpn( |$)|/opt/Katacomb VPN/katacomb-vpn|/usr/bin/katacomb-vpn|/tmp/\.mount_kataco[^ /]*/katacomb-vpn|/[^ ]*/katacomb-vpn-[0-9][^ ]*\.AppImage)'

# Electron does not exit promptly on SIGTERM (it runs before-quit handlers, and
# an AppImage also has a FUSE mount to release), so escalate and — critically —
# keep waiting after the signal. A fixed 'sleep 1' after SIGKILL was not enough:
# the process was still listed when the next assertion ran, aborting a cycle
# whose app died a moment later.
kill_app() {
  local sig i pids
  for sig in TERM TERM KILL KILL; do
    pids="$(pgrep -u "$GUI_USER" -f "$APP_PATTERN" 2>/dev/null)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill -"$sig" $pids 2>/dev/null
    for i in $(seq 1 10); do
      pgrep -u "$GUI_USER" -f "$APP_PATTERN" >/dev/null 2>&1 || return 0
      sleep 0.5
    done
  done
  return 0
}

# The app takes a single-instance lock, so a surviving instance makes every later
# launch check meaningless (the new process exits and the OLD window answers).
# Abort rather than report results computed against a stale window.
assert_no_app() {
  local i procs wins
  # Poll rather than sample once — a slow exit is not the same as a survivor.
  for i in $(seq 1 20); do
    procs="$(pgrep -u "$GUI_USER" -af "$APP_PATTERN" 2>/dev/null)"
    wins="$(app_windows 2>/dev/null)"
    if [ -z "$procs" ] && [ -z "$wins" ]; then return 0; fi
    sleep 0.5
  done
  if [ -n "$procs" ] || [ -n "$wins" ]; then
    no "app still running after kill_app — results past this point would be bogus, aborting"
    [ -n "$procs" ] && printf '    leftover process: %s\n' "$procs"
    [ -n "$wins" ]  && printf '    leftover window:  %s\n' "$wins"
    summary "fullcycle (aborted)"
    exit 1
  fi
}

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
  # A deb shipping resources/linux/ with NO binaries in it passed every check
  # above (2026-09-02): electron-builder only WARNS on a missing extraResources
  # source. Assert the layout the two resolvers (vpn-manager, daemon-core) read.
  check "[ -x '/opt/Katacomb VPN/resources/linux/bin/tun2socks' ]"  "tun2socks bundled + executable"
  check "[ -x '/opt/Katacomb VPN/resources/linux/bin/awg-quick' ]"  "awg-quick bundled + executable"
  check "[ ! -e '/opt/Katacomb VPN/resources/linux/v2ray' ]"        "obsolete v2ray/ dir absent"
  check "[ ! -e '/opt/Katacomb VPN/resources/linux/packaging' ]"    "packaging/ (fpm input) not shipped"
  check "! grep -q 'linux/v2ray' '/opt/Katacomb VPN/resources/daemon/index.js'" "daemon bundle has no stale path literal"
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

  ALSO: on the "VPN Helper Setup" dialog click INSTALL and authenticate. That
  install failed silently for every AppImage user until 2026-09-02 (root cannot
  read the FUSE mount; the app now stages the files through mkdtemp) and this is
  where it gets checked. Leave the app running until you press Enter.

  Press Enter when done — the sysctl is restored to Mint's default either way.
EOM
  read -r _
  local mnt; mnt="$(appimage_mount)"
  if [ -n "$mnt" ]; then
    check "! cat '$mnt/resources/linux/privileged/katacomb-vpn-helper.sh' >/dev/null 2>&1" "root cannot read the AppImage FUSE mount (no allow_root) — why the helper is staged via mkdtemp"
  else
    info "AppImage not running — FUSE read check skipped"
  fi
  check "[ -x /usr/local/bin/katacomb-vpn-helper ]"                                                          "helper installed by the AppImage's Install click"
  check "[ \"\$(stat -c '%a %U:%G' /usr/local/bin/katacomb-vpn-helper)\" = '755 root:root' ]"                  "helper is 755 root:root"
  check "cmp -s '$REPO_ROOT/resources/linux/privileged/katacomb-vpn-helper.sh' /usr/local/bin/katacomb-vpn-helper" "helper byte-identical to resources/linux/privileged/"
  check "cmp -s '$REPO_ROOT/resources/linux/privileged/com.katacomb.vpn.policy' /usr/share/polkit-1/actions/com.katacomb.vpn.policy" "policy byte-identical to resources/linux/privileged/"
  check "! ls -d /tmp/katacomb-helper-* >/dev/null 2>&1"                                                      "mkdtemp staging dir cleaned up"
  # Self-revert so the deb phases start from the clean slate they assert.
  rm -f /usr/local/bin/katacomb-vpn-helper /usr/share/polkit-1/actions/com.katacomb.vpn.policy
  sysctl -w "$SYSCTL=0"
  info "sysctl restored to $(sysctl -n $SYSCTL) (Mint default); helper + policy removed again"
  summary "appimage"
}

# Everything the deb owns, from a clean slate. Unattended except section 7's one
# Install click (see launch_and_install_helper). The one thing it can NOT cover is
# the password-free connect: that needs a fresh login session for the katacomb-vpn
# group and spends real funds, so it stays a human step (phase2's tail).
fullcycle() {
  need_root
  need_gui_tools
  [ -n "$DEB" ] || { echo "No deb in dist/ — run 'npm run dist' first." >&2; exit 1; }
  [ -n "$APPIMAGE" ] || { echo "No AppImage in dist/ — run 'npm run dist' first." >&2; exit 1; }
  local log=/tmp/katacomb-verify-logs; rm -rf "$log"; mkdir -p "$log"; chmod 755 "$log"

  head_ "0. Clean slate"
  info "GUI will be driven as: $GUI_USER on $GUI_DISPLAY"
  kill_app
  assert_no_app
  apt-get purge -y katacomb-vpn >/dev/null 2>&1
  groupdel katacomb-vpn 2>/dev/null
  rm -f /etc/apparmor.d/katacomb-vpn /usr/local/bin/katacomb-vpn-helper \
        /usr/share/polkit-1/actions/com.katacomb.vpn.policy \
        /etc/systemd/system/katacomb-vpn-daemon.service /opt/katacomb-vpn
  systemctl daemon-reload 2>/dev/null
  # NOTE: deliberately does NOT touch ~/.config/katacomb-vpn — that holds wallets.
  check "! dpkg -l katacomb-vpn 2>/dev/null | grep -qE '^[hi]i'" "package not installed"
  check "[ ! -e /etc/apparmor.d/katacomb-vpn ]"                  "no leftover AppArmor profile"
  check "! getent group katacomb-vpn"                            "no leftover katacomb-vpn group"
  info "wallets at $GUI_HOME/.config/katacomb-vpn left untouched by design"

  head_ "1. Stock-Ubuntu AppArmor + fresh install"
  sysctl -w "$SYSCTL=1" >/dev/null; info "$SYSCTL = $(sysctl -n $SYSCTL)"
  if apt-get install -y "$DEB" >"$log/install.log" 2>&1; then ok "deb installs"; else no "deb install FAILED — see $log/install.log"; tail -20 "$log/install.log"; fi
  check "[ -f /etc/apparmor.d/katacomb-vpn ]"                       "AppArmor profile installed"
  check "apparmor_status 2>/dev/null | grep -q katacomb"            "profile loaded into the kernel"
  check "[ -x /usr/local/bin/katacomb-vpn-helper ]"                 "helper installed"
  check "[ -e /usr/bin/katacomb-vpn ]"                              "launcher installed"
  check "[ -f /usr/share/polkit-1/actions/com.katacomb.vpn.policy ]" "polkit policy installed"
  check "systemctl is-active --quiet katacomb-vpn-daemon"           "daemon active"
  check "systemctl is-enabled --quiet katacomb-vpn-daemon"          "daemon enabled at boot"
  check "[ -L /opt/katacomb-vpn ]"                                  "/opt symlink created"
  check "[ -x '/opt/Katacomb VPN/resources/linux/bin/tun2socks' ]"  "tun2socks bundled + executable"
  check "[ -x '/opt/Katacomb VPN/resources/linux/bin/awg-quick' ]"  "awg-quick bundled + executable"
  check "[ ! -e '/opt/Katacomb VPN/resources/linux/v2ray' ]"        "obsolete v2ray/ dir absent"
  check "[ ! -e '/opt/Katacomb VPN/resources/linux/packaging' ]"    "packaging/ (fpm input) not shipped"
  check "! grep -q 'linux/v2ray' '/opt/Katacomb VPN/resources/daemon/index.js'" "daemon bundle has no stale path literal"
  check "getent group katacomb-vpn | grep -q '$GUI_USER'"           "$GUI_USER added to katacomb-vpn group"
  check "dpkg-deb -I '$DEB' | grep -q 'License: GPL-3.0-or-later'"  "deb declares a real License"

  head_ "2. Deb launches under the restriction (the portability question)"
  if launch_and_wait "/usr/bin/katacomb-vpn" "$log/deb-on.log" 45; then
    ok "deb GUI opens with profile installed"
  else
    no "deb GUI did NOT open — see below"; head -20 "$log/deb-on.log"
  fi
  kill_app
  assert_no_app

  head_ "3. Negative control — remove the profile, same conditions"
  cp /etc/apparmor.d/katacomb-vpn "$log/profile.bak"
  apparmor_parser --remove /etc/apparmor.d/katacomb-vpn >/dev/null 2>&1
  rm -f /etc/apparmor.d/katacomb-vpn
  if launch_and_wait "/usr/bin/katacomb-vpn" "$log/deb-off.log" 20; then
    no "deb GUI still opened WITHOUT the profile — the profile is not what allows it, step 2 proves nothing"
  else
    if grep -qi 'sandbox\|namespace' "$log/deb-off.log"; then
      ok "deb GUI correctly refused without the profile ($(grep -oi 'SUID sandbox helper binary' "$log/deb-off.log" | head -1 || echo 'sandbox error'))"
    else
      no "no window, but not the expected sandbox error — check $log/deb-off.log"; head -10 "$log/deb-off.log"
    fi
  fi
  kill_app
  assert_no_app
  cp "$log/profile.bak" /etc/apparmor.d/katacomb-vpn
  apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/katacomb-vpn >/dev/null 2>&1
  check "[ -f /etc/apparmor.d/katacomb-vpn ]" "profile restored"

  head_ "4. Upgrade path (reinstall over itself)"
  if apt-get install -y --reinstall "$DEB" >"$log/reinstall.log" 2>&1; then ok "reinstall succeeds"; else no "reinstall FAILED"; tail -20 "$log/reinstall.log"; fi
  check "systemctl is-active --quiet katacomb-vpn-daemon" "daemon still active (not orphaned)"
  check "[ -f /etc/apparmor.d/katacomb-vpn ]"             "profile re-installed, not left removed"
  check "[ -x /usr/local/bin/katacomb-vpn-helper ]"       "helper still present"

  head_ "5. Removal + teardown"
  apt-get remove -y katacomb-vpn >"$log/remove.log" 2>&1 || no "remove FAILED"
  check "! ip link show sntl0"                                     "no sntl0 tunnel"
  check "! ip link show sntl-tun"                                  "no sntl-tun"
  check "! ip link show sntl-ovpn"                                 "no sntl-ovpn"
  check "! iptables -S | grep -qi KATACOMB_KILLSWITCH"             "no kill-switch chain (iptables)"
  check "! ip6tables -S | grep -qi KATACOMB_KILLSWITCH"            "no kill-switch chain (ip6tables)"
  check "[ ! -e /etc/apparmor.d/katacomb-vpn ]"                    "AppArmor profile gone"
  check "[ ! -e /usr/bin/katacomb-vpn ]"                           "launcher gone"
  check "[ ! -e /usr/local/bin/katacomb-vpn-helper ]"              "helper gone"
  check "[ ! -e /etc/systemd/system/katacomb-vpn-daemon.service ]" "systemd unit gone"
  check "! systemctl is-active --quiet katacomb-vpn-daemon"        "daemon stopped"
  check "[ ! -e /opt/katacomb-vpn ]"                               "/opt symlink gone"
  local code; code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com 2>&1)
  if [ "$code" = "200" ]; then ok "internet still works after removal (200)"; else no "HTTPS returned '$code' — CHECK: sudo iptables -S"; fi
  if getent hosts github.com >/dev/null 2>&1; then ok "DNS still resolves"; else no "DNS broken"; fi

  head_ "6. AppImage under the restriction (deb now uninstalled)"
  info "$SYSCTL = $(sysctl -n $SYSCTL)"
  if launch_and_wait "'$APPIMAGE'" "$log/appimage-on.log" 60; then
    ok "AppImage GUI opens"
    if pgrep -u "$GUI_USER" -af '\.mount_kataco.*--no-sandbox' >/dev/null 2>&1; then
      info "cmdline: $(pgrep -u "$GUI_USER" -a -f '\.mount_kataco' | head -1 | cut -d' ' -f2-)"
      ok "EXPECTED (known, documented): AppImage ran with --no-sandbox"
    else
      no "AppImage did NOT get --no-sandbox under the restriction — upstream AppRun changed, re-read the README note"
    fi
  else
    no "AppImage GUI did not open at all — regression vs 2026-08-02"; head -20 "$log/appimage-on.log"
  fi
  kill_app
  assert_no_app
  # Proves the helper dialog was cancelled, not accepted: if WM_DELETE had hit
  # "Install" instead of its cancelId, pkexec would have deployed these.
  check "[ ! -e /usr/local/bin/katacomb-vpn-helper ]" "helper dialog auto-dismissed (Skip) — nothing installed"
  check "[ ! -e /usr/share/polkit-1/actions/com.katacomb.vpn.policy ]" "no polkit policy installed by the Skip path"

  head_ "7. AppImage at the Mint default (sandbox back) + the helper install (needs YOUR click)"
  sysctl -w "$SYSCTL=0" >/dev/null; info "$SYSCTL = $(sysctl -n $SYSCTL)"
  check "[ ! -e /usr/local/bin/katacomb-vpn-helper ]" "clean slate before the install test"
  if launch_and_install_helper "'$APPIMAGE'" "$log/appimage-off.log" 120; then
    ok "AppImage GUI opens after Install"
    if pgrep -u "$GUI_USER" -af '\.mount_kataco.*--no-sandbox' >/dev/null 2>&1; then
      no "still --no-sandbox with the restriction OFF — sandbox never engages"
    else
      ok "no --no-sandbox flag: Chromium sandbox active"
    fi
  else
    no "no helper after the Install click — either nothing was clicked within 120s, or pkexec's cp failed (journalctl _COMM=pkexec)"; head -20 "$log/appimage-off.log"
  fi
  # Why the app stages the helper through mkdtemp: root cannot enter the mount.
  # If this ever FAILS the runtime started passing allow_root — re-read the note
  # in CLAUDE.md "Packaging" before touching ensurePolkitSetup.
  local mnt; mnt="$(appimage_mount)"
  if [ -n "$mnt" ]; then
    check "! cat '$mnt/resources/linux/privileged/katacomb-vpn-helper.sh' >/dev/null 2>&1" "root cannot read the AppImage FUSE mount (no allow_root) — why the helper is staged via mkdtemp"
  else
    no "AppImage mount not found under /tmp while the app was running"
  fi
  check "[ -x /usr/local/bin/katacomb-vpn-helper ]"                                                          "helper installed by the AppImage"
  check "[ \"\$(stat -c '%a %U:%G' /usr/local/bin/katacomb-vpn-helper)\" = '755 root:root' ]"                  "helper is 755 root:root"
  check "cmp -s '$REPO_ROOT/resources/linux/privileged/katacomb-vpn-helper.sh' /usr/local/bin/katacomb-vpn-helper" "helper byte-identical to resources/linux/privileged/"
  check "[ -f /usr/share/polkit-1/actions/com.katacomb.vpn.policy ]"                                         "polkit policy installed by the AppImage"
  check "[ \"\$(stat -c '%a %U:%G' /usr/share/polkit-1/actions/com.katacomb.vpn.policy)\" = '644 root:root' ]" "policy is 644 root:root"
  check "cmp -s '$REPO_ROOT/resources/linux/privileged/com.katacomb.vpn.policy' /usr/share/polkit-1/actions/com.katacomb.vpn.policy" "policy byte-identical to resources/linux/privileged/"
  check "! ls -d /tmp/katacomb-helper-* >/dev/null 2>&1"                                                      "mkdtemp staging dir cleaned up"
  kill_app
  assert_no_app
  # Self-revert: the deb phases and section 8 assert a clean slate.
  rm -f /usr/local/bin/katacomb-vpn-helper /usr/share/polkit-1/actions/com.katacomb.vpn.policy

  head_ "8. Restore"
  sysctl -w "$SYSCTL=0" >/dev/null
  check "[ \"$(sysctl -n $SYSCTL)\" = 0 ]" "sysctl back to Mint default"
  check "[ ! -e /usr/local/bin/katacomb-vpn-helper ]" "install test reverted — no helper left behind"
  check "[ ! -e /usr/share/polkit-1/actions/com.katacomb.vpn.policy ]" "no polkit policy left behind"
  info "logs kept in $log"

  summary "fullcycle"
  cat <<EOM

NOT covered here (needs a human, by nature):
  password-free connect. Reinstall, LOG OUT and LOG BACK IN (for the
  katacomb-vpn group), then connect to a node and confirm no password prompt:
      sudo apt install $DEB
EOM
}

revert() {
  need_root
  sysctl -w "$SYSCTL=0"
  echo "Mint default restored. Reinstall the app when you want it back:"
  echo "  sudo apt install $DEB"
}

case "${1:-}" in
  phase1|phase2|phase3|phase4|appimage|fullcycle|revert) "$1" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
