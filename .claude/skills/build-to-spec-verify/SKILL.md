---
name: build-to-spec-verify
description: Post-Mode-B integration verifier. Runs 6 tiers — build-sanity / reachability / synth-flows / parity / perceptual / walkthrough — and auto-files bug plans on violations. Tiers 1-3 are deterministic; Tiers 4 (perceptual vision-LLM) + 5 (walkthrough vision-LLM) dispatch agents via the wired invokeAgent. Operator invocation goes through `orchestrator/scripts/run-verifier.ts` so all 6 tiers fire. Auto-invoked by the orchestrator (feat-022 / 068 / 069) after the last feature merges, before "complete" emits; also fires from the fix-bugs loop's end-of-iteration verify.
when-to-use: invoked by orchestrator runFeatureGraph() after all features merge AND before the "complete" signal; also as a standalone operator probe to seed `docs/bugs.yaml` before a manual `/fix-bugs` cycle; never invoked inline inside feature work
allowed-tools: Read Write Bash Grep Glob
model: inherit
---

# /build-to-spec-verify — Post-Mode-B integration verification

The verification stage that catches the integration gaps shipping through individually-green features (orphan components like kanban-webapp-09's `CardDetailModal`; computed-style drift; route-slug mismatches; behavioral regressions tier-toggling missed). Runs in 6 ordered tiers — three deterministic, two LLM-driven, plus a build-sanity pre-flight — and routes failures via auto-filed bug plans through the standard retry ladder.

| Tier | Name         | Mechanism                                              | LLM?    |
| ---- | ------------ | ------------------------------------------------------ | ------- |
| 0    | build-sanity | dev-server boot + `/health` probe                      | No      |
| 1    | reachability | `audit-app-reachability.mjs` static scan               | No      |
| 2    | synth-flows  | `synthesize-flow-e2e.mjs` + Playwright spec exec       | No      |
| 3    | parity       | DOM-diff + computed-style audit (mockup vs built)      | No      |
| 4    | perceptual   | per-screen vision-LLM compare (mockup PNG vs live PNG) | **Yes** |
| 5    | walkthrough  | Playwright walkthrough + vision-LLM behavioral review  | **Yes** |

Tiers 4 + 5 dispatch the `perceptual-reviewer` + `walkthrough-reviewer` agents respectively. When `invokeAgent` is not passed to `runBuildToSpecVerify`, both tiers silently skip with `"invokeAgent not provided"` warnings — the canonical operator wrapper `orchestrator/scripts/run-verifier.ts` wires it explicitly so this never happens.

## Arguments

- `<project-dir>` (required, positional) — path to the project root (e.g. `projects/gotribe-event-calendar`)

The wrapper resolves `factoryRoot` from its own location, derives a fresh `pipelineRunId` (`tmp-verify-<epoch>`), and writes output to `<project-dir>/docs/_tmp-verify-output.json`. `autoFileBugPlans` is on by default — violations land in `docs/bugs.yaml` ready for `/fix-bugs`.

## Steps

### 1. Pre-flight

Abort cleanly (no side effects) on any failure:

- `<project-dir>` exists and contains either `apps/web/src/` OR `apps/web/app/`
- `<project-dir>/docs/user-flows-manifest.json` exists (synthesizer surfaces a warning when missing — not fatal, but `flows.generated[]` will be empty)
- `<project-dir>/.claude/architecture.yaml` exists (dev-server stack-aware boot reads `tooling.stack.backend_framework` + persistence-layer slug)
- Factory root has `orchestrator/scripts/run-verifier.ts` (canonical wrapper) + `scripts/audit-app-reachability.mjs` + `scripts/synthesize-flow-e2e.mjs`

### 2. Invoke the canonical wrapper

Run the canonical operator entry point from the factory root. **Pass an absolute path** — `pnpm --filter orchestrator exec` changes cwd into the orchestrator package, so a relative `projects/...` argument resolves to the wrong place and the script aborts with `projectDir not found`:

```bash
# bash / zsh / git-bash
pnpm --filter orchestrator exec tsx scripts/run-verifier.ts "$(pwd)/projects/<name>"

# PowerShell
pnpm --filter orchestrator exec tsx scripts/run-verifier.ts "$PWD/projects/<name>"
```

**Optional tier subset** — restrict the run to a cheaper subset of tiers (useful as an initial probe when the project is fresh + you suspect cascade-root issues will swamp Tier 3+4+5 findings). Two equivalent flag shapes:

```bash
# Explicit tier list
pnpm --filter orchestrator exec tsx scripts/run-verifier.ts "$(pwd)/projects/<name>" --enabled-tiers=0,1,2

# Round shorthand (feat-073 round → tier map)
pnpm --filter orchestrator exec tsx scripts/run-verifier.ts "$(pwd)/projects/<name>" --round=1
```

| Round | `enabledTiers`   | Cost shape                    | When to use                                                                                                                                                            |
| ----- | ---------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 0, 1, 2          | ~$0 + 3-5min                  | First probe on a fresh project. Catches cascade-root tooling bugs (dev-server boot / globalSetup / Playwright runner) before paying for parity/perceptual/walkthrough. |
| 2     | 0, 1, 2, 3       | ~$0 + 5-8min                  | After Round 1 clears. Adds Tier 3 parity (DOM-diff + computed-style).                                                                                                  |
| 3     | 0, 1, 2, 3, 4    | $0.20-$1 per screen + 8-15min | After Round 2 clears. Adds Tier 4 vision-LLM perceptual review.                                                                                                        |
| 4 / 5 | 0, 1, 2, 3, 4, 5 | $0.30-$0.80 + 10-20min total  | After Round 3 clears OR for a complete ship-readiness pass. Full 6-tier suite.                                                                                         |

Default (no flag): all 6 tiers fire. Use the staged invocation when initial cascade-root findings are likely; use the full default once the build is suspected-clean.

This script is the **only sanctioned operator-facing path**. It wires `invokeAgent` + `BudgetTracker` so all 6 tiers fire — invoking `runBuildToSpecVerify` any other way (raw shell-out to the deterministic scripts; programmatic call without `invokeAgent`) silently skips Tiers 4 + 5 with `"invokeAgent not provided"` warnings buried in `result.warnings[]`. The output then looks like a successful 6-tier pass but is missing all perceptual + walkthrough findings. See `memory:feedback_verifier_invokeAgent_plumbing.md` for the empirical incident class.

What the wrapper does, in order:

1. Resolves `factoryRoot` from its own location.
2. Mints `pipelineRunId = tmp-verify-<epoch>`.
3. Constructs a `BudgetTracker` with `perPipelineMaxUsd: 10` (defensive cap covering Tier 4 + 5 dispatches).
4. Constructs `invokeAgent` via `createInvokeAgent({ projectRoot, budget, flags: [], pipelineRunId })`.
5. Calls `runBuildToSpecVerify({ projectDir, factoryRoot, autoFileBugPlans: true, pipelineRunId, iteration: 1, invokeAgent })`.
6. The orchestrator function runs the 6 tiers in order — booting `apps/api/` + `apps/web/` dev servers up front, restoring seed-baseline between Tier 3 and Tier 4 (per bug-095), tearing down servers on completion.
7. Writes the full output JSON to `<project-dir>/docs/_tmp-verify-output.json` for inspection.
8. Auto-files bug plans + appends `docs/bugs.yaml` entries per violation.
9. Prints summary lines: `ok`, warning count, reachability orphans, flows passed/failed, bug plans filed, output path.

### 3. Tier-by-tier (what the wrapper runs internally)

| Tier | Triggered by                                                                                   | Outputs                                                   | Empirical cost       |
| ---- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------- |
| 0    | dev-server boot before Tier 1                                                                  | `warnings[]` on boot failure; aborts subsequent tiers     | ~0 (deterministic)   |
| 1    | `scripts/audit-app-reachability.mjs`                                                           | `reachability.orphanComponents[]` + `orphanRoutes[]`      | <1s                  |
| 2    | `scripts/synthesize-flow-e2e.mjs` + Playwright run                                             | `flows.passed[]` / `flows.failed[]` / `flows.generated[]` | 1–5min               |
| 3    | `runParityVerify` (DOM-diff + computed-style audit)                                            | `parity.divergences[]`                                    | 30s–2min             |
| 4    | `runPerceptualReview` (per-screen vision-LLM dispatch via `invokeAgent`)                       | `perceptual.perScreen[]` violations                       | $0.20–$1 + 3–10min   |
| 5    | `runWalkthroughReview` (single Playwright walkthrough + vision-LLM dispatch via `invokeAgent`) | `walkthrough.findings[]`                                  | $0.30–$0.80 + 2–5min |

Tier 4 + 5 short-circuit when round-state gating (feat-073 `enabledTiers`) excludes them OR when their respective scripts produce no screenshots (e.g. Tier 2 hit zero screens → Tier 4 dir empty → skip).

### 4. Auto-file bug plans + bugs.yaml entries

For each violation across all six tiers, the orchestrator side invokes `scripts/file-bug-plan.mjs` (programmatic) AND appends to `<project-dir>/docs/bugs.yaml`:

1. Walks `plans/active/` + `plans/archive/` for existing `bug-NNN-` plans, picks `max+1`
2. Writes `plans/active/bug-NNN-{slug}.md` with frontmatter + body templated from the violation
3. Appends a `docs/bugs.yaml` entry with `source: <reachability|synth-flows|parity-verify|perceptual-review|walkthrough-review>` so the downstream `/fix-bugs` loop knows which dispatch class to route to

**Consolidation:** when an orphan component AND a flow failure share an `owningFeature`, the wrapper merges both into a single bug plan whose "Likely cause" lists both — saves a builder round-trip.

The wrapper hard-codes `autoFileBugPlans: true`. Operators who want a diagnostic-only run should call `runBuildToSpecVerify` programmatically with `autoFileBugPlans: false` — there is intentionally no operator-side flag for this.

### 5. Validate against the contract

The wrapper Zod-parses its own output against `@repo/orchestrator-contracts.BuildToSpecVerifyOutput` before returning. Schema drift between this code and the contract surfaces as a parse error — the orchestrator treats that as a verification crash and marks the run `completed-with-integration-failures` with a synthesized warning.

### 6. Return JSON

The full output shape lives in `packages/orchestrator-contracts/src/build-to-spec-verify.ts`. High-level keys:

```jsonc
{
  "ok": true|false,
  "reachability": { "orphanComponents": [...], "orphanRoutes": [...], "ignoredByAllowComment": [...] },
  "flows": { "passed": [...], "failed": [<FlowFailure>], "generated": [...] },
  "parity": { "divergences": [<ParityDivergence>] },        // Tier 3
  "perceptualReview": { "perScreen": [<PerceptualFinding>] }, // Tier 4
  "walkthroughReview": { "findings": [<WalkthroughFinding>] }, // Tier 5
  "bugPlansFiled": [<planId>...],
  "bugsYamlAppended": [<bugId>...],
  "costUsd": <number>,
  "durationMs": <int>,
  "warnings": [<string>]
}
```

`ok === true` iff every tier reports zero violations: reachability orphans, flow failures, parity divergences, perceptual per-screen findings, AND walkthrough findings all empty.

The orchestrator's `runFeatureGraph` reads `verify.ok` + sets the run-level `status`:

- `completed` — all features merged AND verify ok
- `completed-with-integration-failures` — all features merged BUT verify surfaced violations + filed bug plans (drives the `/fix-bugs` loop)
- `incomplete` — at least one feature failed (verify is skipped on this branch)

## What this skill does NOT do

- **Brief §11/§12 capability coverage.** That's feat-023's job (`/pm` stage).
- **LLM-driven brief→E2E synthesis.** Higher variance than the deterministic flows-manifest path; deferred to v3.
- **Cross-platform.** Web only. Mobile (Maestro flows) follows the same pattern but ships separately.
- **Replace the reviewer.** Tier 4 + 5 catch divergence from designed mockups + user-flow behavior; the per-feature reviewer still owns code-quality dimensions (architecture, security, maintainability, etc.) inside Mode B.

## Failure modes + retry routing

| Symptom                          | Surfaced as                                      | Orchestrator routes to                                |
| -------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Orphan component                 | bug plan + `bugPlansFiled[]`                     | web-frontend-builder via bug-fixer (max 3)            |
| Orphan route                     | bug plan + `bugPlansFiled[]`                     | web-frontend-builder via bug-fixer (max 3)            |
| Flow E2E failure                 | `flows.failed[]` + `primaryCause` taxonomy       | dispatch class per `primaryCause` (bug-050)           |
| Parity divergence (Tier 3)       | `parity.divergences[]` + bugs.yaml entry         | bug-fixer / systemic-fixer per drift class (bug-087)  |
| Perceptual finding (Tier 4)      | `perceptualReview.perScreen[]` + bugs.yaml entry | systemic-fixer (UI shell-strip class) or bug-fixer    |
| Walkthrough finding (Tier 5)     | `walkthroughReview.findings[]` + bugs.yaml entry | bug-fixer (per finding) or systemic-fixer (clustered) |
| Dev-server boot failure (Tier 0) | `warnings[]` entry; subsequent tiers abort       | operator review (not auto-routed)                     |
| Synth crash (missing manifest)   | `warnings[]` entry; `flows.generated[]` empty    | operator review (not auto-routed)                     |
| Reachability crash               | `warnings[]` entry; reachability arrays empty    | operator review (not auto-routed)                     |
| `invokeAgent` not wired          | `warnings[]` entry; Tier 4 + 5 silently skip     | **OPERATOR BUG — re-invoke via `run-verifier.ts`**    |

All retries follow the standard ladder: max 3 per task in `/fix-bugs`, escalation to human at 5.

## Cost + runtime

Empirical reference: 2026-05-13 reading-log-02 (5-screen project, 4 perceptual + 1 walkthrough dispatch) ran in **15.6 min wall-clock at $1.50 total**. Numbers scale primarily with screen count + flow count.

- Per-run: $1–3 typical (Tier 4 dominates — ~$0.20–$1 per screen; Tier 5 ~$0.30–$0.80 once)
- Runtime: 10–20 min typical; Tier 2 Playwright execution is the largest deterministic contributor (1–5 min); Tier 4 perceptual dispatches the slowest LLM contributor (3–10 min)
- Stage cap: `perPipelineMaxUsd: 10` (set in `run-verifier.ts`); aborts before the next dispatch when exceeded

## Integration points

- **`runFeatureGraph`** (`orchestrator/src/feature-graph.ts`): invokes `runBuildToSpecVerify` after all features merge; sets run-level `status` based on `verify.ok`. Automatically wires `invokeAgent` from its Mode B agent factory.
- **`runFixBugsLoop`** (`orchestrator/src/fix-bugs-loop.ts`): re-invokes the verifier at end-of-iteration with tier-toggling (bug-144) so intermediate iterations skip Tiers 4 + 5 when not needed; a final safety-net full verify runs when status reaches "clean". Threads `ctx.invokeAgent` through.
- **`run-verifier.ts`** (`orchestrator/scripts/run-verifier.ts`): canonical operator-facing wrapper. Wires `invokeAgent` + `BudgetTracker` explicitly so all 6 tiers fire on standalone invocations.
- **Output schemas**: `BuildToSpecVerifyOutput` lives in `packages/orchestrator-contracts/src/build-to-spec-verify.ts`; JSON schema export at `schemas/build-to-spec-verify-output.schema.json`.
- **`/screens` skill** §4e.1: every mockup body must carry `data-screen-id="{id}"` — the synthesizer's expected-screen assertion + the parity verifier's mockup-side lookup both depend on this.
- **react-next / svelte-kit stack skills** §1c: every page-root render must mirror the same `data-screen-id` on its topmost element.
- **`perceptual-reviewer` + `walkthrough-reviewer` agents** (`.claude/agents/`): Tier 4 + 5 dispatch targets; system prompts at those paths drive each agent's findings shape.

## Cross-references

- `plans/active/feat-068-vision-llm-perceptual-review.md` — Tier 4 parent feature
- `plans/active/feat-069-ai-walkthrough.md` — Tier 5 parent feature
- `plans/active/feat-073-rounds-orchestration.md` — round-state tier-gating via `enabledTiers`
- `plans/archive/feat-022-build-to-spec-verification.md` — original v1 parent plan (deterministic tiers only)
- `plans/archive/investigate-006-build-to-spec-verification.md` — option survey + gap catalog
- `plans/active/bug-145-verify-skill-skips-llm-tiers.md` — this rewrite's parent bug (operator-side wrapper wiring)
- `orchestrator/scripts/run-verifier.ts` — canonical operator wrapper (the only sanctioned standalone entry point)
- `orchestrator/src/build-to-spec-verify.ts` — 6-tier orchestrator implementation
- `scripts/audit-app-reachability.mjs` — Tier 1 reachability analyzer (pure-Node)
- `scripts/synthesize-flow-e2e.mjs` — Tier 2 flow-E2E synthesizer (pure-Node)
- `scripts/file-bug-plan.mjs` — bug-plan auto-author (programmatic + CLI)
- `packages/orchestrator-contracts/src/build-to-spec-verify.ts` — Zod schema + types
- `schemas/build-to-spec-verify-output.schema.json` — Zod-derived JSON Schema for non-SDK consumers
- Memory `feedback_verifier_invokeAgent_plumbing.md` — empirical incident: silent Tier 4+5 skip when `invokeAgent` not wired

## Acceptance criteria

- [x] Skill markdown frontmatter declares all 6 tiers + `invokeAgent` wiring requirement
- [x] §Steps directs operator invocation through `orchestrator/scripts/run-verifier.ts` exclusively
- [x] Auto-files bug plans via `file-bug-plan.mjs` + appends `docs/bugs.yaml` entries with `source:` tag
- [x] Returns shape matches `BuildToSpecVerifyOutput` Zod schema (incl. `parity`, `perceptualReview`, `walkthroughReview`)
- [x] Orchestrator integration sets `status: "completed-with-integration-failures"` when any tier surfaces violations
- [x] Tier 4 + 5 dispatch the `perceptual-reviewer` + `walkthrough-reviewer` agents via the wired `invokeAgent`
- [x] Cost + runtime numbers anchor to empirical reading-log-02 reference ($1.50 + 15.6min, 5-screen project)
- [x] All existing orchestrator tests still pass after wiring
- [x] Empirical re-validation: running `/build-to-spec-verify gotribe-event-calendar` produces non-zero perceptual + walkthrough blocks AND no `"invokeAgent not provided"` warning
