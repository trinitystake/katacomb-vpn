#!/usr/bin/env bash
# Katacomb VPN — the whole release, one command.
#
#     ./scripts/ship.sh 1.4.0 --dry-run   # say what would happen, do nothing
#     ./scripts/ship.sh 1.4.0
#
# Runs the release end to end: notes, cut, install, test, publish. Run it again
# whenever it stops. It works out where you are every time, so re-running after a
# logout, a failure, or a coffee break always continues from the right place.
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
MODE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --single)   MODE='single' ;;
    --split)    MODE='split' ;;
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

# --- 1. notes ---------------------------------------------------------------
phase 1/6 "release notes"
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

# --- 2. cut -----------------------------------------------------------------
phase 2/6 "cut the release"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  skip "$TAG already cut"
else
  info "building and signing, this takes a few minutes"
  run_phase "cutting the release" "$SCRIPT_DIR/release.sh" "$VERSION"
fi

# --- 3. portability ---------------------------------------------------------
# Same rule release.sh applies, asked here so the plan can mention it before the
# mode question rather than after.
phase 3/6 "packaging verification"
# Measured against the tag once it exists, and against HEAD before it does. Without
# the fallback a rehearsal (where phase 2 never really runs) has no previous tag to
# compare with, so it reports every release as a packaging change and asks a question
# it did not need to ask.
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
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

# --- 4. install -------------------------------------------------------------
phase 4/6 "install this build"
INSTALLED="$(dpkg-query -W -f='${Version}' "$DEB_PACKAGE" 2>/dev/null || true)"
if [ "$INSTALLED" = "$VERSION" ]; then
  skip "$DEB_PACKAGE $VERSION already installed"
  INSTALL_DONE=1
else
  INSTALL_DONE=0
  [ -f "dist/$DEB_NAME" ] || die "dist/$DEB_NAME is missing, so there is nothing to install.
        Re-cut: ./scripts/release.sh $VERSION"
  info "installed: ${INSTALLED:-none}, want: $VERSION"

  # The mode question, asked once and only where it changes anything: right before
  # the install that invalidates a pre-existing login.
  if [ -z "$MODE" ]; then
    cat <<EOF

  How do you want to finish?

    1) one pass    install, test in the app, publish, without logging out
    2) split       install, then log out and back in, then run this again
EOF
    if [ "$PACKAGING_CHANGED" = 1 ]; then
      cat <<EOF

  Worth knowing for this release: packaging changed, so the portability run
  removed the katacomb-vpn group and the reinstall recreated it. Your current
  login still carries the OLD membership, so the app cannot reach the daemon
  and will fall back to asking for a password. In one-pass mode that shows up
  as a password prompt during the test below, which is a "no" answer.
EOF
    fi
    if [ "$DRY_RUN" = 1 ]; then
      info "would ask: one pass or split"
      MODE='single'
    else
      printf '\n  Choose [1/2]: '
      read -r reply
      case "$reply" in
        1) MODE='single' ;;
        2) MODE='split' ;;
        *) die "expected 1 or 2, got '$reply'" ;;
      esac
    fi
  fi

  info "running: sudo apt install ./dist/$DEB_NAME"
  run_phase "installing the deb" sudo apt install -y "./dist/$DEB_NAME"
  [ "$DRY_RUN" = 1 ] || ok "installed $VERSION"
fi

# --- 5. group + the test ----------------------------------------------------
phase 5/6 "confirm the build works"

# Only meaningful in split mode: it is the whole point of logging out, and in
# one-pass mode the user has explicitly chosen to skip it. A stale group is not
# silently fine either way, which is why the test below is not optional.
if [ "$MODE" = split ] && [ "$INSTALL_DONE" = 0 ]; then
  cat <<EOF

  Installed. Now log out and back in, so your session picks up the
  katacomb-vpn group, then run this again:

      ./scripts/ship.sh $VERSION

EOF
  exit 0
fi

if id -nG | tr ' ' '\n' | grep -qx "$DEB_PACKAGE"; then
  ok "in the $DEB_PACKAGE group"
elif [ "$MODE" = single ]; then
  info "not in the $DEB_PACKAGE group in this session; connect may ask for a password"
else
  info "not in the $DEB_PACKAGE group yet. If connect asks for a password, log out
        and back in, then run this again."
fi

cat <<EOF

  In the app now: connect, then disconnect.
  Neither should ask for a password.

EOF
if [ "$DRY_RUN" = 1 ]; then
  info "would ask whether connect and disconnect both worked"
else
  printf '  Did both work? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ok "build confirmed working" ;;
    *) die "stopping before publish, which is the right outcome for a build that did
        not pass. Nothing has been published. When it is fixed, run this again." ;;
  esac
fi

# --- 6. publish -------------------------------------------------------------
phase 6/6 "publish"
if [ "$DRY_RUN" = 1 ]; then
  # Actually run it, rather than printing that we would: publish-release.sh's own
  # --dry-run is read-only and is the single most useful thing a rehearsal can
  # show, since it verifies the checksums and the signature for real.
  printf '  (running publish-release.sh --dry-run)\n'
  "$SCRIPT_DIR/publish-release.sh" "$VERSION" --dry-run ||
    die "the publish preflight would fail (above)"
else
  run_phase "publishing" "$SCRIPT_DIR/publish-release.sh" "$VERSION"
fi

if [ "$DRY_RUN" = 1 ]; then
  printf '\n%sDry run finished.%s Nothing was changed, built or published.\n' "$bold" "$reset"
else
  printf '\n%s%s is out.%s\n' "$bold" "$TAG" "$reset"
fi
