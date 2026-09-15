# Architecture diagram

`katacomb-vpn.architecture.json` is the typed source for the runtime
architecture map: the renderer to preload to main to privileged-helper path,
the on-chain purchase path beside it, and the two external services and the
untrusted node around them. It is the only file here that is committed.

The rendered viewer is a generated artifact and is **gitignored**: it is ~800 KB,
almost all of it the vendored Archify template, and it is rewritten whole on
every render, so it would bloat history with diffs nobody can read.

## Rendering it

The renderer is [Archify](https://github.com/tt-a1i/archify), an agent skill
installed in your home directory, not a dependency of this repo:

```bash
npx skills add tt-a1i/archify -g     # installs to ~/.claude/skills/archify
```

Then, from the repo root:

```bash
node ~/.claude/skills/archify/bin/archify.mjs deliver architecture \
  docs/architecture/katacomb-vpn.architecture.json \
  docs/architecture/katacomb-vpn-architecture.html \
  --quality showcase --repo-root .
```

Open the HTML in a browser: it is self-contained, switches dark/light, carries
three guided views, and exports PNG/SVG. `deliver` refuses to write an artifact
that fails the showcase checks, so a hand-edited JSON cannot silently produce a
diagram with overlapping labels or an edge drawn through a component.

## Keeping it true

Components carry `sources` pins into real files, and the validator reads those
blobs at a commit. `scripts/check-architecture-doc.sh` re-pins to HEAD and
validates, so a renamed or deleted module fails `npm test` (it skips, without
failing, when the skill is not installed). What that cannot catch is a module
whose *meaning* changed, a new component nobody drew, or an edge that no longer
exists. Those are the author's job, and CLAUDE.md carries the rule.

`meta.repository.revision` in the committed JSON records the commit the diagram
was last verified against. Update it when you update the diagram; the check
itself always validates at HEAD and leaves the file alone.
