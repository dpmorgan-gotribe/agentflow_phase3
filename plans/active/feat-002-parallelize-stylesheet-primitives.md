---
id: feat-002-parallelize-stylesheet-primitives
type: feature
status: draft
author-agent: Claude (Phase 3 build)
created: 2026-05-29
updated: 2026-05-29
parent-plan: null
supersedes: null
superseded-by: null
branch: feat/parallelize-stylesheet-primitives
affected-files:
  - .claude/skills/stylesheet-primitives/SKILL.md
  - scripts/audit-ui-kit-component-consistency.mjs
  - .claude/agents/ui-designer.md
  - orchestrator/src/stages-array.ts
  - packages/orchestrator-contracts/src/stages.ts
  - .claude/models.yaml
  - phase-plan.md
feature-area: mode-a-design-pipeline
priority: P1
attempt-count: 0
max-attempts: 5
---

# feat-002-parallelize-stylesheet-primitives: Fan-out primitive / pattern / layout authoring across N parallel ui-designer subagents

## Problem Statement

`/stylesheet-primitives` currently authors the entire React surface of `@repo/ui-kit` through **one sequential ui-designer agent**. Empirical wall-clock on `projects/test-app` (2026-05-29 run, observed live in another session):

- 12 mandatory primitives — 1h 1m (each primitive = ~5 min, 5 files: `.tsx` + `.variants.ts` + `.test.tsx` + `.stories.tsx` + `index.ts`)
- 23+ patterns so far + 11 canonical / custom remaining — projected another ~60 min
- 5 layouts — projected another ~15 min
- 022b artifacts + barrel + `package.json` rewrite + Storybook build + typecheck — projected another ~20 min
- **Total projected wall-clock: ~3h 30m – 4h** per project

The work is structurally fan-outable — primitives don't import each other; patterns/layouts only depend on primitives existing first; the sequential tail (barrel + Storybook) is a known-shape join step. A naive 8-wide fan-out collapses the ~3.5h to ~30–45 min.

**But naive fan-out reintroduces the drift class that bit `/screens`.** Prior art is unambiguous:

- **bug-002** (`/stylesheet` preview-coverage) — prose-only "render every component" → agents skipped → audit added (commit `43539af`)
- **bug-003** (`/screens` kit-content-bypass) — prose-only "consult patterns before inventing" → 86% drift across n=12 dispatches → verbatim-inline contract + audit added
- **bug-004** (`/screens` chrome consistency) — same root cause for footer-bg + dark-band text vocabulary
- **bug-005** (`/screens` D11 dark-on-dark detector) — same root cause for light-bg pattern inlined into dark sections
- **investigate-002** — "Prose-only consumer-side rules have a measured ≥75-86% drift rate on n=12 parallel ui-designer dispatches"

Without applying the same playbook — shared preamble inlining canonical bytes verbatim + per-component marker contract + post-batch mechanical audit + per-component retry loop — N parallel subagents will produce N inconsistent component implementations: `data-kit-component` missing on some, ad-hoc `className` switching instead of CVA on others, raw hex instead of token vars on a third subset, divergent test shape on a fourth. The kit's role as single source of truth for builders downstream collapses.

Implements factory operator quality-of-life (no brief.md at the factory level; this is a pipeline-skill improvement plan, not a project feature).

## Approach

Four-stage DAG that respects real dependencies, with the drift-mitigation playbook from `/screens` applied at each fan-out boundary.

### Stage 0 — Lib + agnostic verify + shared preamble assembly (sequential, ~1 min)

In `.claude/skills/stylesheet-primitives/SKILL.md` step 1a (already exists; extend it):

1. Verify `packages/ui-kit/src/lib/cn.ts` + `cva.ts` + `motion.ts` exist (authored by `/stylesheet`).
2. Verify `tokens.json` + `selected-style.json` + `.components-plan.json` exist.
3. **Write `vitest.config.ts` + `vitest.setup.ts` + `tsconfig.json` BEFORE the fan-out** (currently authored at step 1a; move outside the per-component loop so all subagents see them as a fact).
4. **Write devDeps + peerDeps into `package.json` BEFORE the fan-out** (currently step 6 rewrites the stub; move the devDeps additions earlier so any subagent that self-verifies its test file finds the harness ready). Keep the final full-form `package.json` rewrite at step 7 — this is a partial pre-write of devDeps only.
5. **Assemble the shared preamble** → `packages/ui-kit/.shared-preamble.md`. This is the canonical "starting ink" every subagent receives identically.

**Required preamble sections** (mirrors `/screens` step 3.5 structure):

a. **Authoring rules verbatim** — copy of SKILL.md §1e (cn + cva pattern, no raw hex, a11y minimums, server-vs-client defaults, test shape, version bump policy, `data-kit-*` attribute pass-through).

b. **`data-kit-*` attribute contract verbatim** — copy of SKILL.md §1b.1 (the feat-028 visual-parity contract). Inlined bytes, not "see §1b.1".

c. **`tokens.json` content verbatim** — full ~80 lines of token definitions so every subagent sees `tokens.radius.button` / `tokens.color.accent-500` / etc. directly without re-reading.

d. **`selected-style.json` content verbatim** — full style characteristics so every subagent picks the same radius / shadow / dark-mode behavior.

e. **`cn.ts` + `cva.ts` + `motion.ts` source verbatim** — so subagents see the canonical import pattern (`import { cn } from "../../lib/cn"`) rather than inventing relative paths.

f. **Per-target file shape contract** — exactly 5 files per component, canonical naming (`{kebab-name}/{kebab-name}.{tsx,variants.ts,test.tsx,stories.tsx} + index.ts`), barrel format (`export * from "./{kebab-name}"`).

g. **Canonical primitive marker table verbatim** — SKILL.md §1c table (12 mandatory primitives with required props/variants + style binding per the table).

h. **Canonical pattern marker table verbatim** — SKILL.md §2a table (12 canonical patterns + what they compose).

i. **Canonical layout marker table verbatim** — SKILL.md §3 table (5 layouts + their shape).

j. **Cross-component consistency contract** (new — analogue of `/screens` §3.5.2):

- Canonical relative import paths: `from "../../lib/cn"`, `from "../../tokens/tokens"`, `from "../{primitive-name}"` for pattern composition
- Canonical test imports: `from "@testing-library/react"` + `import "@testing-library/jest-dom/vitest"` only
- Canonical story imports: `from "@storybook/react"` + the component
- Canonical PascalCase mapping: `kebab-name → PascalName` is the file convention; no ad-hoc rewriting
- Canonical CVA usage: `cva(<base>, { variants: {...}, defaultVariants: {...} })` — no inline-conditional className switching
- Canonical `data-kit-component` value: PascalCase of the directory name, hard-coded as a string literal — never derived from a prop or computed

Write to `packages/ui-kit/.shared-preamble.md` (parallel to `_extracted/*.html` in the `/screens` shape). Idempotent: re-runs overwrite atomically.

### Stage 1 — Primitives fan-out (parallel, 8-wide, ~5–10 min wall-clock)

In SKILL.md, replace step 1c's "the subagent MUST author a .tsx + .test.tsx for each of these 12" prose with an explicit fan-out:

1. Build the primitive roster: 12 mandatory + N extended (from gate-3 `componentsApproved[]`).
2. For each primitive, prepare a dispatch envelope:
   - The shared preamble (`packages/ui-kit/.shared-preamble.md`) — read by the subagent at dispatch
   - The §1c row for THIS primitive (props, variants, style binding) — inlined in the dispatch prompt
   - The target directory path (`packages/ui-kit/src/primitives/{kebab-name}/`)
   - The 5-file contract restated for this primitive
   - The retry-context slot (empty on first attempt; populated with audit findings on retries)
3. **Dispatch via the Agent tool** with `subagent_type=ui-designer` at concurrency width `N` (default 8, see Stage 4's models.yaml knob).
4. **Wave-based execution**: spawn 8 agents → wait for all returns → spawn next 8 → ... Each agent takes ~30–60s for one 5-file primitive.
5. **Observability**: emit a progress line after each wave returns: `primitive wave {N}: {W} completed · {T}/{TOTAL} total`.

**Per-subagent self-verify** (mirrors `/screens` step 7 anti-slop):

- All 5 files exist with non-empty content
- `.tsx` exports a function named the PascalCase of the directory
- Root element string-literal-contains `data-kit-component="<PascalName>"` (grep — not a runtime check)
- Test file string-literal-contains `data-kit-component` assertion
- No raw hex in `.tsx` (excluding `data:image/svg+xml` URIs)
- `.variants.ts` (if present) calls `cva(`

If any check fails, the subagent retries once internally before returning `success: false`.

### Stage 2 — Post-stage-1 mechanical audit + retry loop (parallel, ~1–3 min wall-clock)

After Stage 1's final wave returns, invoke the new factory script:

```bash
node $FACTORY_ROOT/scripts/audit-ui-kit-component-consistency.mjs --tier primitives
```

The script (project-agnostic; mirrors `audit-screen-pattern-consumption.mjs` shape) reads each project's own `.components-plan.json` + `.shared-preamble.md` and verifies these drift dimensions across every primitive directory:

| Dim                                  | Check                                                                                                                                                      | Pass condition            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----- | ---------------------- | --- | ---- | --------- |
| **D-A** All 5 files present          | `.tsx + .variants.ts + .test.tsx + .stories.tsx + index.ts` (`.variants.ts` optional for single-variant primitives like FormField — flagged in plan-table) | 0 missing                 |
| **D-B** PascalCase export            | `.tsx` exports a function whose name matches the directory's PascalCase                                                                                    | 0 mismatches              |
| **D-C** `data-kit-component` literal | Root rendered element has the string literal `data-kit-component="<PascalName>"` (hard-coded, not derived)                                                 | 0 missing                 |
| **D-D** Variant forwarding           | If primitive declares `variant` prop, root has `data-kit-variant={variant}`; same for `size`                                                               | 0 missing                 |
| **D-E** CVA usage                    | `.variants.ts` calls `cva(` AND `.tsx` imports the variants function — not ad-hoc className switching                                                      | 0 violations              |
| **D-F** No raw hex                   | `.tsx` contains no `#[0-9A-Fa-f]{3,8}` literals (excluding `data:image/svg+xml`)                                                                           | 0 leaks                   |
| **D-G** Test shape                   | Test file imports `@testing-library/react`; ≥3 test cases including one `data-kit-component` assertion                                                     | 0 violations              |
| **D-H** Story shape                  | Story file `export default { component: <Name>, ... }` + ≥1 named export per major variant                                                                 | 0 violations              |
| **D-I** Canonical imports            | `import { cn } from "../../lib/cn"` (not `from "@repo/ui-kit/lib/cn"` or invented path); same for `cva` + `tokens`                                         | 0 deep / invented imports |
| **D-J** Required props/variants      | Per §1c roster row, all listed props/variants are present (e.g. Button has `variant: primary                                                               | secondary                 | ghost | destructive`×`size: sm | md  | lg`) | 0 missing |
| **D-K** Class composition via cn()   | `.tsx` className is built via `cn(...)` — never concatenated by hand or built via template strings outside cn                                              | 0 violations              |

**Retry contract:**

1. For each primitive in `failedComponents[]`, re-dispatch a ui-designer subagent with `--component primitives/{kebab-name}` plus the audit's per-dimension findings as retry context. The retry prompt explicitly names the missing markers ("your `Button.tsx` root element is missing `data-kit-component="Button"` — add the literal `data-kit-component="Button"` to the `<button>` root, do not derive from a prop").
2. Max 2 retries per primitive. After 2 failures, mark the primitive `needsHumanReview`.
3. Once all primitives pass OR have hit max retries, advance to Stage 3.

**Hard abort if <12 mandatory primitives pass.** The existing refactor-006 hard gate (SKILL.md step 8) moves earlier in the flow — runs at the end of Stage 2, blocking Stage 3 if it fires.

### Stage 3 — Patterns + Layouts fan-out (parallel, 8-wide, ~10–15 min wall-clock)

Gated on Stage 2 passing. Identical mechanics to Stage 1, with:

- Roster = 12 canonical patterns (§2a) + N custom patterns (from `.components-plan.json.customPatternsGenerated[]`) + 5 canonical layouts (§3).
- Per-component dispatch envelope adds a **"compose, don't atomize" reminder**: patterns import canonical primitives via `from "../../primitives/{primitive-name}"`; never inline an atomic.
- Post-fan-out audit runs `--tier patterns-and-layouts` with these additional dimensions:

| Dim                                 | Check                                                                                                           | Pass condition      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| **D-L** Pattern composes primitives | Pattern `.tsx` has ≥1 import from `../../primitives/*` (or top-level barrel) — not inventing its own `<button>` | 0 atomized patterns |
| **D-M** Layout `data-kit-component` | Same as D-C for layouts                                                                                         | 0 missing           |
| **D-N** Custom patterns named       | Every entry in `.components-plan.json.customPatternsGenerated[]` has a corresponding directory                  | 0 missing           |

Same retry loop as Stage 2, max 2 retries per component.

### Stage 4 — Sequential tail (single agent, ~10–20 min wall-clock)

This is the existing SKILL.md steps 4 (022b artifacts) + 5 (barrel) + 6 (package.json full rewrite) + 7 (Storybook build) + 8 (finalize/verify), unchanged structurally. Runs as ONE agent since:

- The barrel `src/index.ts` needs the final list of all primitive/pattern/layout directories — single source-of-truth file
- The `package.json` rewrite is one file with the full exports map
- Storybook build is a single `pnpm build-storybook` invocation
- `pnpm typecheck` + `pnpm lint` are single invocations
- The `≥12 primitives shipped` hard gate has already fired at end of Stage 2

The bug-029 `data-kit-component` retrofit codemod stays in Stage 4 — it's the safety net for any Stage-1 subagent that missed the attribute despite the audit (rare, but defense-in-depth).

### Configuration knob

Extend `~/.claude/models.yaml` schema (and the factory's `.claude/models.yaml`):

```yaml
stages:
  stylesheet-primitives:
    concurrency: 8 # default — mirrors /screens
    maxConcurrency: 16 # absolute cap
    burstDelay: 0 # ms between waves on rate-limit warnings
```

Same shape as `/screens` (already shipped). Same plumbing through `orchestrator/src/stages-array.ts` if that's where /screens reads its knob (verify in implementation).

### Output contract extension

`packages/orchestrator-contracts/src/stages.ts` — the `StylesheetOutput` schema (covers both `/stylesheet` and `/stylesheet-primitives` return JSONs) extends to include:

```ts
failedComponents: Array<{
  tier: "primitive" | "pattern" | "layout";
  name: string; // kebab directory name
  dimensions: string[]; // e.g. ["D-C", "D-G"]
  retryAttempts: number; // 0..2
  needsHumanReview: boolean;
}>;
```

Backward-compatible: existing callers that don't read `failedComponents` are unaffected; if all components pass, the array is empty.

### Phase-plan §F update

Per CLAUDE.md "Rebuild guarantee", add a paragraph to `phase-plan.md` §F documenting:

- The four-stage DAG (lib+preamble / primitives fan-out / patterns+layouts fan-out / sequential tail)
- The shared-preamble + verbatim-inline contract (drift mitigation)
- The audit script + per-component retry loop
- The concurrency knob (models.yaml)
- The cross-reference back to bug-003 / bug-004 / bug-005 / investigate-002 as the empirical motivator

## Rejected Alternatives

- **Alternative A — Keep sequential authoring** — Rejected because: ~3.5h wall-clock per project for a kit that's structurally fan-outable is hostile to operator iteration. 12 primitives + 24+ patterns + 5 layouts × ~5 min each = the observed wall-clock. Naive concurrency = 8 fan-out collapses this to ~30–45 min.

- **Alternative B — Concurrent Write calls in a single agent turn (no subagents)** — Rejected because: requires one planning agent to hold the full content of all 30+ components in its context window before any are written. Each component = ~150–300 lines × 5 files = ~750–1500 lines; 30 components = 22k–45k generated lines held in one context. Doesn't fit cleanly AND removes the parallelism benefit (still one model turn end-to-end).

- **Alternative C — Use git worktrees per primitive (mirror Mode B's pattern)** — Rejected because: worktrees solve the "two writers might conflict on the same file" problem. Primitives live in disjoint directories so they cannot conflict; worktree overhead (~5–10s spawn × 12 + merge logic) buys nothing here. /screens' fan-out doesn't use worktrees for the same reason.

- **Alternative D — Drop the audit script + trust the agents** — Rejected because: empirical from bug-002 / bug-003 / bug-004 / bug-005 / investigate-002 measured a **75-86% drift rate** for prose-only consumer-side rules across n=12 parallel ui-designer dispatches. The audit is the load-bearing fix per the LESSONS.md "Consumer-side rules in skill bodies need mechanical audits when shipped" entry. Without the audit, fan-out trades a 3.5h consistent run for a 45 min inconsistent run that needs operator triage downstream.

- **Alternative E — Fan-out without the shared preamble (each agent reads source files directly)** — Rejected because: bug-003's empirical case showed agents WHO READ THE SOURCE FILE then write their own version (the "consult before inventing" prose). The shared preamble MUST inline canonical bytes (tokens.json, cn.ts, cva.ts source, §1c table, §2a table, §3 table) verbatim — agents see the bytes, agents reuse the bytes. This is the bug-003 v2 → final fix mechanic.

- **Alternative F — Single-stage fan-out (primitives + patterns + layouts all in one wave)** — Rejected because: patterns compose primitives via `import { Button } from "../primitives/button"`. If primitives haven't shipped when a pattern subagent runs, the import fails / the audit's D-L check fails. The two-stage DAG respects this real dependency; the cost is one extra audit + retry boundary (~3 min) per project.

- **Alternative G — Author the audit later as a follow-up bug (ship fan-out first, harden later)** — Rejected because: shipping fan-out without the audit re-introduces exactly the drift class bug-003 closed. The factory's LESSONS.md entry "Consumer-side rules in skill bodies need mechanical audits when shipped, not retroactively" was promoted specifically because the retroactive pattern bites. We pay the audit cost up-front or we pay it 10× later in operator triage.

## Expected Outcomes

- [ ] `/stylesheet-primitives` completes in ≤45 min wall-clock on `projects/test-app` at default `concurrency=8` (measured against the current ~3.5h baseline)
- [ ] All 12 mandatory primitives + ≥12 canonical patterns + 5 layouts ship with byte-identical file shape across components (5 files per component, canonical barrel format, canonical relative imports)
- [ ] New `scripts/audit-ui-kit-component-consistency.mjs` exits 0 on test-app post-run; project-agnostic (no test-app-specific config); supports `--tier primitives|patterns-and-layouts|all` + `--dimension D-A..D-N|all` + `--json` + `--strict` flags
- [ ] Negative-regression test passes: artificially edit one primitive to strip `data-kit-component` → audit exits 1, names the primitive + dimension D-C
- [ ] models.yaml `stages.stylesheet-primitives.{concurrency,maxConcurrency,burstDelay}` knob controls fan-out width; verified at `concurrency=4` (slower) + `concurrency=8` (default) + `concurrency=16` (max)
- [ ] Re-running on unchanged inputs is still a no-op (idempotency preserved from current skill — `.input-fingerprint-primitives.json` short-circuit at top of step 1)
- [ ] `StylesheetOutput.failedComponents[]` populated correctly when subagents fail; empty when all pass; backward-compatible with existing consumers
- [ ] `phase-plan.md` §F paragraph documents the four-stage DAG + shared-preamble + audit + retry loop + concurrency knob (Rebuild guarantee preserved)

## Validation Criteria

**Empirical reproduction** — Re-run `/stylesheet-primitives` on `projects/test-app` AFTER the in-flight sequential run completes (do not disturb the running session). Target run AFTER the feature ships:

- Wall-clock at `concurrency=8`: ≤45 min (down from observed ~3h 30m)
- `node scripts/audit-ui-kit-component-consistency.mjs` exits 0 with all dimensions clean
- Visual eyeball: every primitive Storybook story renders the same data-kit attribute set; every pattern composes primitives (no atomic reinvention); every layout carries the `data-kit-component` attr

**Drift dimension coverage** — Audit script covers dimensions D-A through D-N. Each is independently testable via `--dimension D-X`.

**Cross-project agnostic** — Run audit on a hypothetical second project with different primitive roster (e.g. 10/12 mandatory + 3 extended). Reports per-project drift correctly; no test-app-specific assumptions.

**Retry loop validation** — Dispatch one ui-designer subagent with a deliberately broken prompt (e.g. instruct it to use `className=` concatenation instead of cn) → audit fails on that component with dimensions D-E + D-K → orchestrator re-dispatches with audit findings as retry context → second attempt passes → final return JSON has `failedComponents[].length === 0`.

**Hard gate preserved** — refactor-006's `≥12 mandatory primitives shipped` gate still fires. Validate by deliberately failing ≥2 primitive subagents past max retries → SKILL emits `success: false` with `primitives-shipped-gate-failed` error.

**Backward compatibility** — Existing manual-invocation flow (`operator runs /stylesheet-primitives` directly) still works. Existing orchestrator auto-fire post-`/architect` (feat-074 Phase E) still works. Existing `noChange: true` short-circuit on unchanged inputs still works.

**Phase-plan §F adoption** — `/sync-phase-plan` accepts the §F addition without conflict; `phase-plan.md` litmus test (`git checkout phase-N-start && rebuild from phase-plan.md`) reproduces the four-stage DAG.

**Cost regression check** — Total token spend per `/stylesheet-primitives` run should be **within 1.2× of the sequential baseline**. Parallelism keeps wall-clock down but each subagent re-reads the shared preamble — prompt-cache hits (per `ENABLE_PROMPT_CACHING_1H=1`) should make the cache-read tokens cheap; net cost should be near-flat. If cost rises >1.2×, investigate cache-hit rate.

**Cross-references:**

- bug-002 — sibling drift class for `/stylesheet` preview-coverage (audit + skill-body table pattern this plan inherits)
- bug-003 — primary empirical motivator for the verbatim-inline + audit + retry loop pattern (`/screens` kit-content-bypass)
- bug-004 + bug-005 — sibling drift classes that share the audit + retry mechanism (`/screens` chrome consistency + dark-band text)
- investigate-001 — Phase 3 quality regression vs Phase 2 (H1–H8 cover dispatch context / MCP scope / model effort — all apply equally to a fan-out implementation)
- investigate-002 — drift survey methodology + measured 75-86% drift rate
- feat-074 — the orchestrator wiring that auto-fires this skill post-`/architect`; parallelization keeps the wall-clock budget the feat-074 split was meant to recapture
- refactor-006 — `≥12 mandatory primitives shipped` hard gate (preserved; moved to end of Stage 2)
- feat-028 — visual-parity verifier consumes `data-kit-*` attrs authored here (drift dimension D-C / D-D guards the contract)

**LESSONS.md entry to capture on close:**

Title: _"Parallel-dispatch skills must ship the bug-003 drift-mitigation playbook on day 1 — fan-out without it has measured 75-86% drift across n=12 dispatches"_

Pattern: when a Mode A skill goes from sequential → fan-out, the load-bearing artifacts are not the fan-out plumbing (~50 LoC of Agent-tool concurrency) but the shared-preamble assembly + post-batch audit script + per-component retry loop. Skipping these is a false economy — fan-out without them ships an inconsistent kit that costs operator triage downstream.

## Attempt Log

<!-- Populated automatically by agents. -->

## Operator notes

- Operator observed live `/stylesheet-primitives` run on test-app at 2026-05-29 lasting ~3h 30m (still in flight at plan creation time; do not disturb).
- Empirical motivation comes from the user's question "could we parallelize this work so it doesnt take an entire day to run?" + their direction "consider how we ensure consistency across subagents — we just had similar drift in screens so that is a skill to look at also check the other investigations and bugs as they would have touched this scope".
- Branch creation deferred to implementation time so the in-flight run isn't disturbed. When approved, the implementer should `git checkout -b feat/parallelize-stylesheet-primitives` only after confirming the in-flight session has completed.
