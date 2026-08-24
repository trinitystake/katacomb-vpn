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
#   0. notes      Rewrite the PROSE of RELEASE_NOTES.md, and of README.md if the
#                 release changed what the app does. Every version STRING in both
#                 (notes title, "Fixes in", README status line, and the install
#                 commands in both) is rewritten for you in step 1 and committed as
#                 "Update docs for <version>" - do not hand-edit those. The BODY
#                 is yours, and preflight refuses the cut if it still matches the
#                 previous release's word for word: 1.0.3 and 1.1.0 both shipped
#                 1.0.2's Highlights because nothing used to check. That tripwire
#                 only catches prose left completely untouched, so it is a floor,
#                 not a proofread.
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
#
# Note there are TWO commits to unwind past once a run reaches step 8: the docs
# commit from step 1 and the release commit itself. A run that dies in between
# leaves only the docs commit, and it is deliberately NOT rolled back - the notes
# and README are correct for the version you are cutting either way, and a re-run
# finds them already up to date and makes no second commit.
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

# Writes what RELEASE_NOTES.md for $version would look like to $out_file,
# leaving $src_notes untouched. Called in both dry and real runs so a dry run
# can report the truth instead of failing on a file it was never allowed to
# touch, and the real run then just copies $out_file over $src_notes.
generate_release_notes() {
  local version=$1 prev_tag=$2 src_notes=$3 out_file=$4

  # --no-merges because this repo's merge subjects restate the branch they carry
  # ("Merge the empty session cache fix" over "Do not let an empty session cache
  # hide a live session"), so keeping both lists every fix twice, in the vaguer
  # wording. Nothing is lost: the branch's own commits are on the first-parent
  # side of the range and survive.
  #
  # This script's own commits are excluded too, because they are not fixes and
  # because they compound: the docs commit lands BEFORE the build, so a run that
  # dies later leaves it in history, and the next attempt lists it as a fix for
  # the very release it belongs to - one fresh bullet per attempt.
  local fixes=""
  if [ -n "$prev_tag" ]; then
    fixes=$(git log "$prev_tag"..HEAD --no-merges --pretty=format:"- %s" |
      grep -vE "^- (Update docs for|Update release notes for|Release v)[0-9. ]*$" || true)
  fi

  if [ ! -f "$src_notes" ]; then
    cat > "$out_file" << EOF
# Katacomb VPN $version

## Fixes in $version

$fixes

## Installation

**Recommended: .deb**

\`\`\`bash
sudo apt install ./katacomb-vpn_${version}_amd64.deb
\`\`\`

**Alternative: AppImage**

\`\`\`bash
chmod +x katacomb-vpn-${version}.AppImage
./katacomb-vpn-${version}.AppImage
\`\`\`
EOF
    return
  fi

  cp "$src_notes" "$out_file"
  sed -i "1s/^.*/# Katacomb VPN $version/" "$out_file"

  # Replace the WHOLE fixes section (heading + old bullets), not just the
  # heading text — a plain heading-only sed left last release's fixes list
  # in place under the new heading.
  awk -v heading="## Fixes in $version" -v fixes="$fixes" '
    {
      if ($0 ~ /^## Fixes in /) {
        print heading; print ""; if (fixes != "") print fixes; print ""
        in_fixes = 1
        next
      }
      if (in_fixes) {
        if ($0 ~ /^## /) { in_fixes = 0 } else { next }
      }
      print
    }
  ' "$out_file" > "$out_file.tmp" && mv "$out_file.tmp" "$out_file"

  sed -i -E "s/katacomb-vpn_[0-9]+\.[0-9]+\.[0-9]+_amd64\.deb/katacomb-vpn_${version}_amd64.deb/g" "$out_file"
  sed -i -E "s/katacomb-vpn-[0-9]+\.[0-9]+\.[0-9]+\.AppImage/katacomb-vpn-${version}.AppImage/g" "$out_file"
}

# Same idea for README.md, which carries the version in five places: the status
# line and the four install commands. Unlike the notes it is hand-written prose,
# so this only ever rewrites those five and never generates a file from scratch —
# a missing README is left missing rather than invented.
generate_readme() {
  local version=$1 src_readme=$2 out_file=$3

  [ -f "$src_readme" ] || return 0
  cp "$src_readme" "$out_file"

  sed -i -E "s/(\*\*Status:\*\* release )\([0-9]+\.[0-9]+\.[0-9]+\)/\1(${version})/" "$out_file"
  sed -i -E "s/katacomb-vpn_[0-9]+\.[0-9]+\.[0-9]+_amd64\.deb/katacomb-vpn_${version}_amd64.deb/g" "$out_file"
  sed -i -E "s/katacomb-vpn-[0-9]+\.[0-9]+\.[0-9]+\.AppImage/katacomb-vpn-${version}.AppImage/g" "$out_file"

  # A sed that silently matches nothing is the exact failure this function exists
  # to prevent, and the status line is the one that is prose and can be reworded.
  # The filename patterns are mechanical, so a miss there means the install
  # commands were restructured and want looking at too.
  grep -q "\*\*Status:\*\* release ($version)" "$out_file" ||
    die "$src_readme: no '**Status:** release (x.y.z)' line to bump. Reword generate_readme() in scripts/release.sh to match the new wording."
}

# The prose the generator does NOT touch — the summary line under the title and
# ## Highlights — is step 0's job, and until now nothing noticed when step 0 was
# skipped. 1.0.3 and 1.1.0 both shipped 1.0.2's Highlights verbatim: once the
# title, the fixes list and the install filenames have been rewritten, a file
# carried forward wholesale and one genuinely rewritten look identical.
#
# So ask the question directly rather than trying to parse "the prose": put BOTH
# the working copy and the PREVIOUS release's copy through the generator for this
# same version, and compare the results. Generating both sides normalises the
# three mechanical rewrites identically, so what is left to differ is exactly the
# prose. Using the generator as its own oracle also means there is no list of
# section headings here to keep in step with the one above.
#
# Both sides must be generated. Comparing the raw working copy against a
# generated one instead looks like it works and does not: before the docs commit
# lands, the file still carries the PREVIOUS version's fixes list and filenames,
# so the two differ for mechanical reasons and a stale file reads as rewritten —
# a miss at exactly the moment this runs.
#
# Safe to re-run: on a second attempt the docs commit has already landed, but
# both sides still get the same fixes list, so the answer turns only on the prose.
#
# What it cannot see: ANY edit to the prose since the last tag reads as "step 0
# was done", including one made for some other reason - a typo fix, or a
# correction to the notes of the release before this one. It catches the case
# that actually happened, prose left entirely alone, and is a floor rather than
# a proofread.
assert_notes_prose_rewritten() {
  local version=$1 prev_tag=$2 notes=$3 from_worktree=$4

  [ -n "$prev_tag" ] || return 0
  [ -s "$from_worktree" ] || return 0
  git cat-file -e "$prev_tag:$notes" 2>/dev/null || return 0

  local prev_notes carried stale=0
  prev_notes="$(mktemp)"
  carried="$(mktemp)"
  git show "$prev_tag:$notes" > "$prev_notes"
  generate_release_notes "$version" "$prev_tag" "$prev_notes" "$carried"
  diff -q "$from_worktree" "$carried" >/dev/null 2>&1 && stale=1
  rm -f "$prev_notes" "$carried"

  [ "$stale" = 0 ] || die "$notes is still $prev_tag's notes with the version strings bumped.
        Its '## Highlights' and the summary line under the title describe
        ${prev_tag#v}, not $version. Rewrite them (step 0) and re-run. That is
        the one part of the notes no script can write for you."
  ok "$notes prose rewritten since $prev_tag"
}

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
READMEDOC=README.md
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

# RELEASE_NOTES.md's title, fixes section and install commands are derived
# from git history, not typed by hand, and README.md carries the same version in
# its status line and install commands — both are generated into a temp file
# first (read only, so a dry run sees the same thing a real run would) and
# compared against what is on disk, rather than requiring the disk copy to
# already match a version that has not been cut yet.
#
# Both land in ONE commit: they are the same edit, and splitting them means a
# release where the notes were bumped and the README was not is representable.
DOCS_CHANGED=0
sync_doc() {
  local target=$1 generated=$2
  # generate_readme declines to invent a file that is not there.
  [ -s "$generated" ] || { info "$target absent, nothing to bump"; return 0; }
  if [ -f "$target" ] && diff -q "$target" "$generated" >/dev/null 2>&1; then
    ok "$target already up to date for $VERSION"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    info "$target would be $([ -f "$target" ] && echo updated || echo created) for $VERSION"
    return 0
  fi
  cp "$generated" "$target"
  git add "$target"
  DOCS_CHANGED=1
  ok "$target updated for $VERSION"
}

NOTES_TMP="$(mktemp)"
README_TMP="$(mktemp)"
generate_release_notes "$VERSION" "$PREV_TAG" "$NOTES" "$NOTES_TMP"
assert_notes_prose_rewritten "$VERSION" "$PREV_TAG" "$NOTES" "$NOTES_TMP"
generate_readme "$VERSION" "$READMEDOC" "$README_TMP"
sync_doc "$NOTES" "$NOTES_TMP"
sync_doc "$READMEDOC" "$README_TMP"
if [ "$DOCS_CHANGED" = 1 ]; then
  git commit -q -m "Update docs for $VERSION"
  ok "committed: $(git log --oneline -1)"
fi
rm -f "$NOTES_TMP" "$README_TMP"

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
