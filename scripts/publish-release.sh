#!/usr/bin/env bash
# Katacomb VPN — publish a cut release: push the branch, push the tag, create the
# GitHub release with the four artifacts attached.
#
#     ./scripts/publish-release.sh 1.4.0 --dry-run   # check everything, send nothing
#     ./scripts/publish-release.sh 1.4.0
#
# This is the ONLY step that reaches the outside world. Everything release.sh does
# is local and reversible; this is not. So the whole of preflight runs before any
# byte leaves the machine, and it asks before the irreversible part.
#
# Run it AFTER the build has been tested. release.sh prints what that means for the
# release it just cut (install the deb, sometimes reboot, then connect and disconnect
# and confirm neither prompts for a password). Nothing here can check that for you.
# ---------------------------------------------------------------------------
#
# WHY the checks are what they are.
#
# `gh release create` uploads whatever files it is handed. Nothing tied dist/ to
# the tag being published, so a stale build left from an earlier run would publish
# silently, correctly signed, for the wrong bits. `sha256sum -c` and `gpg --verify`
# are therefore not decoration: they are the only thing standing between "the tag
# says 1.4.0" and "these files are 1.4.0".
#
# IDEMPOTENT on purpose. The failure worth designing for is not a clean run, it is
# a publish that got halfway: the branch pushed and the tag not, or both pushed and
# the release not created. Each of the three actions is skipped when it is already
# done, so re-running is always safe and never duplicates anything.
#
# The two artifact filenames differ, and that is correct, not a slip:
#   katacomb-vpn_<version>_amd64.deb   Debian policy: <package>_<version>_<arch>
#   katacomb-vpn-<version>.AppImage    AppImage convention, set in electron-builder.yml
# Do not "fix" one to match the other. The deb name is what apt and dpkg-scanpackages
# expect, and it is electron-builder's default precisely because of that.
# ---------------------------------------------------------------------------
set -euo pipefail

SIGNING_KEY=7315246A6E67F3C6
RELEASE_BRANCH=main
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTES=RELEASE_NOTES.md

bold=$(tput bold 2>/dev/null || true); red=$(tput setaf 1 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)

ok()   { printf '  %sok%s    %s\n' "$green" "$reset" "$*"; }
info() { printf '  ....  %s\n' "$*"; }
die()  { printf '  %sSTOP%s  %s\n' "$red" "$reset" "$*" >&2; exit 1; }

# Prints the header block above, down to the ruled line. The range is a line count,
# so it silently truncates if that block grows: check `--help` OUTPUT after editing.
usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

VERSION=""
DRY_RUN=0
ASSETS_ONLY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --assets-only)  ASSETS_ONLY=1 ;;
    -y|--yes)       ASSUME_YES=1 ;;
    -h|--help)      usage; exit 0 ;;
    -*)             die "unknown option: $arg" ;;
    *)              [ -z "$VERSION" ] || die "version given twice: $VERSION and $arg"
                    VERSION="$arg" ;;
  esac
done
[ -n "$VERSION" ] || { usage; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 1.0.0, got: $VERSION"

TAG="v$VERSION"
DEB_NAME="katacomb-vpn_${VERSION}_amd64.deb"
APPIMAGE_NAME="katacomb-vpn-${VERSION}.AppImage"

cd "$REPO_ROOT"

printf '%sKatacomb VPN publish %s%s%s\n' "$bold" "$TAG" "$reset" \
  "$([ "$DRY_RUN" = 1 ] && echo '   (dry run, nothing is sent)')"

# --- preflight: all read-only, all before anything leaves the machine --------
printf '\n%s[1/2] preflight%s\n' "$bold" "$reset"

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO_ROOT"

BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "$RELEASE_BRANCH" ] || die "on branch '$BRANCH', releases are published from '$RELEASE_BRANCH'"
ok "on $RELEASE_BRANCH"

[ -z "$(git status --porcelain --untracked-files=no)" ] ||
  die "working tree has uncommitted changes. Publishing from a dirty tree would ship a
        commit that is not what you tested."
ok "working tree clean"

CURRENT="$(node -p "require('./package.json').version" 2>/dev/null ||
  sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json | head -1)"
[ "$CURRENT" = "$VERSION" ] ||
  die "package.json is at $CURRENT, not $VERSION. Either you are publishing the wrong
        version, or the cut for $VERSION never completed."
ok "package.json at $VERSION"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null ||
  die "no local tag $TAG. Cut the release first: ./scripts/release.sh $VERSION"
# ANCESTOR, not equality. A GitHub release points at a tag, never at the branch tip,
# so commits landing after the cut are normal and must not block publishing: it is
# exactly what happens when a fix is deliberately held back out of the release being
# cut. What actually matters is that pushing the branch carries the tagged commit,
# which is what an ancestor check states and an equality check merely implies.
git merge-base --is-ancestor "$TAG^{commit}" HEAD 2>/dev/null ||
  die "$TAG ($(git rev-parse --short "$TAG^{commit}")) is not an ancestor of HEAD
        ($(git rev-parse --short HEAD)), so pushing $RELEASE_BRANCH would not carry the
        tagged commit. The tag is on a different line of history."
AHEAD="$(git rev-list --count "$TAG^{commit}..HEAD")"
if [ "$AHEAD" -eq 0 ]; then
  ok "$TAG is at HEAD"
else
  ok "$TAG is an ancestor of HEAD"
  info "$AHEAD commit(s) on $RELEASE_BRANCH after $TAG; pushing the branch sends those too,
        which is fine: the release attaches to the tag, not to the branch tip"
fi

# This is the file gh uploads as the release body, so it is worth checking it is the
# one written for this version rather than whatever is lying around.
[ -f "$NOTES" ] || die "$NOTES not found"
NOTES_TITLE="$(head -1 "$NOTES")"
[ "$NOTES_TITLE" = "# Katacomb VPN $VERSION" ] ||
  die "$NOTES is titled '$NOTES_TITLE', not '# Katacomb VPN $VERSION'.
        That file becomes the GitHub release body, so it must be this version's notes."
ok "$NOTES titled for $VERSION"

for f in "$DEB_NAME" "$APPIMAGE_NAME" SHA256SUMS SHA256SUMS.asc; do
  [ -f "dist/$f" ] || die "dist/$f is missing. Re-run ./scripts/release.sh $VERSION;
        it wipes dist/ and rebuilds, so a partial dist/ is never worth patching by hand."
done
ok "all four artifacts present in dist/"

# The check this script exists for. dist/ is wiped and rebuilt by every cut, but
# nothing until now proved that what is in it belongs to the tag being published.
( cd dist && sha256sum -c SHA256SUMS --ignore-missing >/dev/null 2>&1 ) ||
  die "dist/SHA256SUMS does not match the files next to it. The artifacts are not the
        ones that were checksummed, so do NOT publish them. Re-cut: ./scripts/release.sh $VERSION"
ok "SHA256SUMS matches the artifacts"

gpg --verify dist/SHA256SUMS.asc dist/SHA256SUMS >/dev/null 2>&1 ||
  die "dist/SHA256SUMS.asc does not verify against dist/SHA256SUMS.
        The signature is what downloaders check, so publishing an unverifiable one is
        worse than publishing nothing."
ok "signature verifies ($SIGNING_KEY)"

command -v gh >/dev/null 2>&1 || die "gh CLI not installed, so the release cannot be created.
        Push by hand and create the release in the web UI, or install gh."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"
ok "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo 'unknown')"

# --- what is already done ---------------------------------------------------
# Asked of the REMOTE, in one round trip, so the plan printed below is the plan that
# runs. Deliberately not `origin/main`: that is a local cache and can be arbitrarily
# stale, which would have this script report work as pending that is already done.
#
# A failure here is fatal rather than a shrug. Unreachable-origin used to fall back to
# "assume nothing is pushed", which is the worst possible guess for a publish script:
# it reported a pushed tag as pending. If the remote cannot be read it cannot be
# written either, so there is nothing to do but say so.
REMOTE_REFS="$(git ls-remote origin 2>/dev/null)" ||
  die "cannot reach origin, so what is already published is unknowable.
        If this repo pushes over SSH, the agent may not be reachable from here:
        try  SSH_AUTH_SOCK=/run/user/\$(id -u)/keyring/ssh $0 $VERSION"
[ -n "$REMOTE_REFS" ] || die "origin returned no refs at all, which should not happen"
ok "read remote state from origin"

REMOTE_BRANCH_SHA="$(awk -v r="refs/heads/$RELEASE_BRANCH" '$2 == r {print $1}' <<< "$REMOTE_REFS")"
BRANCH_PUSHED=0
[ "$REMOTE_BRANCH_SHA" = "$(git rev-parse HEAD)" ] && BRANCH_PUSHED=1

TAG_PUSHED=0
[ -n "$(awk -v r="refs/tags/$TAG" '$2 == r {print $1}' <<< "$REMOTE_REFS")" ] && TAG_PUSHED=1

RELEASE_EXISTS=0
if gh release view "$TAG" >/dev/null 2>&1; then RELEASE_EXISTS=1; fi

printf '\n%s[2/2] publish%s\n' "$bold" "$reset"

if [ "$BRANCH_PUSHED" = 1 ]; then ok "$RELEASE_BRANCH already pushed"; else info "will push $RELEASE_BRANCH"; fi
if [ "$TAG_PUSHED" = 1 ];    then ok "$TAG already pushed";            else info "will push $TAG"; fi
if [ "$RELEASE_EXISTS" = 1 ]; then
  if [ "$ASSETS_ONLY" = 1 ]; then
    info "release $TAG exists, will upload any missing assets onto it"
  else
    ok "release $TAG already exists, leaving it alone (--assets-only to add files to it)"
  fi
else
  [ "$ASSETS_ONLY" = 0 ] || die "--assets-only given but no release $TAG exists yet"
  info "will create release $TAG with 4 assets"
fi

if [ "$BRANCH_PUSHED" = 1 ] && [ "$TAG_PUSHED" = 1 ] && [ "$RELEASE_EXISTS" = 1 ] && [ "$ASSETS_ONLY" = 0 ]; then
  printf '\n%s%s is fully published. Nothing to do.%s\n' "$bold" "$TAG" "$reset"
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  printf '\n%sDry run finished.%s Preflight passed; nothing was sent.\n' "$bold" "$reset"
  exit 0
fi

if [ "$ASSUME_YES" = 0 ]; then
  printf '\n  %sThis publishes to GitHub and cannot be undone.%s Continue? [y/N] ' "$bold" "$reset"
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) die "aborted, nothing was sent" ;;
  esac
fi

# Order matters: the tag has to exist on the remote before the release can attach
# assets to it, and the branch has to carry the tagged commit before the tag makes
# sense to anyone fetching it.
if [ "$BRANCH_PUSHED" = 0 ]; then
  git push origin "$RELEASE_BRANCH"
  ok "pushed $RELEASE_BRANCH"
fi
if [ "$TAG_PUSHED" = 0 ]; then
  git push origin "$TAG"
  ok "pushed $TAG"
fi

if [ "$RELEASE_EXISTS" = 0 ]; then
  gh release create "$TAG" \
    --notes-file "$NOTES" \
    "dist/$DEB_NAME" \
    "dist/$APPIMAGE_NAME" \
    dist/SHA256SUMS \
    dist/SHA256SUMS.asc
  ok "created release $TAG with 4 assets"
elif [ "$ASSETS_ONLY" = 1 ]; then
  gh release upload "$TAG" \
    "dist/$DEB_NAME" \
    "dist/$APPIMAGE_NAME" \
    dist/SHA256SUMS \
    dist/SHA256SUMS.asc \
    --clobber
  ok "uploaded assets onto existing release $TAG"
fi

cat <<DONE

$(printf '%s%s is published.%s' "$bold" "$TAG" "$reset")
    https://github.com/trinitystake/katacomb-vpn/releases/tag/$TAG

Anyone can check a download with:
    sha256sum -c SHA256SUMS --ignore-missing
    gpg --verify SHA256SUMS.asc SHA256SUMS
DONE
