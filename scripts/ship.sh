#!/usr/bin/env bash
# Katacomb VPN — the whole release, one command.
#
#     ./scripts/ship.sh 1.4.0 --dry-run   # say what would happen, do nothing
#     ./scripts/ship.sh 1.4.0
#
# Runs the release end to end: notes, cut, install, test, publish. Run it again
# whenever it stops. It works out where you are every time, so re-running after a
# reboot, a failure, or a coffee break always continues from the right place.
#
# It orchestrates the other three scripts and does nothing itself. If something
# here disagrees with release.sh, release.sh is right.
# ---------------------------------------------------------------------------
#
# WHY THERE IS NO STATE FILE.
#
# Every phase boundary is a question reality already answers: is the notes title
# this version, does the tag exist, is this version the installed one, is the
# group in `id -nG`, does the GitHub release exist. So position is DERIVED on
# each run, never remembered.
#
# That is not a style preference. A state file and the world disagree eventually
# — you abort a cut by hand, or a publish half succeeds — and then the file is
# confidently wrong about the one thing it exists to know. Derivation cannot
# drift, and it makes "run it again" the answer to every failure, which is the
# only instruction worth giving someone whose release just stopped.
#
# The same rule decides whether a reboot is needed before the test. The session
# either has the katacomb-vpn group or it does not, and only one that has it can
# reach the daemon, so the script looks (`id -nG`) and stops for a reboot when it
# must. There used to be a "one pass or split" question here that asked the user
# to predict that answer: the one phase boundary remembered rather than derived.
#
# WHAT IS DELIBERATELY NOT AUTOMATED.
#
# The connect/disconnect test. It is the one phase nothing can derive, and the
# only check that the thing about to be published actually runs. No flag skips
# it. Everything around it is automated precisely so that it is the only thing
# left to think about.
#
# The portability run, when packaging changed. It is interactive, needs root,
# ends with the package UNINSTALLED and wants a reboot after. A wrapper cannot
# carry anyone through that, so it prints the command and stops.
# ---------------------------------------------------------------------------
set -euo pipefail

RELEASE_BRANCH=main
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NOTES=RELEASE_NOTES.md
DEB_PACKAGE=katacomb-vpn

bold=$(tput bold 2>/dev/null || true); red=$(tput setaf 1 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true); dim=$(tput setaf 8 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)

phase() { printf '\n%s[%s] %s%s\n' "$bold" "$1" "$2" "$reset"; }
ok()    { printf '  %sok%s    %s\n' "$green" "$reset" "$*"; }
info()  { printf '  ....  %s\n' "$*"; }
skip()  { printf '  %s--    %s%s\n' "$dim" "$*" "$reset"; }
die()   { printf '  %sSTOP%s  %s\n' "$red" "$reset" "$*" >&2; exit 1; }

# Prints the header down to the ruled line. It is a line count, so it truncates
# silently if the block grows: check `--help` OUTPUT after editing, not the file.
usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

VERSION=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    -h|--help)  usage; exit 0 ;;
    -*)         die "unknown option: $arg" ;;
    *)          [ -z "$VERSION" ] || die "version given twice: $VERSION and $arg"
                VERSION="$arg" ;;
  esac
done
[ -n "$VERSION" ] || { usage; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 1.0.0, got: $VERSION"

TAG="v$VERSION"
DEB_NAME="katacomb-vpn_${VERSION}_amd64.deb"

cd "$REPO_ROOT"

# Where dpkg records what it installed. A variable so the check below can be
# exercised against a fixture instead of the live system.
DPKG_INFO_DIR="${DPKG_INFO_DIR:-/var/lib/dpkg/info}"

# Is the .deb in dist/ the build that is currently installed?
#
# Version alone cannot answer this, and the gap is reachable: release.sh --abort
# deletes a tag, so the same version can be cut twice with different bytes in
# between (cut, install, test fails, abort, fix, re-cut). dpkg would still report
# 1.4.0 installed, this phase would skip, and the build that got tested would not
# be the build that got published. `apt install` would not save it either: same
# version, so apt does nothing without --reinstall.
#
# dpkg records an md5 per installed file, and the same file is extractable from the
# .deb, so the question is answerable from the system rather than remembered.
#
#   0  this exact build is installed
#   1  something else is installed
#   2  cannot tell
installed_build_matches_deb() {
  local deb=$1 sums="$DPKG_INFO_DIR/$DEB_PACKAGE.md5sums"
  [ -r "$sums" ] || return 2

  # Lines are "<md5><two spaces><path>", and the path contains a space
  # ("opt/Katacomb VPN/katacomb-vpn"), so split on the double space. Splitting on
  # whitespace truncates it to "opt/Katacomb", the extraction below then silently
  # finds nothing, and md5sum happily hashes the empty stream - which is why the
  # empty-input hash is rejected explicitly rather than trusted as a mismatch.
  local line recorded file from_deb
  line="$(grep -m1 "/$DEB_PACKAGE\$" "$sums" 2>/dev/null || true)"
  [ -n "$line" ] || return 2
  recorded="${line%% *}"
  file="${line#*  }"

  from_deb="$(dpkg-deb --fsys-tarfile "$deb" 2>/dev/null | tar -xO "./$file" 2>/dev/null | md5sum | cut -d' ' -f1 || true)"
  [ -n "$from_deb" ] || return 2
  [ "$from_deb" != d41d8cd98f00b204e9800998ecf8427e ] || return 2   # md5 of nothing: extraction failed
  [ "$recorded" != "$from_deb" ] || return 0
  return 1
}

# Every phase shells out to the script that owns it. Failure carries the phase
# name, because "run it again" is only useful advice if you know what to fix first.
run_phase() {
  local what=$1; shift
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would run: %s\n' "$*"
    return 0
  fi
  "$@" || die "$what failed (above). Fix it, then run this again:
            ./scripts/ship.sh $VERSION"
}

printf '%sKatacomb VPN ship %s%s%s\n' "$bold" "$TAG" "$reset" \
  "$([ "$DRY_RUN" = 1 ] && echo '   (dry run, nothing is done)')"

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO_ROOT"
BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "$RELEASE_BRANCH" ] || die "on branch '$BRANCH', releases are cut from '$RELEASE_BRANCH'"

# --- 1. credentials ---------------------------------------------------------
# Every password this run will ever need, taken here, so no later phase stops to
# ask. There are three, and they are different things:
#   ssh   signs every commit and tag (gpg.format=ssh) and authenticates every
#         push and ls-remote: seven key operations per full run. A live agent
#         holding the key answers all seven silently; without one, each prompts.
#   sudo  the apt install in the install phase.
#   gpg   the SHA256SUMS signature (release.sh step 7). NOT primed here on
#         purpose: gpg-agent's cache is 10 minutes and the build alone can outrun
#         it, so pinentry at the signing step is the one honest place for it.
phase 1/7 "credentials"

# Find a live agent socket. The session's $SSH_AUTH_SOCK can point at a dead
# socket (gnome-keyring's, after the agent component moved to gcr), and ssh then
# silently falls back to reading the key file, which is what makes every single
# operation ask for the passphrase. Exported here, so all three sub-scripts
# inherit the working socket. Exit 1 from ssh-add is a live agent with no keys
# loaded yet, which the ssh-add below fixes; only 2 (cannot connect) disqualifies.
ensure_ssh_agent() {
  local candidate rc
  for candidate in "${SSH_AUTH_SOCK:-}" \
                   "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gcr/ssh" \
                   "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/keyring/ssh"; do
    [ -S "$candidate" ] || continue
    SSH_AUTH_SOCK="$candidate" ssh-add -l >/dev/null 2>&1
    rc=$?
    if [ "$rc" -le 1 ]; then
      export SSH_AUTH_SOCK="$candidate"
      return 0
    fi
  done
  return 1
}

if ensure_ssh_agent; then
  SIGNING_PUB="$(git config user.signingkey 2>/dev/null || true)"
  SIGNING_FPR=""
  [ -f "$SIGNING_PUB" ] && SIGNING_FPR="$(ssh-keygen -lf "$SIGNING_PUB" 2>/dev/null | awk '{print $2}')"
  if [ -n "$SIGNING_FPR" ] && ssh-add -l 2>/dev/null | grep -qF "$SIGNING_FPR"; then
    ok "ssh agent holds the signing key ($SSH_AUTH_SOCK)"
  elif [ -f "$SIGNING_PUB" ]; then
    info "the signing key is not in the agent. Adding it: one passphrase now instead
        of one per commit, tag and push"
    ssh-add "${SIGNING_PUB%.pub}" || die "could not add ${SIGNING_PUB%.pub} to the agent"
    ok "signing key added to the agent"
  else
    # No ssh signing key configured: pushes still ride the agent, nothing to preload.
    ok "ssh agent live ($SSH_AUTH_SOCK)"
  fi
else
  info "no usable ssh agent found. Carrying on, but every signed commit, signed tag
        and push will ask for the key passphrase individually"
fi

# Checked by publish-release.sh too, but that is the last phase, after the human
# connect test: discovering an unauthenticated gh there wastes the whole run.
command -v gh >/dev/null 2>&1 || die "gh CLI not installed, and the publish phase needs it. Install gh first."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"
ok "gh authenticated"

if [ "$DRY_RUN" = 1 ]; then
  skip "sudo not taken in a dry run"
else
  info "sudo now, so the install phase does not stop to ask later"
  sudo -v || die "sudo is required for the install phase"
  # Refresh the timestamp for as long as this script lives: the notes edit and
  # the build can both outlast sudo's 15-minute cache. The loop dies with the
  # script (kill -0 on the parent) and the trap covers the normal exit.
  ( while sleep 60; do
      kill -0 "$$" 2>/dev/null || exit
      sudo -n -v 2>/dev/null || exit
    done ) &
  SUDO_KEEPALIVE=$!
  trap 'kill "$SUDO_KEEPALIVE" 2>/dev/null' EXIT
  ok "sudo cached and kept warm for the whole run"
fi

# --- 2. notes ---------------------------------------------------------------
phase 2/7 "release notes"
NOTES_READY=0
if [ -f "$NOTES" ] && [ "$(head -1 "$NOTES")" = "# Katacomb VPN $VERSION" ] &&
   [ -z "$(git status --porcelain --untracked-files=no -- "$NOTES")" ] &&
   ! grep -q 'TODO:' "$NOTES"; then
  NOTES_READY=1
fi
if [ "$NOTES_READY" = 1 ]; then
  skip "$NOTES already written and committed for $VERSION"
else
  info "opening $NOTES for $VERSION"
  run_phase "writing the release notes" "$SCRIPT_DIR/draft-release-notes.sh" "$VERSION" --edit
fi

# --- 3. cut -----------------------------------------------------------------
phase 3/7 "cut the release"
CUT_DONE=0
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && CUT_DONE=1
if [ "$CUT_DONE" = 1 ]; then
  skip "$TAG already cut"
elif [ "$DRY_RUN" = 1 ]; then
  if [ "$NOTES_READY" = 1 ]; then
    # Run it, rather than print that we would: release.sh's own --dry-run builds
    # nothing and its preflight is real (branch, tree, tag, node, gpg key, the
    # notes tripwires), which is what a rehearsal is for. The same call phase 7
    # makes for the publish preflight.
    printf '  (running release.sh --dry-run)\n'
    "$SCRIPT_DIR/release.sh" "$VERSION" --dry-run ||
      die "the cut preflight would fail (above)"
  else
    # That preflight stops on notes that are not written yet, and phase 2 has just
    # said they would be written, so there is nothing to rehearse until they are.
    printf '  would run: %s\n' "$SCRIPT_DIR/release.sh $VERSION"
    info "its preflight is not rehearsed until the notes are written"
  fi
else
  info "building and signing, this takes a few minutes"
  run_phase "cutting the release" "$SCRIPT_DIR/release.sh" "$VERSION"
fi

# --- 4. portability ---------------------------------------------------------
# Same rule release.sh applies, asked here so the plan can mention it before the
# mode question rather than after.
phase 4/7 "packaging verification"
# Measured against the tag once it exists, and against HEAD before it does. Without
# the fallback a rehearsal (where phase 2 never really runs) has no previous tag to
# compare with, so it reports every release as a packaging change and asks a question
# it did not need to ask.
if [ "$CUT_DONE" = 1 ]; then
  RANGE_END="$TAG"
  PREV_TAG="$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)"
else
  RANGE_END=HEAD
  PREV_TAG="$(git describe --tags --abbrev=0 HEAD 2>/dev/null || true)"
fi
PACKAGING_CHANGED=0
if [ -z "$PREV_TAG" ]; then
  PACKAGING_CHANGED=1
elif [ -n "$(git diff --name-only "$PREV_TAG".."$RANGE_END" -- electron-builder.yml resources/linux/ 2>/dev/null)" ]; then
  PACKAGING_CHANGED=1
fi
if [ "$PACKAGING_CHANGED" = 0 ]; then
  skip "packaging unchanged since ${PREV_TAG:-the last release}, not required"
else
  info "packaging changed since ${PREV_TAG:-the last release}"
  cat <<EOF

  This one is yours: it needs root, it pauses for you to drive the GUI, it ends
  with the package UNINSTALLED, and it wants a reboot after. Run it, then run
  this again:

      sudo ./scripts/verify-deb-portability.sh fullcycle

  If you have already done it for $TAG, just carry on: answer y below.

EOF
  if [ "$DRY_RUN" = 1 ]; then
    info "would ask whether the portability run is already done"
  else
    printf '  Already done for %s? [y/N] ' "$TAG"
    read -r reply
    case "$reply" in
      y|Y|yes|YES) ok "taking the portability run as done" ;;
      *) die "stopping so you can run it. Then: ./scripts/ship.sh $VERSION" ;;
    esac
  fi
fi

# A rehearsal can only go as far as the cut. Install, test and publish all need
# what it produces (the deb, the tag, the version bump), so before the cut there
# is nothing further a dry run can check, only phases it would describe, and the
# first thing it would run into is the missing-deb STOP that phase 5 keeps for a
# real run, with advice ("re-cut") that is wrong here. After the cut a dry run
# carries on: phase 7 runs the publish preflight for real, which is worth having.
if [ "$DRY_RUN" = 1 ] && [ "$CUT_DONE" = 0 ]; then
  cat <<EOF

${bold}Dry run finished.${reset} Nothing was changed, built or published.
  Install, test and publish (5 to 7) all need the build and the tag the cut
  produces, so a rehearsal stops here. To do it for real:

      ./scripts/ship.sh $VERSION

EOF
  exit 0
fi

# --- 5. install -------------------------------------------------------------
phase 5/7 "install this build"
INSTALLED="$(dpkg-query -W -f='${Version}' "$DEB_PACKAGE" 2>/dev/null || true)"
NEED_INSTALL=1
REINSTALL=0
INSTALL_REASON="installed: ${INSTALLED:-none}, want: $VERSION"
if [ "$INSTALLED" = "$VERSION" ]; then
  # Right version. Right BUILD is a separate question, and the one that matters.
  if [ -f "dist/$DEB_NAME" ]; then
    set +e
    installed_build_matches_deb "dist/$DEB_NAME"
    MATCH=$?
    set -e
  else
    MATCH=2
  fi
  case "$MATCH" in
    0) NEED_INSTALL=0 ;;
    1) REINSTALL=1
       INSTALL_REASON="$VERSION is installed, but not this build of it: dist/$DEB_NAME
        differs from what is on the system, so it will be reinstalled" ;;
    *) REINSTALL=1
       INSTALL_REASON="$VERSION is installed but the build could not be identified,
        so it will be reinstalled rather than assumed" ;;
  esac
fi

if [ "$NEED_INSTALL" = 0 ]; then
  skip "$DEB_PACKAGE $VERSION already installed, and it is this build"
else
  [ -f "dist/$DEB_NAME" ] || die "dist/$DEB_NAME is missing, so there is nothing to install.
        Re-cut: ./scripts/release.sh $VERSION"
  info "$INSTALL_REASON"

  # --reinstall only when the version is unchanged: apt does nothing at all for an
  # equal version otherwise, which is exactly how the wrong build gets tested.
  APT_ARGS=(install -y)
  [ "$REINSTALL" = 1 ] && APT_ARGS+=(--reinstall)
  info "running: sudo apt ${APT_ARGS[*]} ./dist/$DEB_NAME"
  run_phase "installing the deb" sudo apt "${APT_ARGS[@]}" "./dist/$DEB_NAME"
  [ "$DRY_RUN" = 1 ] || ok "installed $VERSION"
fi

# --- 6. group + the test ----------------------------------------------------
phase 6/7 "confirm the build works"

# The group is the test's one precondition: without it the app cannot open the
# daemon socket, falls back to pkexec, and connect asks for a password, so the
# question below could only be answered "no". A session lacks it after the first
# install on a machine, and after the portability run (its postrm deletes the
# group, the reinstall recreates it, and a login from before that carries the
# old membership). `id -nG` names the session's GIDs against the current
# /etc/group and the kernel checks the socket by GID, so a name that still
# resolves is a membership that still works, and one that does not is not.
# A reboot rather than a logout: release.sh explains how a logout can silently
# fail to start a new session and look identical to one that worked.
if id -nG | tr ' ' '\n' | grep -qx "$DEB_PACKAGE"; then
  ok "in the $DEB_PACKAGE group"
elif [ "$DRY_RUN" = 1 ]; then
  info "would stop here: this login lacks the $DEB_PACKAGE group, so a real run asks
        for a reboot at this point and continues when run again"
else
  cat <<EOF
  ....  this login does not have the $DEB_PACKAGE group, so the app cannot reach the
        daemon and connect would ask for a password. Reboot, not a logout, then run
        this again:

      ./scripts/ship.sh $VERSION
EOF
  [ "$PACKAGING_CHANGED" = 0 ] || cat <<EOF

        Expected for this release: packaging changed, so the portability run deleted
        the group and the reinstall recreated it. A login from before that carries
        the old membership.
EOF
  echo
  exit 0
fi

cat <<EOF

  In the app now: connect, then disconnect.
  Neither should ask for a password.

EOF
if [ "$DRY_RUN" = 1 ]; then
  info "would ask whether connect and disconnect both worked"
else
  # This answer is the publish decision: phase 7 passes --yes, so nothing asks again.
  printf '  Did both work? Answering y publishes %s to GitHub. [y/N] ' "$TAG"
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ok "build confirmed working" ;;
    *) die "stopping before publish, which is the right outcome for a build that did
        not pass. Nothing has been published. When it is fixed, run this again." ;;
  esac
fi

# --- 7. publish -------------------------------------------------------------
phase 7/7 "publish"
if [ "$DRY_RUN" = 1 ]; then
  # Actually run it, rather than printing that we would: publish-release.sh's own
  # --dry-run is read-only and is the single most useful thing a rehearsal can
  # show, since it verifies the checksums and the signature for real.
  printf '  (running publish-release.sh --dry-run)\n'
  "$SCRIPT_DIR/publish-release.sh" "$VERSION" --dry-run ||
    die "the publish preflight would fail (above)"
else
  # --yes: the "cannot be undone, continue?" that script asks when run on its own
  # was answered by the test question seconds ago, and the run took every other
  # prompt up front for the same reason. Its preflight still runs, and still
  # stops on any failure.
  run_phase "publishing" "$SCRIPT_DIR/publish-release.sh" "$VERSION" --yes
fi

if [ "$DRY_RUN" = 1 ]; then
  printf '\n%sDry run finished.%s Nothing was changed, built or published.\n' "$bold" "$reset"
else
  printf '\n%s%s is out.%s\n' "$bold" "$TAG" "$reset"
fi
