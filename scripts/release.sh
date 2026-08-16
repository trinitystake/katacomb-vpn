#!/usr/bin/env bash
# Katacomb VPN — cut a signed release: version bump, build, checksums, GPG
# signature, commit, tag. Not part of the build; run it by hand from the repo root.
#
#     ./scripts/release.sh 1.0.0 --dry-run   # print the plan, change nothing
#     ./scripts/release.sh 1.0.0             # do it
#
# It stops before anything leaves this machine: it never pushes and never creates
# a GitHub release. The last thing it prints is the exact commands for those.
#
# Produces in dist/, which it WIPES first (along with out/) so that what is left
# afterwards is exactly this build:
#     katacomb-vpn_<version>_amd64.deb
#     katacomb-vpn-<version>.AppImage
#     SHA256SUMS       checksums of exactly those two files
#     SHA256SUMS.asc   detached armored signature over SHA256SUMS
#
# The version bump is committed and tagged only if every earlier step passed; if
# a later one fails the bump is rolled back, so a re-run starts from a clean tree.
#
# ---------------------------------------------------------------------------
# THE WHOLE RELEASE, of which this script is only step 1. The order is not
# cosmetic — every one of these was learned by getting it wrong on 1.0.0.
#
#   0. notes      Rewrite RELEASE_NOTES.md. Preflight refuses a heading naming
#                 another version, but it cannot tell you the BODY is stale.
#                 You do NOT have to work out whether step 2 applies: preflight
#                 diffs electron-builder.yml and resources/linux/ against the last
#                 tag and says so, and the closing output prints the steps that
#                 follow from its answer.
#
#   1. cut        ./scripts/release.sh <version> --dry-run     (preflight is real)
#                 ./scripts/release.sh <version>
#
#   2. packaging  sudo ./scripts/verify-deb-portability.sh fullcycle
#                 ONLY when step 0 found packaging changes. Must run AFTER the
#                 cut: it picks its deb by mtime, so run first it tests the
#                 PREVIOUS release (or dies, if dist/ is empty). It ends with the
#                 package UNINSTALLED, which is why step 3 exists.
#
#   3. install    sudo apt install ./dist/katacomb-vpn_<version>_amd64.deb
#
#   4. reboot     NOT a logout. postrm runs `groupdel katacomb-vpn`, so step 2
#                 destroyed the group and step 3 recreated it: any login you did
#                 earlier is stale. A logout that silently fails to start a new
#                 session looks identical to one that worked — check with
#                 `loginctl show-session <id> -p Timestamp` against
#                 `stat -c %y /etc/group` if you skip the reboot anyway.
#
#   5. precondition   id -nG | grep katacomb
#                 Must print the group BEFORE you read anything into step 6.
#
#   6. test       Connect, then disconnect. Neither should prompt for a password.
#                 "No prompt" only means the daemon worked if step 5 passed AND a
#                 privileged call actually ran: the app adopts a tunnel that is
#                 already up and asks root for nothing, which looks the same.
#                 If this release touched connect/disconnect, also test on the
#                 pkexec path (before step 4, while you still lack the group) —
#                 the polkit dialog holds the tunnel half-built for as long as you
#                 leave it open, which is the only comfortable way to watch that
#                 window.
#
#   7. publish    git push origin main && git push origin v<version>
#                 gh release create v<version> --notes-file RELEASE_NOTES.md \
#                     dist/katacomb-vpn_<version>_amd64.deb \
#                     dist/katacomb-vpn-<version>.AppImage \
#                     dist/SHA256SUMS dist/SHA256SUMS.asc
#                 The tag has to land before the release, or GitHub cannot attach
#                 the assets to it.
#
# Nothing is public until step 7, so anything that fails before it unwinds with:
#     git tag -d v<version> && git reset --hard HEAD~1   # release commit is HEAD
#     git rebase --onto <before-release> <release-commit>  # if work sits on top
# ---------------------------------------------------------------------------

set -euo pipefail

# The maintainer's release key. A key id is public by construction (it is in every
# signature this produces), so it belongs in the repo: it is what a downloader
# checks the .asc against. Rotate here if the key ever changes.
SIGNING_KEY=7315246A6E67F3C6
RELEASE_BRANCH=main
MIN_NODE_MAJOR=22                 # `npm test` needs native TS type stripping
TOTAL=9

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

step() { printf '\n\033[1m[%d/%d] %s\033[0m\n' "$1" "$TOTAL" "$2"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
info() { printf '  ....  %s\n' "$1"; }
die()  { printf '  \033[31mSTOP\033[0m  %s\n' "$1" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# --- arguments --------------------------------------------------------------
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
NOTES=RELEASE_NOTES.md
DEB_NAME="katacomb-vpn_${VERSION}_amd64.deb"
APPIMAGE_NAME="katacomb-vpn-${VERSION}.AppImage"

cd "$REPO_ROOT"

# nvm's shell hook is broken in non-interactive shells (`_load_nvm: command not
# found`), so the `node`/`npm` on PATH are stubs that cannot run. Find a real one.
resolve_node() {
  if node -v >/dev/null 2>&1; then return 0; fi
  local dir v major best=""
  for dir in $(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V); do
    [ -x "$dir/node" ] || continue
    v="$("$dir/node" -v 2>/dev/null)" || continue
    major="${v#v}"; major="${major%%.*}"
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then best="$dir"; fi
  done
  [ -n "$best" ] || return 1
  PATH="$best:$PATH"
}

# Roll the bump back on failure so the tree is clean for a re-run. Once the
# commit lands there is nothing to roll back, and the tag is the last step.
BUMPED=0
COMMITTED=0
cleanup() {
  local code=$?
  if [ "$code" -eq 0 ]; then return; fi
  if [ "$BUMPED" = 1 ] && [ "$COMMITTED" = 0 ]; then
    git checkout -- package.json package-lock.json 2>/dev/null || true
    printf '  ....  rolled the version bump back, working tree is clean again\n'
  fi
}
trap cleanup EXIT

printf '\033[1mKatacomb VPN release %s\033[0m%s\n' "$VERSION" \
  "$([ "$DRY_RUN" = 1 ] && echo '   (dry run, nothing is written)')"

# --- 1. preflight -----------------------------------------------------------
# Every check here is read-only, so it runs for real in a dry run too. That is
# the half of a dry run worth having: it tells you whether the real run would go.
step 1 "preflight"

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO_ROOT"

BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "$RELEASE_BRANCH" ] || die "on branch '$BRANCH', releases are cut from '$RELEASE_BRANCH'"
ok "on $RELEASE_BRANCH"

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes, commit or stash them first"
ok "working tree clean"

! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag $TAG already exists"
ok "tag $TAG is free"

CURRENT="$(node -p "require('./package.json').version" 2>/dev/null || sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json | head -1)"
[ "$CURRENT" != "$VERSION" ] || die "package.json is already at $VERSION"
ok "version $CURRENT -> $VERSION"

resolve_node || die "no node >= $MIN_NODE_MAJOR found (looked on PATH and in ~/.nvm/versions/node)"
ok "node $(node -v) at $(command -v node)"

gpg --list-secret-keys "$SIGNING_KEY" >/dev/null 2>&1 || die "no secret key $SIGNING_KEY in the keyring, import it with: gpg --import private.asc"
ok "signing key $SIGNING_KEY present"

# Does this release need the packaging verification? The rule (CLAUDE.md) is
# "after touching electron-builder.yml, either maintainer script, or the systemd
# unit", and resources/linux/ holds the latter three. Decided here rather than
# left to memory, because the cost of forgetting is the whole reason that script
# exists: the AppArmor defect shipped while the config read perfectly, and only
# installing and launching the package could have caught it. Informational, not a
# refusal - the run itself needs root, a GUI, and the build this is about to make.
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
PACKAGING_CHANGED=0
if [ -z "$PREV_TAG" ]; then
  PACKAGING_CHANGED=1
  info "no previous release tag, so treat all packaging as changed"
elif [ -n "$(git diff --name-only "$PREV_TAG"..HEAD -- electron-builder.yml resources/linux/)" ]; then
  PACKAGING_CHANGED=1
  info "packaging changed since $PREV_TAG, verify-deb-portability.sh is REQUIRED:"
  git diff --stat "$PREV_TAG"..HEAD -- electron-builder.yml resources/linux/ \
    | sed 's/^/          /'
else
  ok "packaging unchanged since $PREV_TAG, verify-deb-portability.sh can be skipped"
fi

# Publishing the previous release's notes is easy to do and hard to take back, so
# the heading has to name the version being cut. Absent is fine, stale is not.
if [ -f "$NOTES" ]; then
  head -1 "$NOTES" | grep -qF "$VERSION" || die "$NOTES still says '$(head -1 "$NOTES")', update it for $VERSION"
  ok "$NOTES is written for $VERSION"
else
  info "no $NOTES yet, the GitHub release will need its notes typed by hand"
fi

# --- 2. clean build outputs -------------------------------------------------
# After preflight, so a refused release (stale notes, dirty tree, existing tag)
# never destroys anything. dist/ otherwise accumulates every past release, and
# both of its consumers are blind to that: verify-deb-portability.sh picks its
# deb with `ls -t`, and `npm run checksums` globs every version into one file.
# Wiping first means what is in dist/ afterwards is exactly this build. The
# artifacts of past releases live on their GitHub release, not here.
step 2 "clean build outputs"
for d in dist out; do
  if [ -d "$d" ]; then
    info "$d ($(find "$d" -type f | wc -l) files, $(du -sh "$d" | cut -f1))"
    run rm -rf "$d"
  else
    info "$d (absent)"
  fi
done
[ "$DRY_RUN" = 1 ] || ok "dist/ and out/ removed"

# --- 3. bump ----------------------------------------------------------------
step 3 "bump package.json to $VERSION"
run npm version "$VERSION" --no-git-tag-version
[ "$DRY_RUN" = 1 ] || { BUMPED=1; ok "package.json and package-lock.json at $VERSION"; }

# --- 4. verify --------------------------------------------------------------
step 4 "typecheck and unit tests"
run npm run typecheck
run npm test

# --- 5. build ---------------------------------------------------------------
step 5 "build both artifacts (this takes a few minutes)"
run npm run dist

if [ "$DRY_RUN" = 1 ]; then
  info "would then expect dist/$DEB_NAME and dist/$APPIMAGE_NAME"
else
  [ -f "dist/$DEB_NAME" ] || die "electron-builder did not produce dist/$DEB_NAME"
  [ -f "dist/$APPIMAGE_NAME" ] || die "electron-builder did not produce dist/$APPIMAGE_NAME"
  ok "$DEB_NAME ($(du -h "dist/$DEB_NAME" | cut -f1))"
  ok "$APPIMAGE_NAME ($(du -h "dist/$APPIMAGE_NAME" | cut -f1))"
fi

# --- 6. checksums -----------------------------------------------------------
# Named explicitly rather than through `npm run checksums`, whose glob would fold
# every older build still sitting in dist/ into this release's SHA256SUMS.
step 6 "checksums"
if [ "$DRY_RUN" = 1 ]; then
  info "would write dist/SHA256SUMS over $DEB_NAME and $APPIMAGE_NAME"
else
  ( cd dist && sha256sum "$DEB_NAME" "$APPIMAGE_NAME" > SHA256SUMS && sha256sum -c SHA256SUMS )
  ok "dist/SHA256SUMS"
fi

# --- 7. sign ----------------------------------------------------------------
# No --batch: the key is passphrase-protected and pinentry needs to be able to ask.
step 7 "sign with $SIGNING_KEY"
run gpg --yes --armor --local-user "$SIGNING_KEY" \
        --detach-sign --output dist/SHA256SUMS.asc dist/SHA256SUMS
run gpg --verify dist/SHA256SUMS.asc dist/SHA256SUMS
[ "$DRY_RUN" = 1 ] || ok "dist/SHA256SUMS.asc verifies"

# --- 8. commit --------------------------------------------------------------
step 8 "commit the version bump"
run git add package.json package-lock.json
run git commit -q -m "Release $TAG"
[ "$DRY_RUN" = 1 ] || { COMMITTED=1; ok "$(git log --oneline -1)"; }

# --- 9. tag -----------------------------------------------------------------
step 9 "tag $TAG"
run git tag -a "$TAG" -m "Katacomb VPN $VERSION"
[ "$DRY_RUN" = 1 ] || ok "$TAG -> $(git rev-parse --short "$TAG")"

# --- what is left to do by hand ---------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  printf '\n\033[1mDry run finished.\033[0m Preflight passed, so the real run should go through.\n'
  printf 'Re-run without --dry-run to cut %s.\n' "$TAG"
  exit 0
fi

if [ "$PACKAGING_CHANGED" = 1 ]; then
  cat <<EOF

$(printf '\033[1mTest this build BEFORE publishing it.\033[0m') Packaging changed since
${PREV_TAG:-the last release}, so the portability run is required, and it has to happen
now: it picks its deb by mtime, and it ends with the package uninstalled.

    sudo ./scripts/verify-deb-portability.sh fullcycle
    sudo apt install ./dist/$DEB_NAME
    sudo reboot                     # postrm ran groupdel, so any earlier login is stale
    id -nG | grep katacomb          # must print the group before you trust the next line
    then connect and disconnect: neither should ask for a password
EOF
else
  cat <<EOF

$(printf '\033[1mTest this build BEFORE publishing it.\033[0m') Packaging is unchanged
since ${PREV_TAG:-the last release}, so the portability run can be skipped, but the
build still wants installing once:

    sudo apt install ./dist/$DEB_NAME
    id -nG | grep katacomb          # must print the group before you trust the next line
    then connect and disconnect: neither should ask for a password
EOF
fi

cat <<EOF

$(printf '\033[1mRelease %s is ready, and entirely local.\033[0m' "$TAG")

Push, when that passes:
    git push origin $RELEASE_BRANCH
    git push origin $TAG

Then publish the four files, either at
https://github.com/trinitystake/katacomb-vpn/releases/new?tag=$TAG
or with the gh CLI:

    gh release create $TAG \\
      --notes-file RELEASE_NOTES.md \\
      dist/$DEB_NAME \\
      dist/$APPIMAGE_NAME \\
      dist/SHA256SUMS \\
      dist/SHA256SUMS.asc

Anyone can then check the download with:
    sha256sum -c SHA256SUMS --ignore-missing
    gpg --verify SHA256SUMS.asc SHA256SUMS
EOF
