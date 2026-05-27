---
task-id: "031"
title: "Tester Agent — edge cases + integration + E2E (hybrid TDD with builders)"
status: pending
priority: P2
tier: 8 — Quality & Ship
depends-on: ["028", "029", "030"]
estimated-scope: medium
---

# 031: Tester Agent — edge cases + integration + E2E

## Position in pipeline (feat-004 hybrid-TDD)

Feat-004 (`plans/active/feat-004-builder-tdd-hybrid.md`, Q3 of investigate-001) moved happy-path unit-test authoring INTO the builders. Builders now generate sibling `.test.ts` / `.test.tsx` / `_test.py` files alongside implementation + run the stack skill's test command in self-verify. The tester's role narrows accordingly: it NO LONGER writes happy-path unit tests.

**New tester scope:**

- Read builder-generated unit tests (confirm they exist + pass) — trust but verify
- ADD edge-case unit tests (error paths, boundary conditions, auth failures, rate limits, race conditions, malformed inputs) — NOT happy-path rewrites
- OWN integration tests (cross-module: "auth middleware + session router", "db migration + data model", "worker + queue")
- OWN E2E tests (Playwright for web, Maestro for mobile) — per-feature flows end-to-end
- Run the FULL suite (builder tests + tester tests) and report pass/fail + coverage numbers

Tester runs in the feature's worktree per refactor-004 Mode B. Each `feature.agent_sequence[]` that includes `tester` gets tester invoked after the implementing builders complete.

## What This Task Produces

1. Agent definition at `.claude/agents/tester.md`
2. Skill at `.claude/skills/test/SKILL.md`
3. Shared testing policy at `.claude/rules/testing-policy.md` — 60% builder / 80% total coverage thresholds (shipped separately via feat-004; tester scaffolding references it)

## Scope

### Agent Definition

```yaml
---
name: tester
description: Narrow-scope tester. Trusts builder-generated happy-path unit tests; adds edge cases, integration tests, and E2E (Playwright web / Maestro mobile). Runs the FULL test suite and reports pass/fail + coverage. Hybrid with feat-004's builder-authored happy-path tests.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
maxTurns: 30
effort: medium
mcp_servers: []
---
```

Note: `mcp_servers: []` for unit + integration testing. `playwright` MCP may be added at stack-skill discretion for E2E runs — stack skills with an E2E recipe document whether Playwright runs via MCP or via `pnpm playwright test` directly.

### Testing Strategy — responsibilities split (feat-004)

Binds to `.claude/rules/testing-policy.md`. Summary:

| Layer                 | Authored by                                | Runs where                             | Coverage expectation                |
| --------------------- | ------------------------------------------ | -------------------------------------- | ----------------------------------- |
| Happy-path unit tests | Builder (feat-004)                         | Inside feature worktree                | 60% line coverage of implementation |
| Edge-case unit tests  | Tester                                     | Inside feature worktree                | raises total to 80%                 |
| Component tests       | Builder (happy path) + tester (edge cases) | Same                                   | Part of above totals                |
| Integration tests     | **Tester only**                            | Inside feature worktree                | Add cross-module invariants         |
| E2E tests             | **Tester only**                            | Against running dev server / simulator | Golden-path flow per feature        |
| Full-suite run        | **Tester only**                            | Inside feature worktree                | Reports coverage + pass/fail        |

Stack-specific runners (from each `.claude/skills/agents/{tier}/{stack-slug}/SKILL.md` §Testing + §Commands block):

- **react-next / svelte-kit**: Vitest + `@testing-library/react|svelte`; E2E via Playwright
- **expo-rn**: jest-expo + `@testing-library/react-native`; E2E via Maestro (YAML)
- **node-trpc-nest**: Vitest + `vitest-mock-extended` for Prisma stubs; integration via Testcontainers Postgres
- **python-fastapi**: pytest + pytest-asyncio + testcontainers[postgres]
- **Future stacks**: same pattern — stack skill's §Testing block names runner + mocking idiom + example

### Inputs

| Input                                                         | Source              | Purpose                                                  |
| ------------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| `.claude/architecture.yaml`                                   | /architect          | Stack choices (dispatch to stack skill's §Testing block) |
| `docs/tasks.yaml` (v2)                                        | /pm --mode=tasks    | Tasks assigned to `agent: tester` per feature            |
| Builder-generated unit tests                                  | Builders (feat-004) | Trust-but-verify — confirm they run + pass               |
| `.claude/skills/agents/{tier}/{stack-slug}/SKILL.md` §Testing | Loaded at dispatch  | Test runner, mocking patterns, example                   |
| `.claude/rules/testing-policy.md`                             | Factory             | Coverage thresholds + retry policy                       |

### /test Skill — steps

1. **Dispatch via stack skills.** Read `architecture.yaml.tooling.stack.*` — for each tier present (web / mobile / backend), load the matching stack skill's §Testing block into prompt context.
2. **Filter tasks.yaml v2**: `features[].tasks[]` where `agent: tester` AND the feature's `skip[]` doesn't exclude the test's target tier.
3. **Within the feature's worktree** (orchestrator handles CWD per refactor-004):
   - **Sanity-check builder tests exist + pass.** Walk `src/` (or stack-specific equivalent); every non-test source file should have a sibling test. Run the stack's test command on the builder-authored tests first. If any fail OR coverage on builder's scope is below 60%, emit a `builder-handoff-failure` warning but continue.
   - **Author edge-case unit tests** for the business logic the builder already covered. Focus on: error paths, boundary conditions, auth failures, rate limits, malformed inputs, concurrency hazards, off-by-one semantics. Uses the stack skill's §Testing patterns.
   - **Author integration tests** for cross-module interactions. E.g., "auth middleware + session router + redis-cache interaction with a dropped connection". Python stacks: use `testcontainers[postgres]` for real-DB tests. Node: `vitest-mock-extended` + `testcontainers` where needed.
   - **Author E2E tests** for the feature's user-facing flow. Web: Playwright (`apps/web/e2e/{feature-id}.spec.ts`). Mobile: Maestro (`apps/mobile/.maestro/{feature-id}.yaml`). Not every feature needs E2E — backend-only features (data migrations, cron jobs) skip to integration; UI features emphasize E2E.
4. **Run the full suite** (builder tests + tester tests) using the stack's `test:` command with coverage flag (`--coverage`). Parse coverage output; check total ≥ 80% per `.claude/rules/testing-policy.md`.
5. **Retry on failure** — max 3 iterations. Each iteration: read failing test output, adjust test or flag as genuine product bug (return to the builder via task-retry, per orchestrator policy).
6. **Report**. Return JSON with `testsWritten`, `testsPassed`, `testsFailed`, `coverageTotal`, `coverageBuilderOnly`, `policyCheck: "pass"|"fail"`, `genuineProductBugs[]` (if any tests failed due to real implementation bugs, not test authoring).

### Key rules

- Tester **does not author happy-path tests** — that's the builder's job per feat-004 TDD hybrid. Writing duplicate happy-path tests is explicitly forbidden.
- Tester **runs the full suite** (builder + tester tests combined) with coverage; the coverage number in the report is across both sources.
- Tester **can flag genuine bugs** it finds back to the implementing builder via `genuineProductBugs[]` in its return JSON; orchestrator routes those to the last writing agent per refactor-004 retry policy (max 3).
- Max 3 iterations on tester's own test-authoring failures.
- Coverage thresholds: **60% on builder scope (builder's own self-verify)**; **80% on total after tester** (this skill enforces). Below 80% after tester → `policyCheck: "fail"` + `needs-human-review` flag.

## Acceptance Criteria

- [ ] `.claude/agents/tester.md` exists with narrowed scope (no happy-path authoring)
- [ ] `.claude/skills/test/SKILL.md` exists with 6-step flow above
- [ ] Skill dispatches via stack skill §Testing blocks — doesn't hardcode Vitest vs Jest vs pytest choices
- [ ] Skill explicitly forbids happy-path re-authoring (documented in §Key rules)
- [ ] Skill verifies builder tests exist + pass BEFORE authoring edge cases
- [ ] Skill authors three categories: edge-case units, integration, E2E — documented per stack
- [ ] Skill runs `test:` command with `--coverage` and parses total coverage
- [ ] Skill enforces 80% total coverage threshold from `.claude/rules/testing-policy.md`
- [ ] Skill returns `genuineProductBugs[]` when test failures trace to real bugs in builder-authored code (orchestrator routes to builder retry)
- [ ] Max 3 iterations on tester's test-authoring failures
- [ ] Runs in feature worktree per refactor-004 Mode B (CWD handled by orchestrator)
- [ ] `mcp_servers: []` (Playwright MCP only if stack skill's §Testing calls for it — then it's registered at /new-project per feat-002's stack-skill-discovery flow)
- [ ] Return JSON matches `TestOutput` in 034b (to be updated in a follow-up to add coverage + genuineProductBugs fields)

## Human Verification

1. Run `/test` after `/build-backend` + `/build-web-frontend` produce a feature's code + builder tests. Does the tester skip duplicate happy-path authoring?
2. Inject a subtle bug in a builder-authored implementation file. Does the tester's edge-case tests catch it + flag it in `genuineProductBugs[]`?
3. Remove a builder-authored test file. Does the tester emit `builder-handoff-failure` but continue authoring its own tests?
4. Hit 75% coverage: does `policyCheck: "fail"` fire? Hit 82%: does it pass?

## Downstream implications

- Task 028/029/030 builders: generate happy-path sibling tests per feat-004; must not be passed by self-verify if test command fails
- `.claude/rules/testing-policy.md` (new file from feat-004): the authoritative thresholds
- `.claude/skills/agents/{tier}/{stack-slug}/SKILL.md` §Testing blocks (shipped via feat-002): each shows the test runner command + mocking patterns the tester uses
- Task 034b `TestOutput` — to be updated with `coverageTotal`, `coverageBuilderOnly`, `policyCheck`, `genuineProductBugs` fields in a follow-up iteration
