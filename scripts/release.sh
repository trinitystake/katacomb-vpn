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
# Produces in dist/:
#     katacomb-vpn_<version>_amd64.deb
#     katacomb-vpn-<version>.AppImage
#     SHA256SUMS       checksums of exactly those two files
#     SHA256SUMS.asc   detached armored signature over SHA256SUMS
#
# The version bump is committed and tagged only if every earlier step passed; if
# a later one fails the bump is rolled back, so a re-run starts from a clean tree.

set -euo pipefail

# The maintainer's release key. A key id is public by construction (it is in every
# signature this produces), so it belongs in the repo: it is what a downloader
# checks the .asc against. Rotate here if the key ever changes.
SIGNING_KEY=7315246A6E67F3C6
RELEASE_BRANCH=main
MIN_NODE_MAJOR=22                 # `npm test` needs native TS type stripping
TOTAL=8

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

# Publishing the previous release's notes is easy to do and hard to take back, so
# the heading has to name the version being cut. Absent is fine, stale is not.
if [ -f "$NOTES" ]; then
  head -1 "$NOTES" | grep -qF "$VERSION" || die "$NOTES still says '$(head -1 "$NOTES")', update it for $VERSION"
  ok "$NOTES is written for $VERSION"
else
  info "no $NOTES yet, the GitHub release will need its notes typed by hand"
fi

# --- 2. bump ----------------------------------------------------------------
step 2 "bump package.json to $VERSION"
run npm version "$VERSION" --no-git-tag-version
[ "$DRY_RUN" = 1 ] || { BUMPED=1; ok "package.json and package-lock.json at $VERSION"; }

# --- 3. verify --------------------------------------------------------------
step 3 "typecheck and unit tests"
run npm run typecheck
run npm test

# --- 4. build ---------------------------------------------------------------
step 4 "build both artifacts (this takes a few minutes)"
run npm run dist

if [ "$DRY_RUN" = 1 ]; then
  info "would then expect dist/$DEB_NAME and dist/$APPIMAGE_NAME"
else
  [ -f "dist/$DEB_NAME" ] || die "electron-builder did not produce dist/$DEB_NAME"
  [ -f "dist/$APPIMAGE_NAME" ] || die "electron-builder did not produce dist/$APPIMAGE_NAME"
  ok "$DEB_NAME ($(du -h "dist/$DEB_NAME" | cut -f1))"
  ok "$APPIMAGE_NAME ($(du -h "dist/$APPIMAGE_NAME" | cut -f1))"
fi

# --- 5. checksums -----------------------------------------------------------
# Named explicitly rather than through `npm run checksums`, whose glob would fold
# every older build still sitting in dist/ into this release's SHA256SUMS.
step 5 "checksums"
if [ "$DRY_RUN" = 1 ]; then
  info "would write dist/SHA256SUMS over $DEB_NAME and $APPIMAGE_NAME"
else
  ( cd dist && sha256sum "$DEB_NAME" "$APPIMAGE_NAME" > SHA256SUMS && sha256sum -c SHA256SUMS )
  ok "dist/SHA256SUMS"
fi

# --- 6. sign ----------------------------------------------------------------
# No --batch: the key is passphrase-protected and pinentry needs to be able to ask.
step 6 "sign with $SIGNING_KEY"
run gpg --yes --armor --local-user "$SIGNING_KEY" \
        --detach-sign --output dist/SHA256SUMS.asc dist/SHA256SUMS
run gpg --verify dist/SHA256SUMS.asc dist/SHA256SUMS
[ "$DRY_RUN" = 1 ] || ok "dist/SHA256SUMS.asc verifies"

# --- 7. commit --------------------------------------------------------------
step 7 "commit the version bump"
run git add package.json package-lock.json
run git commit -q -m "Release $TAG"
[ "$DRY_RUN" = 1 ] || { COMMITTED=1; ok "$(git log --oneline -1)"; }

# --- 8. tag -----------------------------------------------------------------
step 8 "tag $TAG"
run git tag -a "$TAG" -m "Katacomb VPN $VERSION"
[ "$DRY_RUN" = 1 ] || ok "$TAG -> $(git rev-parse --short "$TAG")"

# --- what is left to do by hand ---------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  printf '\n\033[1mDry run finished.\033[0m Preflight passed, so the real run should go through.\n'
  printf 'Re-run without --dry-run to cut %s.\n' "$TAG"
  exit 0
fi

cat <<EOF

$(printf '\033[1mRelease %s is ready, and entirely local.\033[0m' "$TAG")

Push, when you want to:
    git push origin $RELEASE_BRANCH
    git push origin $TAG

Then publish the four files, either at
https://github.com/trinitystake/katacomb-vpn/releases/new?tag=$TAG
or with the gh CLI (not installed here: sudo apt install gh && gh auth login):

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
