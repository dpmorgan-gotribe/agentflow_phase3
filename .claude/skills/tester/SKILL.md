---
name: tester
description: Narrow-scope tester per hybrid-TDD (feat-004). Dispatches to stack skills' §Testing blocks per tier. Trusts builder-authored happy-path tests, authors edge-case + integration + (optional) E2E tests, runs full suite with coverage, flags genuine product bugs back to builders for retry. Returns TesterOutput.
when_to_use: invoked by orchestrator Mode B inside a feature worktree AFTER all builders in agent_sequence have completed; runs before reviewer
allowed-tools: Read Write Edit Bash Grep Glob
model: inherit
argument-hint: "--feature-id=<feat-...> [--skip-e2e] [--task-ids=<csv>]"
---

# /tester — hybrid-TDD edge-case + integration + E2E owner

Invoked by the orchestrator (task-035 `invokeAgent("tester", ...)` inside `runFeature`) with CWD = `.claude/worktrees/{feature.worktree}/`. Eight-step dispatcher, same pattern as builders with tester-specific semantics.

## Arguments

- `--feature-id=<feat-...>` (required). Missing → reject with `/tester requires --feature-id=<feat-...>`.
- `--skip-e2e` (optional). Skips step 6.c (E2E authoring). Use for backend-only features or when the feature's UI isn't yet runnable.
- `--task-ids=<csv>` (optional). Scope to a specific task subset (orchestrator per-task retries).

## Prerequisites

- CWD at `.claude/worktrees/{slug}/`
- `.claude/architecture.yaml` at main working tree root
- `docs/tasks.yaml` v2
- `.claude/rules/testing-policy.md`
- Stack skills for each tier present in `tooling.stack.*`
- Builder(s) ran successfully before tester per `agent_sequence[]` — builder commit(s) present in the worktree's branch history

## Hard constraint — test files only (bug-024)

The tester writes test files only. This mirrors `.claude/agents/tester.md` §Hard constraint and `.claude/rules/testing-policy.md` §Genuine product bug — CONSTRAINT.

**Allowed paths**: `**/*.test.{ts,tsx,py}`, `**/*.spec.{ts,tsx,py}`, `apps/{app}/integration/**`, `apps/{app}/e2e/**`, `apps/{app}/.maestro/**/*.yaml`, `tests/integration/**`.

**Forbidden paths** (NEVER create or modify):

- Any non-test file under `apps/{app}/{src,app,components,lib}/**`
- Any non-test file under `packages/{any}/src/**`
- Scaffold-owned config files: `vitest.config.ts`, `vitest.setup.ts`, `next.config.ts`, `tailwind.config.ts`, `tsconfig.json`
- `package.json` (any tier)

**On a failing test that reveals a real bug**: do NOT fix it inline. Add the bug to `genuineProductBugs[]` in the return JSON (canonical shape: `{task, file, line, expected, actual, failingTest}`). The orchestrator re-dispatches the original builder with the failing test as retry context.

Empirical motivation: see `plans/archive/bug-024-tester-modifies-source.md` — a tester that ignored the constraint hit the 20-min wall-clock abort 2× in a row, lost 1 of 8 features in a Mode B run, and burned ~$5 in fix-don't-flag overreach.

## Brief scope-out — HARD CONSTRAINT (bug-133)

Mirror of `.claude/agents/tester.md` §"Brief scope-out — HARD CONSTRAINT" + `.claude/rules/testing-policy.md` §"Spec-enrichment scope-out — CONSTRAINT (bug-133)". Do NOT write tests for behavior the project's `brief.md` explicitly scopes OUT. This is the **inverse** of bug-024's anti-patterns: those detect masking a real bug by reshaping a test; this detects creating an unreal requirement by writing a test for a runtime the brief never asked you to cover.

**Required step in every dispatch**: before authoring an edge-case test that exercises a runtime or capability the builder didn't ship, read `brief.md` at the worktree root. If it contains any of these phrases (case-insensitive):

- `Production — NOT deployed`
- `Production [is/are] NOT deployed`
- `--- production scope: deferred ---`
- `Production[…] out of scope`

…AND your test sets `process.env.NODE_ENV = "production"` (or otherwise exercises the scoped-out runtime), the mechanical post-tester audit (`orchestrator/src/tester-diff-audit.ts::detectBriefScopedOutEnrichment`) will reject your dispatch as a `brief-scoped-out-enrichment` violation.

**Three cases**:

| brief.md state                            | tester action                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Explicitly OUT (matches scope-out phrase) | Don't write the test. Escalate via `/plan-investigation` if you believe the brief is wrong.                            |
| Silent (brief doesn't mention either way) | Use `TesterOutput.enrichmentSuggestion[]` (advisory; surfaces to reviewer; does NOT route to builder; does NOT block). |
| Explicitly REQUIRED + builder missed it   | Standard path — write the test + populate `genuineProductBugs[]`.                                                      |

**Empirical motivator**: gotribe-auth-signup feat-email-stub (2026-05-18) — tester asserted `createEmailProvider()` throws when `NODE_ENV=production && !RESEND_API_KEY`, but `brief.md:131` said "Production — NOT deployed. This is a curriculum slice". Retry-cap exhausted; 3 downstream features cascade-aborted; ~$3 + 3h wasted. See investigate-035 + bug-133.

## Steps

### 1. Argument gate

Parse `--feature-id=`, optional `--skip-e2e`, optional `--task-ids=`. Reject missing feature-id. Walk up from CWD to find `projectRoot`.

### 2. Load architecture + testing policy

Read `{projectRoot}/.claude/architecture.yaml`. Load `.claude/rules/testing-policy.md` into prompt context.

**Filter-then-load for stack skills** (feat-009 Phase 4 finding). Do NOT pre-load stack skills for every tier in `tooling.stack.*`; loading skills for tiers with no in-scope tester tasks is prompt noise. Defer stack-skill loading until step 3 has filtered tasks. In step 3, load `.claude/skills/agents/{tier-dir}/{stack-slug}/SKILL.md` VERBATIM for each tier that survives filtering. A tier survives when (a) `tooling.stack.{tier}_framework` is non-null, (b) feature.skip[] does NOT exclude that tier, AND (c) ≥1 task in the filtered set targets code living under that tier's app directory.

Missing stack skill for a tier that DOES survive filtering → abort with `stack-skill-missing; run /skills-audit --scope=build`.

### 3. Load tasks

Filter `docs/tasks.yaml features[].tasks[]` to:

- `agent === "tester"` for the feature matching `--feature-id`
- Parent feature's `skip[]` filter applied per-test-layer (if `skip` includes `"web"`, skip web E2E + web integration; if includes `"backend"`, skip backend integration; etc.)
- Optional `--task-ids=` CSV scope

Zero tasks → exit cleanly with `tier-skipped-for-feature` warning + empty TesterOutput (testsWritten all 0, policyCheck based on builder-test run only).

### 4. Confirm worktree CWD

Read `./.feature-context.json`. Validate via `validate-feature-context.mjs`. Confirm `feature_id` matches.

Scan `agent_history[]`: at least one builder entry with `outcome: "success"` must exist. If none, abort with `no-builder-completed-yet; orchestrator-wiring-bug` — tester should not run before builders.

### 5. Sanity-check builder tests (trust but verify)

For each tier present in the feature:

- Walk the tier's source tree (e.g. `apps/api/src/` for backend, `apps/web/src/` for web) and find non-test source files
- Confirm each has a sibling test (`<basename>.test.{ts,tsx,py}`). If not, flag as warning `builder-missing-test: <path>` — the builder should have written this.
- Run the stack skill's test command (from its §Commands block) with `--coverage` flag. Capture coverage.
- If ANY builder test fails OR `coverageBuilderOnly < 60`:
  - Surface as warning `builder-handoff-failure: <details>`; continue.
  - DO NOT attempt to fix the builder's code or rewrite the builder's tests. That's a genuine product bug — candidate for `genuineProductBugs[]` after edge-case analysis.

### 6. Per task, author tests + commit

Topologically sort tester tasks by within-feature `depends_on[]`. For each task:

#### 6.a Edge-case unit tests

- Identify source files the task targets (from task summary / integration_ref / builder's recent commits)
- For each targeted file, write `<source-basename>.edge-cases.test.{ts,tsx,py}` (or stack-specific pattern from the stack skill's §Testing example)
- Scope per `.claude/rules/testing-policy.md`: error paths / boundaries / concurrency / malformed input / cross-module failure modes
- Do NOT duplicate the builder's happy-path tests — grep the builder's sibling `.test.*` for canonical test names and skip them

#### 6.b Integration tests

- For cross-module invariants (auth+session+cache; db migration+data model; worker+queue):
  - Node/Python backends: author tests under `apps/{tier}/integration/<feature-id>.integration.test.{ts,py}` using `testcontainers[postgres]` (or stack-skill-specified equivalent)
  - Frontend + backend handshakes: author mocked-backend tests or use MSW
- Skip integration step for tiers where feature.skip[] excludes the tier

#### 6.c E2E tests (skip when `--skip-e2e` supplied OR no UI tier applies)

- **Web** (when `tooling.stack.web_framework` set + feature doesn't skip `web`): author `apps/web/e2e/<feature-id>.spec.ts` — Playwright golden-path flow per feature's `brief_reference`
- **Mobile** (when `tooling.stack.mobile_framework` set + feature doesn't skip `mobile`): author `apps/mobile/.maestro/<feature-id>.yaml` — Maestro tap-through
- Backend-only features: skip E2E entirely (same outcome as `--skip-e2e`)

#### 6.d Commit

For each test file written, commit individually:

```
git add <test-file> && git commit -m "test({task.id}): <one-line>"
```

Use `test:` conventional-commit prefix (NOT `feat:` — tester doesn't add features).

### 7. Run the full suite + parse coverage + retry ladder

Run the stack skill's `test:coverage` (or equivalent) command:

```bash
# example per stack skill:
pnpm --filter @repo/api test -- --coverage   # node-trpc-nest
pnpm --filter @repo/web test -- --coverage   # react-next
uv run pytest --cov=api --cov-report=term-missing   # python-fastapi
```

Parse output:

- `testsRun: { total, passed, failed }` from the runner's summary
- `coverageTotal` (0-100) from the coverage-summary line
- `coverageBuilderOnly` — use the runner's per-file coverage output; filter to files touched by builder commits (scan git log for files added by `agent: backend-builder|web-frontend-builder|mobile-frontend-builder` in this feature's branch history)

**Retry ladder (max 3 iterations):**

- If `testsRun.failed > 0`:
  - For each failing test, analyze:
    - Is it a tester-authoring bug? (wrong arrange/act/assert; fix test, retry)
    - Is it a genuine product bug? (canonical-success-case path breaks against the builder's spec per testing-policy.md judgment rule). Append to `genuineProductBugs[]` and stop iterating on that test.
  - If all failures are tester bugs → iterate (max 3). If genuine product bugs → break; orchestrator routes back to builder.
- If `coverageTotal < 80`:
  - Generate additional edge-case tests targeting lowest-covered files per the runner's per-file output. Max 3 iterations.

After 3 iterations:

- `testsRun.failed === 0` + `coverageTotal >= 80` → `policyCheck: "pass"`
- `testsRun.failed === 0` + `coverageTotal < 80` → `policyCheck: "fail"` (signoff-invalidating)
- Runner didn't complete (install/config error) → `policyCheck: "blocked"` (needs human)
- `genuineProductBugs[].length > 0` → `policyCheck: "blocked"` (orchestrator routes back to builder; tester's run is incomplete)

### 8. Update feature-context.json + return TesterOutput

Append ONE `agent_history[]` entry:

```json
{
  "agent": "tester",
  "op": "execute-tasks",
  "started_at": "<step-6-start>",
  "finished_at": "<now>",
  "outcome": "success" | "failure",
  "commit_sha": "<HEAD after all test commits>",
  "notes": "<X edge-case + Y integration + Z e2e tests; coverageTotal N%; policyCheck <enum>>"
}
```

Set `last_writing_agent: "tester"` when ≥1 commit. Re-validate via `validate-feature-context.mjs`.

Emit TesterOutput JSON:

```json
{
  "success": <policyCheck === "pass">,
  "featureId": "<feature-id>",
  "testsWritten": { "edgeCase": N, "integration": M, "e2e": K },
  "testFilesWritten": [...],
  "testsRun": { "total": N, "passed": P, "failed": F },
  "coverageTotal": <0-100>,
  "coverageBuilderOnly": <0-100>,
  "policyCheck": "pass" | "fail" | "blocked",
  "genuineProductBugs": [...],
  "headSha": "<final HEAD or null>",
  "warnings": [...]
}
```

Orchestrator validates via `TesterOutput` Zod before advancing `agent_sequence[]` (next: typically reviewer). On `policyCheck: "blocked"` with non-empty `genuineProductBugs[]`, orchestrator routes back to the last-writing builder per refactor-004 task-retry ladder.

## Error paths

- **Missing `--feature-id=`** → abort at step 1.
- **No architecture.yaml** → abort (orchestrator wiring bug).
- **Stack skill missing** → abort with skills-audit pointer.
- **Worktree-not-initialized** → abort (wiring bug).
- **No builder success entry in agent_history** → abort; tester should not run pre-builder.
- **Coverage < 80% after 3 iterations, all tests passing** → `policyCheck: "fail"`, not abort.
- **genuineProductBugs surfaced** → `policyCheck: "blocked"`, orchestrator re-routes.

## Integration Points

- **Task 035 orchestrator `runFeature`** calls this skill via `invokeAgent({ agent: "tester", cwd: worktreeCwd, ... })`.
- **Stack skills' §Testing blocks** — loaded in step 2.
- **`.claude/rules/testing-policy.md`** — binding contract for coverage thresholds + retry policy.
- **`TesterOutput` Zod schema** validates the return JSON.
- **git-agent** owns worktree lifecycle; tester never runs worktree ops.
- **Orchestrator per-task retry ladder** consumes `genuineProductBugs[]` + routes to the last-writing builder.

## Acceptance criteria

- [ ] Skill registers in available-skills list
- [ ] Rejects invocations without `--feature-id=`
- [ ] `--skip-e2e` flag skips step 6.c cleanly
- [ ] Aborts when no builder success in agent_history (wiring bug)
- [ ] Trust-but-verify: runs builder tests first, warns on handoff failure, does not overwrite
- [ ] Authors edge-case + integration + (optional) E2E tests per stack skill §Testing patterns
- [ ] Commits with `test:` conventional-commit prefix (not `feat:`)
- [ ] Runs full-suite with coverage; parses total + builder-only numbers
- [ ] Retry ladder: ≤3 iterations; distinguishes tester-authoring bugs from genuine product bugs
- [ ] Returns TesterOutput matching Zod schema; discriminates pass/fail/blocked correctly
- [ ] genuineProductBugs[] populated for real builder bugs; empty for tester-authoring noise
- [ ] Appends exactly ONE agent_history entry per invocation
- [ ] Updates last_writing_agent when commits happen
