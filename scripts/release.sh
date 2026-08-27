#!/usr/bin/env bash
# Katacomb VPN — cut a signed release: version bump, build, checksums, GPG
# signature, commit, tag. Not part of the build; run it by hand from the repo root.
#
#     ./scripts/release.sh 1.0.0 --dry-run   # print the plan, change nothing
#     ./scripts/release.sh 1.0.0             # do it
#     ./scripts/release.sh 1.0.0 --abort     # unwind a cut that was never published
#
# It stops before anything leaves this machine: it never pushes and never creates
# a GitHub release. Publishing is ./scripts/publish-release.sh <version>.
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
# ./scripts/ship.sh <version> runs the whole of it, and is the normal way in. It
# works out which of these steps are already done and does the next one, so it is
# re-run rather than resumed. The breakdown below stays the reference for what it
# is doing, and for the two steps it deliberately leaves to you: the portability
# run, and confirming that connect and disconnect actually work.
#
#   0. notes      ./scripts/draft-release-notes.sh <version> --edit
#
#                 That is the whole step: it scaffolds RELEASE_NOTES.md, opens it in
#                 $EDITOR, refuses to commit while a TODO: marker remains, and commits
#                 when none do. Re-run the same command to resume a draft you left
#                 unfinished. Without --edit it only scaffolds, and the editing and
#                 committing are yours to do by hand.
#
#                 The scaffold does the mechanical half: it retitles the file, clears
#                 the prose that belonged to the last release, and collects the commit
#                 range as raw material bucketed by what each commit touched. It
#                 deliberately stops there. Writing the PROSE - the summary under the
#                 title and ## Highlights - is yours, and is the one part no script
#                 can do: a generator would emit commit-log prose that looks finished
#                 and so never gets read, which is the same failure in better
#                 formatting. Update README.md too if the release changed what the app
#                 does. The result must be COMMITTED: preflight refuses a dirty tree, so
#                 an uncommitted step 0 stops the cut before any of the checks below
#                 run. --edit does that commit for you; by hand it is yours to remember.
#
#                 Every OTHER version STRING in both files ("Fixes in", the
#                 README status line, and the install commands in both) is rewritten
#                 for you in step 1 and committed as "Update docs for <version>" - do
#                 not hand-edit those. Leave the "## Fixes in" HEADING in place: step 1
#                 regenerates that section by matching on it, and with the heading gone
#                 it inserts nothing, silently, and the release ships no fixes list.
#
#                 THREE tripwires guard this step, because it has gone wrong four
#                 times (1.0.2, 1.0.3, 1.1.0 and 1.2.0 each shipped an earlier
#                 release's Highlights). The title must name the version being cut;
#                 the prose must differ from the previous tag's; and no "TODO:" marker
#                 may remain. The first two are floors, not a proofread - retitling
#                 without touching the Highlights satisfies one, and 1.2.0 walked past
#                 the other. The third is the load-bearing one now that the scaffold
#                 writes the title: a TODO: marker is the one thing last release's
#                 prose cannot contain, so it cannot be satisfied by carrying the old
#                 notes forward. Re-read Known limitations too: its items are
#                 MEANT to carry forward until actually fixed (identical is that
#                 section's healthy state), so no diff can police it - only you
#                 can notice a fixed limitation still listed, or a new one missing.
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
#   7. publish    ./scripts/publish-release.sh <version>
#                 Pushes the branch, pushes the tag, creates the GitHub release with
#                 the four artifacts. Verifies first that dist/ really is this tag's
#                 build (sha256sum -c AND gpg --verify), because gh uploads whatever
#                 it is handed and nothing else ties dist/ to the tag. Idempotent, so
#                 a publish that got halfway is resumed by re-running it.
#
# Nothing is public until step 7, so anything that fails before it unwinds with:
#     ./scripts/release.sh <version> --abort
#
# That deletes the tag and resets the "Release v<version>" commit, and refuses if the
# tag has already been pushed. It deliberately does NOT touch the docs commit from
# step 1 - the notes and README are correct for the version being cut either way, and
# a re-run finds them already up to date and makes no second one. If work sits on top
# of the release commit it refuses and prints the `git rebase --onto` form rather than
# guessing which commits were meant to survive.
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
  # Normalising, not authoring. On the real path the title already says $version,
  # because assert_notes_titled_for_version refused the cut otherwise. This line
  # earns its keep on the OTHER side of assert_notes_prose_rewritten, where the
  # input is the PREVIOUS tag's file and its title has to be levelled before the
  # two can be compared on prose alone.
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

# WHY the title is hand-written when every other version string is generated.
#
# assert_notes_prose_rewritten below asks git "did the prose change since the
# last release?". That is not the same question as "is this prose about the
# version being cut", and 1.2.0 is the release that proved it: b88678d rewrote
# RELEASE_NOTES.md AFTER v1.1.0 was tagged, to correct 1.1.0's own published
# Highlights. So at the 1.2.0 cut the working copy really did differ from
# v1.1.0:RELEASE_NOTES.md, the check read that as "step 0 was done", and 1.2.0
# shipped 1.1.0's Highlights - the third release running to ship someone else's,
# and the first to do it with a guard watching. The guard and the commit that
# defeated it were in the same release.
#
# No git-derived oracle can close that hole. The notes are ONE rolling file, so
# "the previous release's prose" and "not rewritten yet" are the same bytes, and
# nothing in the repository separates an edit made for this release from an edit
# made for the last one. The evidence has to be produced BY the rewrite, which
# means a marker set by hand.
#
# The title is that marker. It already names a version, it sits on line 1 of the
# file being edited anyway, and correcting an older release's notes cannot forge
# it (that edit keeps the older version). It used to be rewritten here with the
# mechanical strings, which is precisely what left the check below nothing to
# read.
assert_notes_titled_for_version() {
  local version=$1 notes=$2

  [ -f "$notes" ] || return 0

  local title
  title="$(head -1 "$notes")"
  [ "$title" = "# Katacomb VPN $version" ] || die "$notes is titled '$title', not '# Katacomb VPN $version'.
        The title is what says these notes were written for the version being
        cut, so it is yours to set (step 0) and not the generator's. Rewrite the
        summary line and '## Highlights' for $version, retitle the file, and
        re-run. scripts/draft-release-notes.sh $version does the retitling, and
        everything else mechanical, for you. Note that retitling ALONE satisfies
        this check: what catches Highlights left describing the previous release
        is assert_notes_no_todo_markers below."
  ok "$notes titled for $version"
}

# The marker that a human actually wrote step 0.
#
# It used to be the title (c8d4d0e): generated titles were how 1.0.3, 1.1.0 and
# 1.2.0 each shipped an earlier release's Highlights, so the title was made
# hand-set and asserted. draft-release-notes.sh now writes the title, which spends
# that marker - it passes on a file nobody has read.
#
# TODO: markers replace it, and are a better marker than the title ever was. The
# title was evidence only by convention, and retitling satisfied it in one edit.
# A TODO: marker is evidence by construction: it is the one thing last release's
# prose cannot contain, so carrying 1.2.0's notes forward can never produce a file
# that passes this. The scaffold puts one on every part needing judgement - the
# summary, the Highlights, and the raw commit material - so a half-finished draft
# is refused as loudly as an untouched one.
#
# Runs on the RAW working copy, like the title check and unlike the prose check:
# generate_release_notes would carry the markers through unchanged, but reading
# the file the maintainer actually edited is what makes the failure legible.
assert_notes_no_todo_markers() {
  local version=$1 notes=$2

  [ -f "$notes" ] || return 0

  local lines
  lines="$(grep -n 'TODO:' "$notes" | cut -d: -f1 | paste -sd, - || true)"
  [ -z "$lines" ] || die "$notes still has unfinished TODO: markers on line(s) $lines.
        The scaffold leaves one on every part that needs judgement: the summary,
        the Highlights, and the raw commit material it collected. Write the prose
        for $version, delete the raw material block, and re-run.
        Read them with: grep -n 'TODO:' $notes"
  ok "$notes has no unfinished TODO: markers"
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
# correction to the notes of the release before this one. That last one is not
# hypothetical, it is how 1.2.0 shipped 1.1.0's Highlights straight past this
# check one release after it was added; assert_notes_titled_for_version above is
# the answer to it. This half is kept because it is the only one that looks at
# the prose at all, so it still catches a file left entirely alone whose title
# was bumped to satisfy the other. Two floors, neither a proofread.
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

# Prints the header's title and usage block. The range is a line count, so it
# silently truncates when that block grows: check `--help` OUTPUT, not the file.
usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# --- arguments --------------------------------------------------------------
VERSION=""
DRY_RUN=0
ABORT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --abort)    ABORT=1 ;;
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

# --- --abort: unwind a cut that was never published -------------------------
# The unwind used to live only in the header comment, i.e. it was read under
# pressure, after a failed run, by someone who had just been surprised. Encoded
# here so the ordering and the exceptions are not remembered but executed.
#
# It undoes exactly two things, and deliberately not a third:
#   - the tag, which is step 9
#   - the "Release <tag>" commit, which is step 8
#   - NOT the docs commit from step 1. That is the same call the header records:
#     the notes and README are correct for the version being cut either way, and
#     a re-run finds them already up to date and makes no second commit.
if [ "$ABORT" = 1 ]; then
  printf '%bKatacomb VPN abort %s%b\n\n' '\033[1m' "$TAG" '\033[0m'

  BRANCH="$(git branch --show-current)"
  [ "$BRANCH" = "$RELEASE_BRANCH" ] || die "on branch '$BRANCH', releases are cut from '$RELEASE_BRANCH'"
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    die "working tree has uncommitted changes. Commit or stash them first: this resets a
        commit, and anything uncommitted would be lost with it."

  # The one hard refusal. Once the tag is on the remote it is someone else's
  # history too, and a convenience flag is not where that gets rewritten.
  if [ -n "$(git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null)" ]; then
    die "$TAG is already pushed to origin, so it is published history and this will not
        touch it. If it really must go, delete it deliberately and by hand:
            git push origin :refs/tags/$TAG && git tag -d $TAG"
  fi

  # Decide everything BEFORE touching anything. Acting as it went meant a refusal
  # could arrive with the tag already deleted, leaving a half-undone cut - which is
  # the state this flag exists to avoid, not to create.
  HAS_TAG=0
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && HAS_TAG=1

  RESET=0
  if [ "$(git log -1 --format='%s')" = "Release $TAG" ]; then
    RESET=1
  else
    # Present but not at HEAD: work landed on top. Refuse rather than guess which
    # commits were meant to survive, and hand over the form that moves them.
    RELEASE_COMMIT="$(git rev-list -1 --fixed-strings --grep="Release $TAG" HEAD 2>/dev/null || true)"
    if [ -n "$RELEASE_COMMIT" ] && [ "$(git log -1 --format='%s' "$RELEASE_COMMIT")" = "Release $TAG" ]; then
      SHORT="$(git rev-parse --short "$RELEASE_COMMIT")"
      die "the 'Release $TAG' commit is $SHORT but work sits on top of it, so resetting
        would take that work with it. Nothing has been changed. Move it yourself:
            git rebase --onto $SHORT~1 $SHORT"
    fi
  fi

  if [ "$HAS_TAG" = 0 ] && [ "$RESET" = 0 ]; then
    info "no local tag $TAG and no 'Release $TAG' commit: nothing to undo"
  fi

  if [ "$HAS_TAG" = 1 ]; then
    run git tag -d "$TAG"
    [ "$DRY_RUN" = 1 ] || ok "deleted local tag $TAG"
  fi
  if [ "$RESET" = 1 ]; then
    run git reset --hard HEAD~1
    [ "$DRY_RUN" = 1 ] || ok "reset the release commit, HEAD is now $(git log --oneline -1)"
  fi
  printf '\n%bThe docs commit, if any, is left in place on purpose.%b\n' '\033[1m' '\033[0m'
  printf 'It is correct for %s either way, and a re-run makes no second one.\n' "$VERSION"
  exit 0
fi

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

resolve_node || die "no node >= $MIN_NODE_MAJOR found (looked on PATH and in ~/.nvm/versions/node)"
ok "node $(node -v) at $(command -v node)"

# After resolve_node, so `node -p` is a real node rather than leaning on the sed
# fallback whenever the nvm stub is on PATH.
CURRENT="$(node -p "require('./package.json').version" 2>/dev/null || sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json | head -1)"
[ "$CURRENT" != "$VERSION" ] || die "package.json is already at $VERSION"
ok "version $CURRENT -> $VERSION"

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
assert_notes_titled_for_version "$VERSION" "$NOTES"
assert_notes_no_todo_markers "$VERSION" "$NOTES"
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
