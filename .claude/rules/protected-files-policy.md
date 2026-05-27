# Protected-files policy (bug-091 + bug-111)

Authoritative policy consumed by `bug-fixer` + `systemic-fixer` agents during `/fix-bugs` loop dispatches. Referenced from `.claude/agents/bug-fixer.md` §Protected files + `.claude/agents/systemic-fixer.md` §Protected files + `orchestrator/src/protected-files.ts` (canonical machine-readable manifest).

## What is protected and why

The factory ships load-bearing config files that downstream CSS compilation, build orchestration, dev-server boot, test discovery, and workspace resolution all DEPEND ON. Past `/fix-bugs` dispatches have deleted or emptied these files while reasoning that a config was the source of unwanted behavior — silently regressing prior structural correctness. The most empirically destructive case: deleting `apps/web/postcss.config.mjs` on reading-log-02 reopened bug-077's Tailwind-pipeline gap across multiple `/fix-bugs` rounds while orchestrator metrics reported ~95% clean resolution.

bug-111 added the backend canonical app-entrypoints to the manifest after gotribe-tribe-directory 2026-05-15 shipped through Mode B + verifier + /fix-bugs with the FastAPI entry at `apps/api/src/main.py` instead of the canonical `apps/api/src/api/main.py`. The empirical class is symmetric: deleting / mis-placing the canonical backend entrypoint cascade-skips Tiers 3+4+5 of `/build-to-spec-verify` (parity, perceptual, walkthrough) because `dev-server` pre-boot fails. The hard layer here guards a fix-loop dispatch that — having read this policy and chosen to delete the entrypoint anyway — gets its commit rolled back.

| Invariant class                | Manifest source (TS)              | Failure shape                                                                                         |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Absolute path must exist       | `PROTECTED_FILES`                 | Agent deletes `apps/web/postcss.config.mjs`                                                           |
| First-match variant must exist | `PROTECTED_FILES` (tuple entries) | Agent renames `postcss.config.mjs` → unknown ext; agent deletes the canonical backend entry (bug-111) |
| Every packages/<name>/ keeps   | `PROTECTED_PACKAGES_FILES`        | Agent deletes `packages/ui-kit/package.json`                                                          |
| File contains substring(s)     | `PROTECTED_CONTENT_INVARIANTS`    | Agent strips `@tailwind base` from `globals.css`                                                      |

`orchestrator/src/protected-files.ts` is the canonical source. The lists below are documentation; the TS module is what fires the check.

## Empirical motivator

reading-log-02 feat-066 v2 epic (2026-05-12): during multi-round `/fix-bugs` execution against the feat-068+073+087+088 detection stack, multiple iterations reported high resolution rates (~93-97% per metric). When the operator booted the dev-server to inspect the site mid-session, the page rendered RAW HTML with no Tailwind styling applied. Investigation showed:

- `apps/web/postcss.config.mjs` had been deleted by an in-loop dispatch.
- `@tailwind base; @tailwind components; @tailwind utilities;` had been stripped from `packages/ui-kit/src/styles/globals.css`.
- Manual recovery (recreate file + re-add directives + clear `.next` cache) immediately restored the v2 fixes' visual impact.

Pipeline-internal verification stages did not catch it:

1. **parity-verify** compares the built DOM against mockup DOM. Both unstyled-page-DOM and styled-page-DOM carry IDENTICAL class attributes (the classnames are typed in source code; only CSS resolution differs). DOM-diff sees no divergence.
2. **audit-computed-styles** would catch it but is not yet wired (bug-078).
3. **perceptual-reviewer** (feat-068) sees the visual regression in PNG comparison but routes findings under bug-087/088 back to `systemic-fixer` — the same dispatch class that caused the deletion. Compounding loop.
4. **Agent self-verify** runs `pnpm typecheck` + `pnpm test`. Neither exercises the CSS pipeline; both stay green.

The hole in the detection stack is what makes the source-side guard (this policy) load-bearing rather than redundant.

## Enforcement layers

| Layer    | Mechanism                                                                                                             | Consequence on violation                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Soft** | §Protected files block in `bug-fixer.md` + `systemic-fixer.md` system prompts                                         | Agent SHOULD flag concern instead of editing; relies on agent compliance.                                                               |
| **Hard** | `verifyProtectedFiles(worktreePath)` called by `runFixBugsLoop` after each per-bug dispatch, BEFORE the merge cascade | Attempt marked failed; merge cascade skipped (commit doesn't reach `fix/bugs-yaml-iter`); violation threaded into next retry's context. |

The soft layer covers the well-behaved case (agent reads its prompt and complies). The hard layer covers the case where the agent's reasoning concludes a deletion is the right call despite the prompt.

## What counts as a violation

Positive examples (allowed):

- ✓ ADDING a protected file that is currently missing (e.g. authoring `apps/web/postcss.config.mjs` per the `tooling-css-pipeline-broken` recipe — systemic-fixer's legitimate fix path).
- ✓ ADDING `@tailwind` directives to `globals.css` when they're absent.
- ✓ Removing a single unwanted LINE from a protected config (e.g. dropping `output: "export"` from `next.config.ts` for `tooling-config-mismatch`) — file stays present + non-empty.
- ✓ Editing the content of a protected file as long as ALL invariants still hold (file exists; required substrings still present).

Negative examples (rejected by `verifyProtectedFiles`):

- ✗ Deleting `apps/web/postcss.config.mjs` (or any other absolute-path entry).
- ✗ Renaming `postcss.config.mjs` → `postcss.cfg.mjs` (no first-match variant covers the new name).
- ✗ Deleting `packages/ui-kit/package.json` while leaving the directory in place.
- ✗ Stripping `@tailwind base` from `globals.css` (content invariant fails).
- ✗ Emptying `tailwind.config.ts` to an empty default export (depending on what scripted invariants land — v1 catches file-presence, future iterations may add content invariants here).
- ✗ Rewriting a protected config from scratch with the agent's own conventions when the existing scaffold could have been extended.

## Required dispatch behavior

When a `bug-fixer` or `systemic-fixer` dispatch suspects a protected file is causing a bug:

1. Read the file's current content and the bug's pre-loaded context.
2. If the fix is "add missing entry" or "remove one bad line" → proceed; the invariants will hold post-edit.
3. If the fix would require deleting or wholesale-rewriting a protected file → DO NOT do it. Return `taskOutcomes.<task-id>: "failed"` with the diagnostic naming the file + why deletion seemed necessary. The retry ladder or operator will route correctly.
4. Never delete a protected file as a "let me start clean" move. The scaffold author chose the existing content deliberately.

## What `verifyProtectedFiles` does on violation

(Reference: `orchestrator/src/fix-bugs-loop.ts` — the call site immediately follows the per-bug-dispatch return and precedes `closePerBugWorktree`.)

1. Lists all violations in one pass (one entry per failed invariant).
2. Marks the bug attempt `status: "failed"` via `transitionFailedDispatch` (the standard fail path; honors the convergence detector).
3. Skips `closePerBugWorktree`: the violating commit stays in the per-bug branch but never merges into `fix/bugs-yaml-iter`. bug-061's unconditional teardown-on-next-open recreates the worktree from a clean base on the next attempt.
4. Emits a structured stderr warning (`[fix-bugs-loop] WARNING: unit <id> dispatch violated protected files; rolling back...` + per-violation list).
5. Pushes one `[protected-files-violation] <path>: <reason>` entry per violation into `bug.errorLog`. The next retry's pre-loaded context surfaces these via `buildRetryContextMessage`, so the dispatched agent sees WHY its prior attempt was rejected.

## When this policy doesn't apply

- **Builder Mode B feature dispatches** — web-frontend-builder / backend-builder / mobile-frontend-builder lanes are governed by bug-023 (scaffold-owned files) + bug-024 (tester forbidden paths). Their dispatch paths don't currently route through `verifyProtectedFiles`. If a builder produces a protected-files violation, that surfaces during the reviewer dimension; this policy intentionally focuses on the fix-loop dispatchers because that's where the empirical regression class lives.
- **Operator-side hand edits** — outside the loop's purview. The operator may legitimately need to delete a protected file during diagnosis (e.g. to reproduce bug-077). That action is not governed by this policy.
- **Stack additions** — if a future project ships without `apps/web/` (e.g. mobile-only or backend-only), entries that don't match are silently OK. `verifyProtectedFiles` checks presence; absence of an `apps/web/` directory means there's nothing TO be missing, so no violation fires. The first-match-tuple shape (e.g. `postcss.config.{mjs,js,cjs,ts}`) handles per-project preferred-extension drift.

## Extending the manifest

When a new load-bearing config file class surfaces (e.g. a future Tailwind v4 config-less mode adopts a different file shape; a new stack-skill ships `metro.config.js` for React Native):

1. Add the path(s) to `PROTECTED_FILES` (or `PROTECTED_PACKAGES_FILES` / `PROTECTED_CONTENT_INVARIANTS` as appropriate).
2. Update the §Protected files block in both `bug-fixer.md` + `systemic-fixer.md` to mention the new class.
3. Update this rules doc's invariant-class table.
4. Add a regression test in `orchestrator/tests/protected-files.test.ts` covering the new entry.

Promotion to JSON manifest is deferred until the list exceeds ~30 entries OR a stack other than `react-next` needs distinct protected sets. v1's hardcoded TS shape is grep-able, type-checked, and tree-shakable; the indirection a JSON file would add isn't worth it at current scale.

## Cross-references

- **bug-091** — the bug plan that introduced this policy. `plans/active/bug-091-protected-files-guard.md`.
- **bug-077** — the empirical regression case. Without this guard, every `/fix-bugs` run risked reopening it.
- **bug-111** — extended the manifest with backend canonical app-entrypoints (`apps/api/src/api/main.py` / `apps/api/src/server.ts` / `apps/api/src/main.ts`). Empirical case: gotribe-tribe-directory 2026-05-15 shipped FastAPI backend with entry at `apps/api/src/main.py`; the 4-layer detection stack (builder self-verify / reviewer dim-1 / verifier pre-boot / fix-loop bug-classification) failed to catch it. This entry guards against the symmetric class — a fix-loop dispatch deleting the canonical entry from a project that previously had it.
- **bug-024** — architectural precedent for forbidden-paths enforcement on a different agent lane (tester). Three-layer pattern (agent prompt + rules doc + mechanical check) mirrored here.
- **bug-023** — scaffold-owned-files precedent for builder lanes. `PROTECTED_FILES` overlaps with bug-023's scaffold-owned list; both lanes complement each other.
- **bug-087 + bug-088** — perceptual-divergence routing to `systemic-fixer`. Routing UI findings to the higher-budget cross-file dispatcher is what makes this guard P0 (the empirical combo that produces config-file deletions).
- **feat-066 v2 epic** — Phase 1 alongside bug-089 (auto-merge silent fail) + bug-090 (verifier-freshness dedicated worktree). Together they restore honest verifier metrics.
- **investigate-021** — parity-verify silent-false-clean class. Complementary downstream detection layer; orthogonal to this source-side guard.
