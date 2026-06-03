# Electron 33 + React 18 + TS + Vite + Tailwind 3 — Codebase Audit & Modernization (Claude Code)

> **Reusable prompt.** Run from the project root with `claude "$(cat audit-electron-react-ts.md)"`
> or paste the body below into a Claude Code session. Fill the **Project context**
> block at the bottom if you can — it sharpens everything.

---

You are acting as a principal engineer performing a comprehensive audit of this
**Electron 33 desktop app (React 18 + TypeScript + Vite + Tailwind CSS 3)**. Your
job is to find problems, propose improvements, and — only after I approve a plan —
implement them safely. Be rigorous, evidence-based, and pragmatic. Every finding
must point to a real location in the code (`file:line`), not a hypothetical. Do
not invent issues to pad the report.

The stack above is my assumption. **If the repo actually differs** (a different
Electron/React major, a state lib, a different bundler, extra native modules),
say so in Phase 0 and adapt the audit — and tailor version-specific advice to the
majors actually present rather than assuming newer APIs.

## Phase 0 — Orient (read-only, no changes)
1. Confirm the real stack and **exact versions** from lockfiles: Electron, React,
   TypeScript, Vite, Tailwind, plus state management, routing, test tooling,
   builder (electron-builder/Forge), and any native modules.
2. List the exact commands to **dev, build, package, test, lint, and type-check**.
3. Map the architecture: **main process, preload script(s), renderer**; the IPC
   surface between them; window lifecycle; auto-update; build/packaging pipeline;
   external services.
4. Read any existing `CLAUDE.md`, `README`, and config to learn intended
   conventions.
5. Summarize what the app does and how it's structured. If anything is
   ambiguous, ask me now before going further.

## Phase 0.5 — Pressure-test this prompt (important)
This prompt was written **without seeing your repo**, so it is necessarily
incomplete. Once you understand the actual code, evaluate the prompt itself and
identify:
- Audit dimensions relevant to *this specific* app that the checklist below omits.
- Libraries, subsystems, or risky areas here that deserve their own scrutiny.
- Instructions below that don't fit this project and should be adapted or dropped.

Fold those gaps into the audit scope and record them in a **"Prompt gaps & added
scope"** section of the report. Do not silently skip something just because it
isn't listed.

## Phase 1 — Audit (still read-only)
For every finding record: **severity** (Critical / High / Medium / Low),
`file:line`, what's wrong, why it matters, and the recommended fix.

**Electron security (top priority — desktop apps ship to user machines)**
- `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` for
  every `BrowserWindow`/renderer.
- No `@electron/remote`/`enableRemoteModule` unless justified.
- Preload exposes a **minimal, typed, allow-listed** API via `contextBridge` —
  never the whole `ipcRenderer` or raw Node modules.
- **IPC validation**: every `ipcMain.handle`/`on` validates the sender, channel,
  and payload shape/values; no trusting renderer input blindly.
- A real **Content-Security-Policy**; `webSecurity` not disabled.
- Navigation locked down: `will-navigate` and `setWindowOpenHandler` restrict
  navigation and new windows; no loading remote/untrusted URLs into a privileged
  renderer.
- `shell.openExternal`, `fs`, and `child_process` never invoked with unsanitized
  renderer-supplied input.

**IPC architecture**
- Clear main/renderer boundary; `invoke/handle` (promise) vs `send/on` used
  appropriately; typed contracts shared between main and renderer; no leaking of
  Node capabilities into the renderer; backpressure on chatty channels.

**Process & window lifecycle**
- Window-state handling and cleanup; multi-window correctness; `app` lifecycle
  events; preventing zombie/orphaned processes; memory growth in the long-lived
  main process; listeners removed on window close.

**Auto-update & packaging**
- Updater configured **securely** (signed, HTTPS, e.g. electron-updater) — not an
  unauthenticated channel; ASAR packaging; native-module rebuild correctness;
  **code signing / notarization** for macOS and Windows; what ships in the final
  bundle (no source maps/secrets leaking).

**Vite, env & secrets (high-value gotcha)**
- **`VITE_`-prefixed env vars are inlined into the renderer bundle and shipped to
  users** — flag any secret/API key/token exposed this way; build config; source
  maps in production; code splitting and chunk sizing; dev-only settings not
  bleeding into prod builds.

**React 18 correctness**
- `useEffect` cleanup for listeners, timers, subscriptions, and **IPC handlers**
  (leaks otherwise); exhaustive-deps issues; misuse — or absence — of `useMemo`/
  `useCallback`/`React.memo`; stable `key`s in lists; state-management approach
  (Context re-render storms, or the chosen lib used well); Strict Mode
  double-invoke surprises; concurrent-rendering assumptions; data-fetching
  waterfalls and missing cancellation.

**TypeScript rigor**
- `strict` mode on; `any`/unsafe `as` escape hatches; **untyped IPC boundaries**;
  `@ts-ignore`/`@ts-expect-error` usage; external/IPC data validated at runtime
  where it crosses a trust boundary (zod/valibot); overall `tsconfig` soundness.

**Tailwind 3**
- `content` globs correct — classes neither purged at build nor bloating the CSS;
  **dynamic class names** the purge can't see; arbitrary-value overuse; duplicated
  utility soup that should be components or `@apply`; design-token consistency;
  this is **Tailwind 3**, not v4 — don't propose v4-only config.

**Renderer performance & UX**
- Bundle size and lazy loading (`React.lazy`/dynamic import); expensive renders;
  large lists without virtualization; image/asset optimization; main-thread jank;
  startup/first-paint time; accessibility basics (semantic HTML, ARIA, keyboard
  nav, focus, contrast).

**Cross-platform**
- Path handling (`path.join`, no hardcoded separators); platform-specific menus/
  shortcuts/tray/file-dialogs; behavior differences across Windows/macOS/Linux.

**General correctness & bugs**
- Logic errors, unhandled promise rejections, error boundaries, race conditions,
  resource leaks, edge cases, broken invariants in both processes.

**Dependencies**
- Outdated, unused, duplicated, or **vulnerable** packages (`npm audit`); native
  deps matching the Electron ABI; pinned vs floating versions; license concerns.

**Architecture & structure**
- Main/renderer responsibilities cleanly separated; duplicated logic; dead config;
  weak error-handling strategy; observability (logging across processes, crash
  reporting).

**Dead, orphan & duplicate code/files**
- Unused components/hooks/exports/imports, unreachable branches, commented-out
  blocks, unused assets, files referenced nowhere. Treat all as **candidates
  only** — see deletion rules in Phase 3.

**Tests & CI**
- Coverage on critical paths and IPC contracts; component tests; e2e (Playwright/
  Spectron-successor) if present; brittle/flaky tests; CI/CD weaknesses;
  reproducible packaging in CI.

**Version-specific modernization**
- Electron 33 deprecations and its bundled Chromium/Node versions; React 18 APIs
  (do **not** assume React 19); Vite and Tailwind 3 idioms; modern patterns worth
  adopting — only where they add real value.

Write results to `AUDIT.md`: executive summary, a findings table sorted by
severity, a **"quick wins"** section, and the **"Prompt gaps & added scope"**
section from Phase 0.5.

## Phase 2 — Plan
Propose a prioritized remediation plan in logical batches (Electron security,
critical bugs, dead-code cleanup, performance/bundle, modernization). For each
batch note risk, effort, and whether it changes behavior. **Wait for my approval
before changing code.**

## Phase 3 — Implement (only after I approve)
- Work on a new git branch. Never commit to `main` directly; never force-push.
- Focused commits, one logical change each, with clear messages.
- After every change run type-check, lint, tests, and a build; fix what you
  break. For impactful changes, sanity-check that the app still launches and the
  main↔renderer IPC still works.
- Preserve existing behavior unless a change is the explicit point of the fix;
  flag any behavior change loudly.
- **Deletion rules:** before removing any file or block, prove it is genuinely
  unused — search for dynamic imports, string-based references, route/lazy
  targets, IPC channel names, asset references in code/CSS, and build-config
  entries. Present the full deletion list for my approval. Remove via git so it's
  reversible; never hard-delete an unverified "orphan."
- Don't touch secrets, credentials, or anything in the LEAVE ALONE list.

## CLAUDE.md & memory (do this regardless of the rest)
- Create or update `CLAUDE.md` with what a future session needs: project summary,
  the main/preload/renderer architecture and IPC surface, the **exact** dev/build/
  package/test/lint/type-check commands, the security posture
  (isolation/sandbox/CSP), env-var and secrets handling, directory map, key
  invariants, known gotchas, and any "don't do X" rules surfaced here.
- Keep it concise and durable — facts that stay true, not a changelog.
- Record standing project conventions and preferences to **memory** so they
  persist across sessions.

## Ground rules
- Evidence over assertion: cite `file:line` for every claim. If unsure, say so
  and verify rather than guess.
- Prioritize ruthlessly: a few critical findings beat a hundred nitpicks.
- Ask before anything destructive or irreversible.
- If you notice something important that none of the above asked about, raise it
  anyway.

---
### Project context (optional, but fill in what you can)
- Exact versions & state/build libs:
- What the app does:
- Areas you're most worried about:
- Distribution (signing, auto-update, target OSes):
- LEAVE ALONE (files, modules, behaviors not to change):
