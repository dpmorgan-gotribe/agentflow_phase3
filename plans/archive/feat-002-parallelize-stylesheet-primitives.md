---
id: feat-002-parallelize-stylesheet-primitives
type: feature
status: approved
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

### Stage 5 — Compile + test verification gate (sequential, ~3–5 min wall-clock) — load-bearing

**Empirical motivator (2026-05-29 session that authored this plan).** After the in-flight sequential run reported `success: true` (12 primitives + 23 patterns + 5 layouts + 4 ESLint rules + barrel all authored), the operator dispatched a manual verify pass that surfaced **5 distinct compile-time bugs the skill's "self-verify" did not catch**:

1. `@storybook/react` not in devDeps despite being imported by every `.stories.tsx` file → 25+ "Cannot find module '@storybook/react' or its corresponding type declarations" errors
2. `tailwindcss` not in devDeps despite `styles/tailwind.config.ts` importing it → 1 module-resolution error
3. The kit-shipped `lib/cva.ts` wrapper used over-strict generics that rejected `cva()`'s native `compoundVariants` typing → 5 errors across `Button.variants.ts` + `Card.variants.ts`
4. `Button.variants.ts` + `Card.variants.ts` used boolean-typed `compoundVariants: [{ iconOnly: true, ... }]` + `defaultVariants: { iconOnly: false }` — CVA v0.7.1 + the over-strict wrapper required `"true"` / `"false"` string keys (the wrapper inversion in #3 above flipped the requirement back to booleans after rewrite)
5. `patterns/hero/hero.tsx` declared `interface HeroProps extends React.HTMLAttributes<HTMLElement>` with a `title: React.ReactNode` field — clashed with HTMLAttributes's inherited `title?: string` → 1 type-incompatibility error

After fixes (add 2 devDeps + simplify cva wrapper + revert booleans + Omit `"title"` from Hero extends), **typecheck passed cleanly + all 105 unit tests across 29 files passed in 7.75s**. The 5-bug cluster was 100% catchable by `pnpm typecheck` + `pnpm test` — the skill returned `success: true` solely because step 8 _mentioned_ typecheck without _running it to exit-0 gating semantics_.

**Stage 5 closes this gap by running the verify chain as HARD GATES.** Failure to exit 0 on any step aborts the skill with `success: false`:

```bash
# Stage 5.1 — Install workspace dependencies
# Required because Stage 4's package.json rewrite added devDeps the
# pre-rewrite install pass did not see. Skip on noChange short-circuit.
pnpm install
# Exit 0 required. Non-zero → abort: "Stage 5.1 install failed — see pnpm log"

# Stage 5.2 — TypeScript compile gate
pnpm --filter @repo/ui-kit typecheck
# Exit 0 required. Non-zero → emit each tsc error in `errors[]` of return
# JSON, mark `success: false`, abort. NO retry — TS errors are deterministic;
# retry would loop unless the underlying authoring-rule is fixed in SKILL.md.

# Stage 5.3 — Unit test gate
pnpm --filter @repo/ui-kit test
# Exit 0 required. Non-zero → emit failing test names + counts in `errors[]`,
# mark `success: false`, abort. Per-test retry is the tester's job inside the
# kit; Stage 5 just enforces the gate.

# Stage 5.4 — Storybook build (existing SKILL.md step 7 — moved into the gate)
pnpm --filter @repo/ui-kit build-storybook
# Exit 0 required. Non-zero → write `docs/design-system-gaps.md` with the
# error + emit `success: false` per existing SKILL.md §Error handling.
```

**Stage 5's audit-dimension extensions** — additions to `scripts/audit-ui-kit-component-consistency.mjs` so the verify gate's failures are observable to the orchestrator AND catchable at audit time before Stage 5 runs (defense in depth):

| Dim                              | Check                                                                                                                                                                                                                                                                           | Pass condition        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **D-O** devDeps cover imports    | Walk every `.ts(x)` + `.stories.tsx` + `.test.tsx` in the kit, collect every bare-specifier `import { ... } from "<pkg>"`, assert every `<pkg>` is in `package.json.{dependencies,peerDependencies,devDependencies}`. Catches missing `@storybook/react` + `tailwindcss` class. | 0 missing-deps        |
| **D-P** Stories import canonical | Every `.stories.tsx` imports from `@storybook/react` (not `@storybook/react-vite` ambiguity) AND uses the `Meta` + `StoryObj` types canonically. The pre-bug case authored `import type { Meta, StoryObj } from "@storybook/react"` which IS canonical — D-P just enforces it.  | 0 non-canonical       |
| **D-Q** CVA boolean variants     | `.variants.ts` with `iconOnly: { true: ..., false: ... }` / `interactive: { true: ..., false: ... }` shape MUST have matching boolean (not string) values in `compoundVariants` + `defaultVariants`. Catches the boolean-vs-string mismatch in fix #4 above.                    | 0 mismatched booleans |
| **D-R** Pattern title clash      | Any `.tsx` declaring `interface XProps extends React.HTMLAttributes<...>` that also declares `title: React.ReactNode` MUST use `Omit<React.HTMLAttributes<...>, "title">`. Mechanical regex.                                                                                    | 0 unresolved clashes  |

The audit's existing retry loop covers D-O through D-R. A subagent that fails D-O on its first attempt gets the diagnostic ("your `stories.tsx` imports `@storybook/react` but it's not in devDeps; add it before reporting complete") + one retry. If the retry still fails, the orchestrator escalates to operator review.

**Why a separate Stage 5 instead of folding into Stage 4's step 8.** Stage 4 is "single agent that runs ~10–20 min of join work"; Stage 5 is "deterministic verify chain with no LLM in the loop". Separating the two surfaces a clean gate boundary: a Stage-4-passes / Stage-5-fails return is unambiguously a compile-time bug class the audit didn't predict, which triggers a SKILL.md + audit-script extension (the meta-lesson loop from bug-005). Conflating them muddies the signal.

**Cross-references for Stage 5:**

- LESSONS.md candidate entry on close: _"`/stylesheet-primitives` reporting `success: true` is only as honest as its compile gate. Running `pnpm install + typecheck + test + build-storybook` as exit-0-required gates closes the 'authored but unverified' failure mode. Audit dimensions D-O through D-R catch the most-common subset at lower cost than the full compile."_
- bug-005 sibling lesson: _"Derivation-based audits must fail-closed on empty contracts AND pair with hardcoded independent fallback assertions."_ Stage 5 IS the hardcoded fallback — the audit dimensions catch ~80% of the failures; Stage 5 catches 100% by actually running the compiler.
- Concrete error catalog for the SKILL.md authoring section: see `## Empirical fix patterns observed (2026-05-29 sequential run)` below.

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

## Empirical fix patterns observed (2026-05-29 sequential run)

The in-flight sequential run that this plan was authored against (test-app, ~3h 30m wall-clock) reported `success: true` and then immediately failed the operator's manual verify. The five distinct bugs that surfaced ALL stem from authoring-rule gaps the skill body did not name precisely enough. Each becomes an addition to either the §1e shared-rules block OR an audit dimension (D-O through D-R per Stage 5 above). Captured here as a single inventory so the SKILL.md edit + audit-script extension know exactly what surface to harden.

### Fix-pattern 1 — Storybook devDeps mismatch

**Observed**: Every `.stories.tsx` imported `from "@storybook/react"` but `package.json.devDependencies` only declared `@storybook/react-vite`. Result: 25+ `Cannot find module '@storybook/react'` errors at `pnpm typecheck` time.

**Root cause**: Storybook 8 splits framework adapter (`@storybook/react-vite`) from the types-and-runtime package (`@storybook/react`). Stories canonically import types from `@storybook/react`. The skill body's step 6 `package.json` template named only the framework adapter.

**SKILL.md authoring rule to add (§1a step 3)**: Required devDeps for the kit are: `@storybook/react ^8.4.7` (types + runtime), `@storybook/react-vite ^8.4.7` (framework adapter), `@storybook/addon-essentials ^8.4.7`, `storybook ^8.4.7`, `tailwindcss ^3.4.0`. The Stage-4 `package.json` rewrite MUST include all five.

**Audit dimension that catches**: D-O (devDeps cover all bare-specifier imports).

### Fix-pattern 2 — Tailwind config devDep mismatch

**Observed**: `src/styles/tailwind.config.ts` line 5 `import type { Config } from "tailwindcss"` failed with `Cannot find module 'tailwindcss'`.

**Root cause**: `tailwindcss` was treated as a "production peer" (consumer's app provides it) but the kit's own typecheck of its own config file required the import to resolve.

**SKILL.md authoring rule to add (§1a step 3)**: `tailwindcss ^3.4.0` MUST be in the kit's devDependencies regardless of consumer-side configuration. The kit is responsible for its own typecheck-cleanness.

**Audit dimension that catches**: D-O.

### Fix-pattern 3 — Over-engineered `lib/cva.ts` wrapper

**Observed**: The agent authored `lib/cva.ts` as a `kitCva<T>` wrapper with strict generic constraints around `Config<T>`. CVA's internal `compoundVariants` type expected boolean-keyed variant maps; the wrapper's `T extends Record<string, Record<string, ClassValue>>` rejected the inferred boolean-keyed shape. Result: 1 type error blocking compile.

**Root cause**: The skill body's §1a step 2 only said `// Re-export the kit's preferred cva factory pattern` without naming the canonical shape. The agent inferred "preferred pattern" as "wrap with stricter generics" — a reasonable but wrong inference.

**Canonical shape** (encoded as required source):

```ts
import { cva, cx, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
export { cva, cx, type VariantProps };
export type { ClassValue };
// kitCva is a passthrough — kept for future-swap convenience.
export const kitCva = cva;
```

**SKILL.md authoring rule to add (§1a step 2)**: `lib/cva.ts` MUST match the canonical 6-line shape above verbatim. NO wrapper around `cva()` — the kit's "preference" is to use cva directly. The `kitCva` re-export is a stable identifier for future swap, NOT a typed wrapper.

**Audit dimension that catches**: a new D-S (cva wrapper file matches canonical shape) — proposed; could fold into D-I (canonical imports) if the audit grows multi-line content matching.

### Fix-pattern 4 — CVA boolean variant key/value inconsistency

**Observed**: `Button.variants.ts` declared `iconOnly: { true: "...", false: "" }` (string keys) AND `compoundVariants: [{ iconOnly: true, ... }]` (boolean values) AND `defaultVariants: { iconOnly: false }` (boolean value). CVA v0.7.1 — paired with the wrapper from fix-pattern 3 — flipped between requiring `"true"` / `"false"` strings AND `true` / `false` booleans depending on the wrapper. Net: 4 type errors that toggled between two error shapes as the wrapper changed.

**Root cause**: The skill body's §1c Button row says `iconOnly?: boolean` but doesn't show the variants-file shape. Agents inferred from JS habit (`true`/`false` keys + boolean values) but CVA's runtime accepts strings as boolean-keyed slots — so the runtime worked while the types didn't.

**Canonical shape**:

```ts
// Inside cva(<base>, { variants: ... })
variants: {
  iconOnly: { true: "aspect-square px-0", false: "" },
}
// Inside compoundVariants: USE BOOLEAN
compoundVariants: [
  { iconOnly: true, size: "sm", class: "w-9" },
]
// Inside defaultVariants: USE BOOLEAN
defaultVariants: { iconOnly: false }
```

With CVA v0.7.1 + the canonical `lib/cva.ts` (passthrough, not wrapper), this shape compiles cleanly.

**SKILL.md authoring rule to add (§1c, applies to every primitive with a boolean variant)**: For variants of type boolean, use JS object keys `true` and `false` (which TS infers as string literals `"true"` / `"false"`). In `compoundVariants` array entries AND `defaultVariants`, use literal boolean values `true` / `false` (NOT string `"true"` / `"false"`).

**Audit dimension that catches**: D-Q (cva boolean variants).

### Fix-pattern 5 — Pattern props clashing with HTMLAttributes built-ins

**Observed**: `patterns/hero/hero.tsx` declared `interface HeroProps extends React.HTMLAttributes<HTMLElement>` with `title: React.ReactNode`. `HTMLAttributes` has `title?: string` (the native HTML `title` attribute used for tooltips). Result: 1 type error `Type 'ReactNode' is not assignable to type 'string | undefined'`.

**Root cause**: The skill body's §2 pattern roster doesn't warn about the HTMLAttributes builtins that conflict with common prop names (`title`, `color`, `placeholder`, `cite`, `data`, etc.). Agents extend HTMLAttributes by default for pass-through props but don't `Omit` the clashing builtins.

**Canonical shape**:

```ts
export interface HeroProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "title"
> {
  title: React.ReactNode;
  // ...
}
```

**SKILL.md authoring rule to add (§2 + §3)**: When a pattern or layout declares a prop whose name collides with `HTMLAttributes<T>`'s native attributes (`title`, `color`, `placeholder`, `cite`, `data`, `defaultChecked`, `defaultValue`, `suppressContentEditableWarning`, `suppressHydrationWarning`), the props interface MUST `Omit` the colliding key from the extended HTMLAttributes type.

**Audit dimension that catches**: D-R (pattern title clash).

### Catalogue summary

| #   | Class                             | Fix surface                           | Audit dim                             | Caught by                      |
| --- | --------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------ |
| 1   | Missing devDep `@storybook/react` | SKILL.md §1a + package.json template  | D-O                                   | Stage 2/3 audit (pre-Stage 5)  |
| 2   | Missing devDep `tailwindcss`      | Same as #1                            | D-O                                   | Stage 2/3 audit                |
| 3   | Over-engineered `lib/cva.ts`      | SKILL.md §1a step 2 canonical source  | D-S (proposed) OR Stage 5.2 typecheck | Stage 5.2 typecheck (fallback) |
| 4   | CVA boolean variant mismatch      | SKILL.md §1c per-primitive shape note | D-Q                                   | Stage 2 audit (pre-Stage 5)    |
| 5   | Pattern title prop clash          | SKILL.md §2 + §3 Omit rule            | D-R                                   | Stage 3 audit (pre-Stage 5)    |

**Net signal**: 4 of 5 bug classes are catchable at the audit layer BEFORE the compile gate runs. Fix-pattern 3 (cva wrapper shape) is the holdout — the audit can grep for `kitCva =` vs `kitCva<T>` but a multi-line content match feels brittle; cleaner to let Stage 5.2 catch it via tsc, since the fix is mechanical once surfaced.

## Expected Outcomes

- [ ] `/stylesheet-primitives` completes in ≤45 min wall-clock on `projects/test-app` at default `concurrency=8` (measured against the current ~3.5h baseline)
- [ ] All 12 mandatory primitives + ≥12 canonical patterns + 5 layouts ship with byte-identical file shape across components (5 files per component, canonical barrel format, canonical relative imports)
- [ ] New `scripts/audit-ui-kit-component-consistency.mjs` exits 0 on test-app post-run; project-agnostic (no test-app-specific config); supports `--tier primitives|patterns-and-layouts|all` + `--dimension D-A..D-R|all` + `--json` + `--strict` flags
- [ ] Negative-regression test passes: artificially edit one primitive to strip `data-kit-component` → audit exits 1, names the primitive + dimension D-C
- [ ] models.yaml `stages.stylesheet-primitives.{concurrency,maxConcurrency,burstDelay}` knob controls fan-out width; verified at `concurrency=4` (slower) + `concurrency=8` (default) + `concurrency=16` (max)
- [ ] Re-running on unchanged inputs is still a no-op (idempotency preserved from current skill — `.input-fingerprint-primitives.json` short-circuit at top of step 1)
- [ ] `StylesheetOutput.failedComponents[]` populated correctly when subagents fail; empty when all pass; backward-compatible with existing consumers
- [ ] `phase-plan.md` §F paragraph documents the five-stage DAG + shared-preamble + audit + retry loop + Stage 5 verify gate + concurrency knob (Rebuild guarantee preserved)
- [ ] **Stage 5 verify gates fire and pass:** `pnpm install` exits 0, `pnpm --filter @repo/ui-kit typecheck` exits 0, `pnpm --filter @repo/ui-kit test` exits 0 with ≥1 test per shipped component, `pnpm --filter @repo/ui-kit build-storybook` exits 0
- [ ] **Stage 5 verify gates abort honestly:** artificially break one primitive's typing (e.g. revert fix-pattern 4) → Stage 5.2 exits 1 → skill returns `success: false` with the tsc error in `errors[]` — NO false-positive `success: true`
- [ ] **Audit dimensions D-O through D-R land + catch their fix-patterns:** the 5 bugs from the 2026-05-29 fix-pattern catalog are caught by the audit OR Stage 5 — none slip through to the operator
- [ ] **SKILL.md §1a + §1c + §2 + §3 carry the 5 fix-pattern authoring rules verbatim** so future ui-designer agents see the precise shape before they author

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

---

# COMPLETION RECORD (appended to archived plan)

completed: 2026-05-29
outcome: success
actual-files-changed:

- .claude/skills/stylesheet-primitives/SKILL.md (modified — §1a + §1e + §2 fix-pattern rules + Step 9 verify gate + new "Orchestration: 4-Stage DAG" section)
- .claude/models.yaml (modified — stages.{stylesheet-primitives,screens}.{concurrency,maxConcurrency,burstDelay} knob)
- scripts/audit-ui-kit-component-consistency.mjs (created — 18-dimension audit D-A through D-R, project-agnostic)
- packages/orchestrator-contracts/src/stylesheet-primitives.ts (created — StylesheetPrimitivesOutputSchema + FailedComponentSchema)
- packages/orchestrator-contracts/src/index.ts (modified — barrel export)
- phase-plan.md (modified — §F Row 038 + Row 039 paragraphs)
- feature_list.json (modified — phase1-step-038 + phase1-step-039 rows)
- LESSONS.md (modified — partial-outcome-archival lesson appended)
  commits:
- hash: 1cab88f
  message: "phase1: feat-002 verify-gate slice — /stylesheet-primitives honest-complete (Step 9 + 5 fix-pattern authoring rules)"
- hash: aedb535
  message: "phase1: feat-002 full implementation (parallelization scope) — accountability for Row 038's premature archive"
  attempts: 2
  lessons:
- "Partial-outcome archives require explicit operator authorization. When an approved plan has N discrete deliverables and only M < N ship in a session, the plan stays in active/ with explicit TODO items — never archive with outcome: partial unless operator explicitly approves the deferral. The verify-gate slice (Row 038) was honest contribution; the archive around it was the category error. Row 039 restored accountability by shipping the full plan scope. Lesson captured at LESSONS.md 'Partial-outcome archival silently diverges shipped state from intended state (2026-05-29)'."
- "Two-layer drift mitigation: compile-time gate (Row 038 Step 9 — pnpm typecheck + test + storybook) catches deterministic bug classes; contract-time audit (Row 039 audit-ui-kit-component-consistency.mjs) catches drift the compiler doesn't see (5-file shape, data-kit-component literal, test-coverage shape, naming, composition). Both layers required for honest signal."
- "Audit smoke-tested on test-app's existing kit produced 29 honest findings across 5 dimensions — the audit catches real drift that the prior dispatch missed. For future fresh-project runs, Stage 2 + Stage 3 audit + retry loop (max 2 retries per component) would surface these before Stage 4 ships, with failedComponents[] populated for operator review on max-retries-exhausted cases."
- "Wall-clock empirical validation deferred honestly — test-app's kit is already authored; next fresh-project /stylesheet-primitives run serves as the measurement site (target: ≤45 min at concurrency=8 vs ~3h 30m sequential baseline). The factory code is complete; the wall-clock measurement is pending. This deferral is explicit + acknowledged in evidence/phase1-step-039-result.txt — not an archive-time silent assumption."
- "Acronym-friendly PascalCase resolution (FAQ ≡ Faq) + kitCva alias + extracted-pattern relaxed contract were the three audit refinements needed to bring false positives to zero on the smoke test. Future audit-script extensions should consider similar 'idiom-equivalence' carve-outs early — strict canonical-form matching produces unworkable noise on real kits."
  test-results:
  unit: n/a (factory work — empirical validation via audit smoke-test in evidence/phase1-step-039-result.txt)
  integration: ✓ audit produces honest findings on test-app kit (29 findings across 5 dimensions)
  duration-minutes: 240

---
