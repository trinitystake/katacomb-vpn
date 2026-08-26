#!/usr/bin/env bash
# Katacomb VPN release notes scaffold
#
#   ./scripts/draft-release-notes.sh 1.3.0 --edit     (scaffold, edit, commit)
#   ./scripts/draft-release-notes.sh 1.3.0
#   ./scripts/draft-release-notes.sh 1.3.0 --dry-run
#
# Prepares RELEASE_NOTES.md for a new version: retitles it, clears the prose that
# belonged to the last release, and assembles the commit range as raw material.
# It deliberately does NOT write the prose. Every part that needs judgement is
# left marked "TODO:", and release.sh refuses to cut while any marker remains.
#
# --edit runs the whole of step 0: scaffold, open $EDITOR, refuse to commit while a
# TODO: marker remains, then commit. Re-run it to resume an unfinished edit. Without
# --edit nothing is committed and you do the editing and committing yourself.
#
# Never tags or pushes.
# ---------------------------------------------------------------------------
#
# WHY this exists, and why it does not finish the job.
#
# Step 0 of a release is rewriting the notes for the version being cut, and it
# has gone wrong four times: 1.0.2, 1.0.3, 1.1.0 and 1.2.0 each shipped an
# earlier release's Highlights. The cause was never laziness, it was the blank
# page: the notes are ONE rolling file, so step 0 means editing 126 lines that
# still read as last release's, after working out the commit range by hand.
#
# So the mechanical half is automated here and the judgement half is not. A
# generator that wrote the Highlights too would produce commit-log prose that
# looks finished and therefore never gets read, which is the same failure with
# better formatting.
#
# WHAT THIS COSTS, and what pays for it. c8d4d0e made the TITLE the marker that a
# human did step 0, precisely because it could not be forged by correcting an
# older release's notes. This script writes the title, so that marker is spent:
# assert_notes_titled_for_version now passes on a file nobody has thought about.
# The replacement is assert_notes_no_todo_markers in release.sh, and it is a
# strictly better marker than the title was. The title was evidence only because
# nothing else set it; a TODO: marker is evidence because it is the one thing
# last release's prose CANNOT contain. Copying 1.2.0's notes forward satisfied
# the old title check the moment you retitled; it can never satisfy this one.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTES=RELEASE_NOTES.md

# The heading that begins the durable half of the file. Everything from here to
# EOF is carried through byte for byte: Known limitations, Platform support,
# Installation, Verifying your download, Important, Security model, License. It
# is ~75 lines of carefully worded standing content and none of it is per-release.
TAIL_HEADING='## Known limitations'

bold=$(tput bold 2>/dev/null || true); red=$(tput setaf 1 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)

ok()   { printf '  %sok%s    %s\n' "$green" "$reset" "$*"; }
info() { printf '  ....  %s\n' "$*"; }
die()  { printf '  %sSTOP%s  %s\n' "$red" "$reset" "$*" >&2; exit 1; }

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

VERSION=""
DRY_RUN=0
EDIT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --edit)     EDIT=1 ;;
    -h|--help)  usage; exit 0 ;;
    -*)         die "unknown option: $arg" ;;
    *)          [ -z "$VERSION" ] || die "version given twice: $VERSION and $arg"
                VERSION="$arg" ;;
  esac
done
[ -n "$VERSION" ] || { usage; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 1.0.0, got: $VERSION"
[ "$DRY_RUN" = 1 ] && [ "$EDIT" = 1 ] && die "--dry-run and --edit are contradictory: one writes nothing, the other commits"
true

cd "$REPO_ROOT"

printf '%sKatacomb VPN notes scaffold %s%s%s\n\n' "$bold" "$VERSION" "$reset" \
  "$([ "$DRY_RUN" = 1 ] && echo '   (dry run, nothing is written)')"

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO_ROOT"
[ -f "$NOTES" ] || die "$NOTES not found. This scaffolds an existing file, it does not invent one."

# Refused rather than merged into, because this rewrites the top of the file
# wholesale: an uncommitted edit to the prose would be silently destroyed. Under
# --edit the same state means something different - a draft already in progress -
# so it resumes instead, which is what makes a failed TODO check re-runnable.
SCAFFOLD=1
if [ -n "$(git status --porcelain --untracked-files=no -- "$NOTES")" ]; then
  [ "$EDIT" = 1 ] ||
    die "$NOTES has uncommitted changes. Commit or stash them first, this overwrites the prose."
  SCAFFOLD=0
  info "$NOTES already has uncommitted changes, resuming that draft rather than rescaffolding"
fi

! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || die "tag v$VERSION already exists"
ok "tag v$VERSION is free"

PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
[ -n "$PREV_TAG" ] || die "no tags in this repository, so there is no commit range to draw from"
ok "range $PREV_TAG..HEAD"

grep -qF "$TAIL_HEADING" "$NOTES" ||
  die "$NOTES has no '$TAIL_HEADING' heading, so the durable half cannot be located.
        That heading is the boundary this script preserves. Either restore it, or
        update TAIL_HEADING in scripts/draft-release-notes.sh to the new wording."

# --- raw material -----------------------------------------------------------
# Bucketed by what each commit touches, because the range reliably mixes product
# work with release plumbing, and the plumbing is actively misleading: this very
# range carries two commits about the PREVIOUS release's notes, which must not
# become Highlights for this one.
bucket_for() {
  local sha=$1 paths
  paths="$(git show --name-only --format='' "$sha" | grep -v '^$' || true)"
  if grep -q '^src/' <<< "$paths"; then
    echo product
  elif grep -qE '^(electron-builder\.yml|electron\.vite\.config\.ts|package(-lock)?\.json|postcss\.config\.js|tailwind\.config\.[a-z]+|resources/|build/)' <<< "$paths"; then
    echo packaging
  else
    echo process
  fi
}

# Top-level path per commit, so the reader can see at a glance what each touched.
touched_for() {
  git show --name-only --format='' "$1" | grep -v '^$' | sed 's|/.*||' | sort -u | paste -sd, -
}

# Same exclusion generate_release_notes() applies to the fixes list: this script's
# own commits are not changes, and they compound - the docs commit lands before the
# build, so a run that dies later leaves it in history for the next attempt to list.
RELEASE_COMMIT_RE='^(Update docs for|Update release notes for|Release v)[0-9. ]*$'

PRODUCT=""; PACKAGING=""; PROCESS=""
while IFS=$'\t' read -r sha subject; do
  [ -n "$sha" ] || continue
  if grep -qE "$RELEASE_COMMIT_RE" <<< "$subject"; then continue; fi
  line="$(printf '    %-9s %s  [%s]' "$sha" "$subject" "$(touched_for "$sha")")"
  case "$(bucket_for "$sha")" in
    product)   PRODUCT="${PRODUCT}${line}"$'\n' ;;
    packaging) PACKAGING="${PACKAGING}${line}"$'\n' ;;
    *)         PROCESS="${PROCESS}${line}"$'\n' ;;
  esac
done < <(git log --no-merges --format='%h%x09%s' "$PREV_TAG"..HEAD)

[ -n "$PRODUCT$PACKAGING$PROCESS" ] || die "no commits in $PREV_TAG..HEAD, there is nothing to draft"

section() {
  [ -n "$2" ] || return 0
  printf '\n  %s\n%s' "$1" "$2"
}

RAW_MATERIAL="$(
  section 'Product (touches src/), most likely Highlights:' "$PRODUCT"
  section 'Packaging and build, changes what ships:' "$PACKAGING"
  section 'Docs and release process, probably NOT Highlights:' "$PROCESS"
)"

# --- compose ----------------------------------------------------------------
# The standing product blurb is the first paragraph under the title. It describes
# the app, not the release, so it is carried forward; the paragraph after it is
# the per-release summary and is what gets replaced.
BLURB="$(awk 'NR>1 { if (NF) { found=1; print } else if (found) exit }' "$NOTES")"
[ -n "$BLURB" ] || die "$NOTES has no product blurb under the title to carry forward"

DRAFT="$(mktemp)"
trap 'rm -f "$DRAFT"' EXIT

{
  echo "# Katacomb VPN $VERSION"
  echo
  echo "$BLURB"
  echo
  echo "TODO: replace this line with the one or two sentence summary of $VERSION. Say what"
  echo "kind of release it is and what the headline change is."
  echo
  echo '## Highlights'
  echo
  echo "TODO: write the Highlights for $VERSION, then delete this paragraph and the raw"
  echo "material below. Lead each bullet with what changed for the person using the app,"
  echo "not with the commit subject. See $PREV_TAG's notes in git for the house style."
  echo
  echo "<!-- TODO: delete this block once the Highlights above are written."
  echo "     Raw material, $PREV_TAG..HEAD. Full detail:"
  echo "         git log --no-merges $PREV_TAG..HEAD"
  echo "$RAW_MATERIAL"
  echo "-->"
  echo
  # Heading kept deliberately: release.sh regenerates this section from the commit
  # range at cut time, and its awk matches on '^## Fixes in '. With the heading
  # absent it inserts nothing at all, silently, and the release ships no fixes list.
  echo "## Fixes in $VERSION"
  echo
  echo "<!-- regenerated by release.sh from $PREV_TAG..HEAD at cut time; leave the heading -->"
  echo
  sed -n "/^$TAIL_HEADING\$/,\$p" "$NOTES"
} > "$DRAFT"

# The tail is the whole point of the boundary, so prove it survived rather than
# trusting the sed.
diff <(sed -n "/^$TAIL_HEADING\$/,\$p" "$NOTES") <(sed -n "/^$TAIL_HEADING\$/,\$p" "$DRAFT") >/dev/null ||
  die "internal error: the durable half changed. Refusing to write."
ok "durable half from '$TAIL_HEADING' preserved verbatim"

TODO_COUNT="$(grep -c 'TODO:' "$DRAFT" || true)"

if [ "$DRY_RUN" = 1 ]; then
  info "would write $NOTES ($(wc -l < "$DRAFT") lines, $TODO_COUNT TODO markers)"
  printf '\n%s--- draft ---%s\n' "$bold" "$reset"
  sed -n "1,/^$TAIL_HEADING\$/p" "$DRAFT" | sed '$d'
  printf '%s--- (durable half from "%s" unchanged, not shown) ---%s\n' "$bold" "$TAIL_HEADING" "$reset"
  exit 0
fi

if [ "$SCAFFOLD" = 1 ]; then
  cp "$DRAFT" "$NOTES"
  ok "$NOTES scaffolded for $VERSION ($TODO_COUNT TODO markers left for you)"
fi

if [ "$EDIT" = 0 ]; then
  cat <<NEXT

Next:
  1. Edit $NOTES: the summary, the Highlights, and delete the raw material block.
     Every 'TODO:' marker must be gone. release.sh refuses the cut otherwise.
  2. git add $NOTES && git commit
     release.sh requires a clean tree, so this has to be committed before the cut.
  3. ./scripts/release.sh $VERSION --dry-run
NEXT
  exit 0
fi

# --- edit, verify, commit ---------------------------------------------------
# $VISUAL before $EDITOR is git's own order. No silent fallback chain beyond the
# usual suspects: guessing an editor the maintainer does not use is worse than
# saying so, since the file is already scaffolded and can be opened by hand.
editor="${VISUAL:-${EDITOR:-}}"
if [ -z "$editor" ]; then
  for candidate in sensible-editor nano vi; do
    command -v "$candidate" >/dev/null 2>&1 && { editor="$candidate"; break; }
  done
fi
[ -n "$editor" ] || die "no editor found. Set \$EDITOR, or edit $NOTES by hand and commit it yourself.
        The file is scaffolded and waiting either way."

info "opening $NOTES in $editor"
# Deliberately not `|| die`: an editor exiting non-zero says nothing about whether
# the file was saved, and the TODO check below is the real verdict.
"$editor" "$NOTES" || true

REMAINING="$(grep -n 'TODO:' "$NOTES" | cut -d: -f1 | paste -sd, - || true)"
if [ -n "$REMAINING" ]; then
  die "$NOTES still has TODO: markers on line(s) $REMAINING, so it is not committed.
        Re-run with --edit to pick up where you left off. Nothing was lost."
fi
ok "no TODO: markers left"

if [ -z "$(git status --porcelain --untracked-files=no -- "$NOTES")" ]; then
  ok "$NOTES already committed, nothing to do"
else
  # Worded to match the exclusion release.sh applies when it regenerates the fixes
  # list, so this commit does not list itself as a fix for the release it belongs to.
  git add "$NOTES"
  git commit -q -m "Update release notes for $VERSION"
  ok "committed: $(git log --oneline -1)"
fi

cat <<NEXT

Next:
  ./scripts/release.sh $VERSION --dry-run
NEXT
