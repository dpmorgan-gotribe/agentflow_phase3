# Testing policy — hybrid TDD (feat-004)

Authoritative policy consumed by builders (tasks 028 / 029 / 030) + the tester (task 031). Referenced from `.claude/agents/*-builder.md` + `.claude/agents/tester.md` + every shipped stack skill's §Testing block.

## Who authors what

| Test layer                | Who writes it                                      | When                                  | Where                                                             |
| ------------------------- | -------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Happy-path unit tests     | **Builder**                                        | Alongside each implementation file    | Sibling `.test.{ts,tsx,py}` inside feature worktree               |
| Edge-case unit tests      | **Tester**                                         | After builder completes               | Same stack-skill idioms; same `src/` tree                         |
| Component tests (UI)      | **Builder** (happy path) + **Tester** (edge cases) | During builder pass + tester pass     | Co-located `.test.tsx`                                            |
| Integration tests         | **Tester**                                         | After builder completes               | `apps/{app}/integration/` or `tests/integration/` per stack skill |
| E2E tests (web)           | **Tester**                                         | After all builders + integration pass | `apps/web/e2e/*.spec.ts` (Playwright)                             |
| E2E tests (mobile)        | **Tester**                                         | Same                                  | `apps/mobile/.maestro/*.yaml` (Maestro)                           |
| Full-suite run + coverage | **Tester**                                         | End of feature                        | Command from stack skill's §Commands block                        |

Rationale per `plans/active/investigate-001-post-design-pipeline-architecture.md` Q3: pure TDD is slow for AI builders; pure post-build tester misses unit-level invariants the builder knew best. Hybrid is the middle path.

## Coverage thresholds

| Threshold                                                     | Where measured                              | Set by  | Consequence of miss                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **60% line coverage of implementation**                       | Builder's own self-verify step              | Builder | Build loop retries once (up to 2× per task); persistent miss → feature marked `failed`, orchestrator routes to human review                            |
| **80% line coverage total** (builder + tester tests combined) | Tester's `--coverage` run at end of feature | Tester  | `policyCheck: "fail"` in return JSON; orchestrator marks feature `needs-human-review` at gate 4 (sign-off invalidated if coverage regresses below 80%) |

Coverage parsed from the stack skill's test runner output. Each shipped stack skill names the coverage flag explicitly:

- Vitest: `pnpm vitest run --coverage`
- Jest (expo): `pnpm jest --coverage`
- pytest: `uv run pytest --cov=api --cov-report=term-missing`

## What counts as "happy path"

A builder's happy-path test covers:

1. The **canonical success case** of each public function / endpoint / component — the signature the task spec describes.
2. The **primary branch** of any non-trivial conditional. Example: `if (user.tier === "paid")` gets one test with a paid user; edge cases (null user, malformed tier, etc.) are tester territory.
3. **Input validation** at the public boundary — but only the positive case ("valid input produces expected output"); rejection of malformed input is tester territory.

Explicitly NOT happy path (tester writes these):

- Error paths (network failures, DB timeouts, auth rejections, rate-limit hits)
- Boundary conditions (empty arrays, zero-length strings, max-int overflow, negative numbers)
- Concurrency races (two writes arriving same millisecond, dropped connections mid-transaction)
- Malformed input (wrong types, missing required fields, XSS-style strings, unicode edge cases)
- Cross-module interactions (auth middleware + session router behavior when redis is down)

## External-API tests must mock the upstream — CONSTRAINT (bug-119 class)

**Tests for proxy / API-client / external-integration logic MUST mock the external API.** This is a hard constraint, not guidance.

### Why a constraint, not a guideline

Empirical evidence from `repo-health-dashboard-01` (2026-04-30 feat-045 Phase C run): `apps/api/tests/test_edge_cases.py::test_ssrf_guard_rejects_malformed_segments[foo%2e%2e-etc]` calls the FastAPI app with a malformed path expecting a 404/422 SSRF rejection — but when GitHub's unauth rate-limit (60/hr) is exhausted, the proxy returns 429 BEFORE the SSRF guard runs (or after — either way 429 ≠ 404/422). The test result then depends on opaque external state (network, rate-limit bucket, GitHub uptime) instead of the SSRF guard's logic. False-flake masquerades as "intermittent test failure", masking real regressions when they happen.

The same class of bug surfaced earlier in feat-045 Phase B: synthesized E2E for `repo-health-dashboard-01` flows 1/2/3 hit GitHub live, exhausted unauth bucket, and timed out at 30s waiting for responses. Mocking eliminated the flake entirely (8/8 pass in 13.3s deterministically).

### What must be mocked

Any test (unit, integration, E2E) that exercises code which makes an outbound HTTP call to an external service:

- GitHub / GitLab / external git-host APIs
- Open Library / Google Books / external book-data APIs
- Plaid / Stripe / external finance APIs
- OpenAI / Anthropic / external AI APIs
- Email / SMS / push-notification providers
- Any third-party service whose response shape, latency, or rate-limit your code depends on

### Approved mocking primitives by stack

| Stack               | Primitive                                             | Pattern                                                                                                                                                        |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python (pytest)     | `pytest-httpx`                                        | `httpx_mock.add_response(url__regex=..., status_code=..., json=...)` + `assert httpx_mock.get_requests() == []` for "rejected before upstream call" guarantees |
| TypeScript (vitest) | `vi.spyOn(global, "fetch")` or `msw`                  | `vi.spyOn(global, "fetch").mockResolvedValue(new Response(...))`                                                                                               |
| Playwright (E2E)    | `page.route()` (manifest `kind: "mock"` per feat-039) | Author `kind: "mock"` interactions in `user-flows-manifest.json` for synthetic states; synthesizer emits `page.route(new RegExp(urlPattern), ...)`             |

### What MAY hit a real external service

- **Manual sanity (Phase D operator-walk)** — operator-attested checklist file at `docs/manual-sanity-confirmed.txt` that requires the operator to walk happy paths against live data.
- **Smoke tests run with `LIVE_API=1` env gate** — opt-in; never default; never gates CI; documented in stack-skill §Testing as an optional supplementary suite.
- **Nothing else.** Default-on tests must mock.

### Required tester behavior

When the tester encounters or writes a test that hits a real external service without mocking, the tester MUST:

1. Add the mock primitive (per the table above).
2. Re-run the test with the upstream physically unreachable (`unset GITHUB_TOKEN` and disconnect network if necessary) — confirms the mock is doing the work, not relying on real upstream.
3. If the test cannot be made to pass with a mock (e.g. it's an integration test that genuinely needs end-to-end coverage), document why in a comment + add the `LIVE_API=1` gate.

### Cross-references

- `bug-033` (factory-wide) — `scripts/dev.mjs` env propagation; the surface that exposed bug-119's class
- `bug-119` (project: repo-health-dashboard-01) — first concrete instance fixed under this rule
- `feat-039` (factory-wide) — the `mock` InteractionStep kind that makes E2E mocking declarative

## Genuine product bug — CONSTRAINT (bug-024)

**Tester writes test files only.** When an edge-case test fails because the implementation has a bug, the tester FLAGS it via `genuineProductBugs[]` in its return JSON. The tester does NOT modify source files to fix the bug inline. This is a **hard constraint**, not guidance.

### Why a constraint, not a guideline

Empirical evidence from repo-health-dashboard-01 (2026-04-29 launch 7): tester dispatched against `feat-error-states/error-tests` modified `apps/web/components/report/report-client.tsx`, `packages/api-client/src/client.ts`, `packages/api-client/src/types.ts`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, and `apps/web/vitest.config.ts` — none of which are test files. The dispatch hit the 20-min wall-clock abort 2× in a row and the feature was marked permanently failed. ~$5 wasted in fix-don't-flag overreach.

Cross-package mutations in particular (touching `packages/api-client/`) bypass the orchestrator's per-task retry routing — the bug-fix loop assumes failures stay within the originating feature's worktree. Tester source-fixes silently break that assumption.

### Allowed paths

The tester may create or modify files matching ANY of:

- `**/*.test.{ts,tsx,py}` (sibling unit tests)
- `**/*.spec.{ts,tsx,py}` (E2E specs)
- `**/edge-cases.test.*` / `**/integration.test.*` (per-stack-skill conventions)
- `apps/{app}/integration/**` (integration tests)
- `apps/{app}/e2e/**` (Playwright)
- `apps/{app}/.maestro/**/*.yaml` (Maestro)
- `tests/integration/**` (per stack-skill convention)

### Forbidden paths

The tester must NOT create or modify any file matching ANY of:

- Any non-test file under `apps/{app}/src/**`, `apps/{app}/app/**`, or `apps/{app}/components/**`
- Any non-test file under `packages/{any}/src/**`
- Scaffold-owned config files (per bug-023): `vitest.config.ts`, `vitest.setup.ts`, `next.config.ts`, `tailwind.config.ts`, `tsconfig.json`
- `apps/{app}/package.json` or any `packages/{any}/package.json` (dep changes are the builder's lane)
- Any other file outside the explicit allowed list

### Required behavior on a failing test

When an edge-case test fails AND the failure looks like a real bug (matches the task spec's success criteria cleanly, NOT interpretive-latitude noise):

1. Mark the failing task `status: "failed"` in `taskOutcomes`.
2. Add an entry to `genuineProductBugs[]` in the return JSON with the canonical shape:

   ```json
   {
     "task": "<task-id>",
     "file": "<source-path-of-the-bug>",
     "line": <line-number>,
     "expected": "<spec-derived expected behavior>",
     "actual": "<observed behavior from your failing test>",
     "failingTest": "<test-file-path>"
   }
   ```

3. Do NOT modify the source file. The orchestrator re-dispatches the original builder with the failing test as retry context (per refactor-004 per-task retry: max 3).

If the failing test requires interpretive latitude to call "correct behavior" — that's test-authoring noise. Adjust the test, don't flag.

### Anti-patterns that DISQUALIFY interpretive-latitude excuse — investigate-023

The "interpretive latitude" carve-out is for test-authoring noise (selector
ambiguity, async-timing races, fixture-naming nits). It is NOT a license
to mask product bugs by reshaping the test until it passes.

**The following 6 anti-patterns DISQUALIFY interpretive latitude. If your
test-fix iteration includes ANY of them, you MUST flag as
`genuineProductBugs[]` instead.** The post-tester diff audit
(M-D, `orchestrator/src/tester-diff-audit.ts`) detects these mechanically
and rejects the tester's "test fixed" outcome when they appear without a
corresponding flag.

1. **Seed-data shape manipulation** — injecting fixtures whose ID / email /
   format differs from production-realistic format. Example (the
   investigate-023 smoking gun): hardcoding `const BOOK_ID = "1001"`
   (numeric string) when production IDs are CUIDs (`cmovsn7vw...`). If the
   build's `Number(id)` chokes on real CUIDs but works on numeric strings,
   that's a product bug — flag it. Don't inject fake numeric IDs.

2. **URL substitution to match the build** — rewriting the spec's expected
   URL to match what the build emits when the build's URL is wrong per
   spec. Example: the spec asserts the test should land on `/books/<id>`
   after creating a book, but the build redirects to `/books`; tester
   "corrects" the spec to expect `/books`. Wrong — flag the redirect bug.

3. **Assertion loosening** — weakening `expect(x).toBe(y)` to
   `expect(x).toBeDefined()` or `expect(x).toBeTruthy()` because the build
   emits an unexpected value. The original assertion was correct; the
   build's value is the bug. Flag it.

4. **Removed assertions** — deleting `expect()` calls entirely when the
   build can't satisfy them. If the spec had an assertion, that assertion
   represents intended behavior. Removing it = masking the gap. Flag it.

5. **Long-sleep race workarounds** — adding `page.waitForTimeout(N)` with
   N > 1000ms (or similar pause primitives) to make a flaky test stable.
   If the test races a product timing bug, the bug is the race, not the
   test's lack of patience. Flag it. (Sleeps ≤ 1000ms for genuine async
   settle are fine.)

6. **Type-coercion fixtures** — adding `Number(...)` / `String(...)` /
   `parseInt(...)` / similar conversion logic specifically to make the
   build's incorrect type handling work. If the build passes a CUID where
   a number is expected (or vice versa), that's a type bug — flag it.

**Empirical motivator**: reading-log-01 /fix-bugs run 2026-05-07
($35.63, 6h 7m, 17-of-18 reported as "resolved"). Manual review surfaced
9+ bugs that map directly to "resolved" entries. Smoking gun was commit
b83e39a (flow-3 spec): tester hardcoded `BOOK_ID = "1001"` into seed
fixtures + literally documented "Numeric-string ID so the detail page's
Number(id) conversion works correctly" — instead of flagging the
Number(id)-on-CUID bug. User-visible result: real CUID-based deletes
return 400 in production. ~50% of the bug-fix-loop's "resolved" count
was empty (test passed, no product fix).

### Cross-references

- `.claude/agents/tester.md` §Hard constraint — primary enforcement surface (system prompt)
- `.claude/skills/tester/SKILL.md` §Hard constraint — skill-driven dispatch context mirror
- `plans/archive/bug-024-tester-modifies-source.md` — the bug that motivated promoting this from guidance to constraint
- `plans/active/investigate-023-tester-prefers-spec-fixes-over-flagging-product-bugs.md` — the investigation that surfaced the 6-anti-pattern checklist
- `orchestrator/src/tester-diff-audit.ts` (M-D) — mechanical post-tester audit that detects + rejects these anti-patterns

## Spec-enrichment scope-out — CONSTRAINT (bug-133)

**Tester must NOT write tests for behavior the project's `brief.md` explicitly scopes OUT.** This is a hard constraint, not guidance. It is the **inverse** of the 6 anti-patterns in §"Genuine product bug — CONSTRAINT (bug-024)": those detect masking a real bug by reshaping a test; this detects _creating_ an unreal requirement by writing a test for a scenario the brief never asked for.

### Why a constraint, not a guideline

Empirical evidence from `gotribe-auth-signup` feat-email-stub (2026-05-18): tester wrote 2 tests asserting `createEmailProvider()` throws when `NODE_ENV=production && !RESEND_API_KEY`, but `brief.md:131` explicitly said **"Production — NOT deployed. This is a curriculum slice; the deployment pipeline exists for completeness… no production hosting is provisioned."** The contested tests burned the tester's 2-retry budget. Backend-builder refused to add the unspecified prod-fail-fast guard (correctly — the brief doesn't ask for it). Feature marked `failed`; 3 downstream P0 features cascade-aborted; ~3 hours of orchestrator wall-clock + operator triage wasted.

The hybrid-TDD model deliberately encourages the tester to write edge-case tests beyond what the builder authored (per §"Who authors what"). That latitude has an unstated boundary the rule didn't capture: when the brief _explicitly scopes a runtime / capability OUT_, edge-case authoring for that runtime is no longer edge-case-of-spec — it's spec-invention.

### Two cases the tester must distinguish

| Case                 | What the brief says                                                                 | What the tester does                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Brief-scoped-out** | Brief explicitly excludes the runtime/capability (e.g. "Production — NOT deployed") | Do NOT write the test. Mechanical audit (`tester-diff-audit.ts`) rejects the dispatch as a `brief-scoped-out-enrichment` violation.                                |
| **Brief-silent**     | Brief doesn't mention the behavior at all                                           | If the defensive guard feels valuable, populate `TesterOutput.enrichmentSuggestion[]` (advisory; surfaces to reviewer; does NOT route to builder; does NOT block). |
| **Brief-required**   | Brief explicitly requires the behavior + the builder didn't ship it                 | Write the test + populate `TesterOutput.genuineProductBugs[]` (routes to builder via bug-121; burns retry budget; blocks if not flagged).                          |

### What counts as brief-scoped-out

The `tester-diff-audit.ts` `detectBriefScopedOutEnrichment()` heuristic v1 matches ANY of these phrases in `brief.md` (case-insensitive):

- `Production — NOT deployed`
- `Production [is/are] NOT deployed`
- `--- production scope: deferred ---`
- `Production[…] out of scope`

…paired with an added test line matching:

- `process.env.NODE_ENV = "production"`
- `process.env["NODE_ENV"] = "production"`

The detector fires ONLY when BOTH conditions hold. Future versions extend the regex tables for other scope-out classes (mobile-only / web-only / deferred-capability).

For projects that want structured opt-in beyond prose grep, future PMs may add `scopedOut[]: [{summary, source, reason}]` to `docs/brief-capabilities.json` (proposed v2; not required for v1).

### Required tester behavior

When you're considering writing an edge-case test that exercises behavior the builder didn't ship:

1. **Read `brief.md` first.** Search for the runtime / capability your test would target. Match against the scope-out phrases above.
2. **If brief-scoped-out** → don't write the test. If you genuinely believe the brief is wrong, escalate via `/plan-investigation` — don't smuggle the requirement in via a test.
3. **If brief-silent + you still want to flag** → populate `enrichmentSuggestion[]` instead. The reviewer sees it; the builder doesn't get re-dispatched.
4. **If brief-required + builder missed it** → write the test + populate `genuineProductBugs[]`. Standard bug-121 routing applies.

### What `detectBriefScopedOutEnrichment` does on violation

(Reference: `orchestrator/src/tester-diff-audit.ts` — sibling pass to the 6 investigate-023 anti-pattern detectors.)

1. Reads `brief.md` from the worktree root (best-effort; missing brief silently disables the detector).
2. If `brief.md` matches a scope-out phrase AND the tester's diff exercises that scope, emits a `BriefScopedOutEnrichment` `AuditViolation` (per file, per line).
3. Returned in `result.blocking[]` when the tester did NOT populate `genuineProductBugs[]` (signals the tester didn't acknowledge a real bug).
4. The orchestrator's `injectAuditViolations()` stamps the violation onto every task's `errors[]` entry; the dispatch is marked failed; the standard tester retry ladder fires.
5. The next dispatch's pre-loaded context surfaces the violation list verbatim, so the tester sees WHY its prior attempt was rejected.

### Cross-references

- `plans/active/bug-133-tester-spec-enrichment-scope-out.md` — the bug plan that introduced this policy.
- `plans/active/investigate-035-tester-enrich-dispatch-logs.md` — the parent investigation (Q1 = this rule + Q2 = bug-132 dispatch transcripts).
- `plans/active/investigate-023-tester-prefers-spec-fixes-over-flagging-product-bugs.md` — the parallel investigation for the INVERSE class (tester masks bugs by reshaping tests).
- `.claude/agents/tester.md` §Brief scope-out — primary enforcement surface (system prompt).
- `.claude/skills/tester/SKILL.md` §Brief scope-out — skill-driven dispatch context mirror.
- `orchestrator/src/tester-diff-audit.ts::detectBriefScopedOutEnrichment` — the mechanical detector.
- `packages/orchestrator-contracts/src/tester.ts::EnrichmentSuggestion` + `TesterOutput.enrichmentSuggestion` — the advisory channel schema.

## E2E data-seeding strategy (feat-038 Phase 0)

E2E tests need data to exist in the system before they can assert on UI states (e.g. "the archive button only appears when ≥1 card is in the Done column"). The strategy is **stack-determined by the project's persistence layer**, not a one-size-fits-all global choice.

### Strategy by persistence layer

| Persistence layer the project uses                                       | Strategy            | Pattern                                                                                                                                                   | Cost per test |
| ------------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **`localStorage` only** (Zustand-persist, no backend mutation tier)      | A — per-test reseed | `test.beforeEach: localStorage.clear() + reload`; per-test `localStorage.setItem` for non-empty starting state                                            | ~10ms         |
| **External-only API + in-memory proxy cache** (no project-managed DB)    | D — interception    | `page.route("**/api/<path>", ...)` to fake responses; tests run without the real backend reachable                                                        | ~0ms          |
| **Real backend + DB** (FastAPI/Express/etc. with project-managed schema) | C — hybrid          | `globalSetup` seeds read-only baseline via a gated `/test/seed` endpoint; mutation flows wrap in `test.describe.serial` with their own beforeAll/afterAll | ~50–500ms     |

Each shipped stack skill's `§Testing` block declares which strategy applies based on the `architecture.yaml.tooling.stack.persistence_layer` slot. A single project may need to mix strategies at the test-suite level — e.g. a project with both an external API (intercept) and a project-managed user-prefs DB (hybrid) would split its E2E into two directories with distinct seeding patterns.

### Empirical motivation (audit at feat-038 time)

- `kanban-webapp-09` (shipped, mutation-heavy) — Strategy A. `apps/web/e2e/board.spec.ts:23` uses `test.beforeEach: localStorage.clear() + reload`. Per-test cost effectively zero.
- `repo-health-dashboard-01` (shipped, external-API only) — Strategy D. `apps/web/e2e/compare.spec.ts:15` uses `page.route("**/api/report/**", ...)` to fake the GitHub-proxy responses. No backend needed.
- `book-swap` / `finance-track` (pre-builds, real-DB) — would need Strategy C when E2E lands. No shipped pattern yet; first project to ship will define the canonical `/test/seed` endpoint shape.

### Strategy-C-test-seed-contract (bug-042 Phase A.5/B — 2026-05-03)

**Strategy C is uniform across backend stacks.** Whether the backend is FastAPI, Fastify, Nest, or Express, the project MUST expose THREE gated endpoints under `/test/*`, registered ONLY when `ENABLE_TEST_SEED=1` is set in the environment. Stack-specific implementations live in each backend skill's `§E2E data-seeding strategy` section; the contract below is the cross-stack canonical:

| Endpoint                   | Request                                            | Response    | Behavior                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /test/seed`          | `{ "fixtures": { "<table>": [<row>, ...], ... } }` | `204` on ok | Bulk-insert each row in a single transaction. Tables not in the per-project whitelist throw `400`.                                                                                                                                        |
| `POST /test/cleanup`       | `{ "tables": ["<table>", ...] }`                   | `204` on ok | `DELETE FROM <table>` for each whitelisted table. Unknown tables silently ignored.                                                                                                                                                        |
| `POST /test/seed-baseline` | `{}` (empty)                                       | `204` on ok | Wraps the project's existing `db/seed.{ts,py}` so playwright globalSetup gets the FULL read-only baseline (accounts/users/listings/...) with ONE call instead of duplicating ~150 lines of fixture data into the playwright global-setup. |

**Why `/test/seed-baseline` is mandatory** (the bug-042 root cause): empirical case 2026-05-02 finance-track-01 — global-setup seeded ONLY fx_cache (11 rows), every read-only flow landed on "No accounts yet" because the dashboard's load query found zero accounts. The stack-skill `db/seed.ts` already had the canonical seeder; the global-setup just couldn't reach it. `/test/seed-baseline` closes the gap with one source of truth.

**Cross-stack reference implementations** (added bug-042 Phase A.5):

- `node-fastify`: `.claude/skills/agents/back-end/node-fastify/SKILL.md §3 → testSeedRoutes` — `app.post("/seed-baseline", ...)` imports `seed` from `../db/seed.js`
- `python-fastapi`: `.claude/skills/agents/back-end/python-fastapi/SKILL.md §3 → /test/seed-baseline` — `seed_baseline` imports `seed` from `api.db.seed`
- `node-trpc-nest`: `.claude/skills/agents/back-end/node-trpc-nest/SKILL.md §3 → TestSeedController.seedBaseline` — imports `seed` from `../../prisma/seed`

The `seed()` function is ALSO CLI-invokable per each stack's package.json scripts (`pnpm --filter @repo/api db:seed` for node-\*; `uv run python -m api.db.seed` for python-fastapi). Two callers (CLI + test endpoint), one definition.

**Empirical reference**: `projects/finance-track-01/apps/api/src/routes/test-seed.ts` already implements `/test/seed` + `/test/cleanup` for node-fastify (the canonical pattern; needs `/test/seed-baseline` added per Wave 2 project-side recovery).

### `synthesize-flow-e2e` synthesizer integration (feat-038 Phase 1+)

When the synthesizer (`scripts/synthesize-flow-e2e.mjs`) deepens beyond the current `page.goto("/")`-only output, generated specs must opt into the right strategy:

1. **Manifest schema extension** — each flow's entry in `docs/user-flows-manifest.json` declares `seedingTier: "read-only" | "mutation"` so the synthesizer knows how to scope per-spec setup.
2. **Strategy resolution at synthesis time** — synthesizer reads `architecture.yaml.tooling.stack.persistence_layer` + the flow's `seedingTier` and emits the appropriate Playwright pattern (localStorage-clear / page.route / `/test/seed`).
3. **Per-stack helpers** — `apps/web/e2e/helpers/seed-{strategy}.ts` (factory-supplied via stack skill scaffold) so spec authors and the synthesizer use the same primitives.

### Cross-references

- `.claude/skills/agents/front-end/react-next/SKILL.md §Testing` — strategy declaration for React + Next consumers (one of A/D depending on stack composition).
- `.claude/skills/agents/back-end/python-fastapi/SKILL.md §Testing` — strategy declaration for FastAPI consumers (C when DB-backed, D when proxy/cache only).
- `plans/active/feat-038-deepen-synthesize-flow-e2e-and-data-seeding.md §Phase 0 — Decision` — the full reasoning + benchmark expectations.

## WebSocket flows (feat-076)

Projects with real-time WS surfaces (channel chat, presence rails, live message streams) extend Strategy C with a fourth gated endpoint — `POST /test/ws-event` — that injects synthetic frames onto a channel's in-process subscriber set. Lets E2E specs assert client-side reaction WITHOUT orchestrating two browser contexts (which is the canonical flake-source). Two patterns are canonical:

- **Pattern A** — single-context Playwright + `request.post("/test/ws-event", ...)` for deterministic asserts. ~80% of WS specs.
- **Pattern B** — two-browser-context broadcast (`browser.newContext()` × 2) for the canonical happy-path "send/receive actually works" assertion. ~20% of WS specs.

Both patterns require `ENABLE_TEST_SEED=1` on the running dev server (same gate as the other `/test/*` endpoints).

### Cross-references

- `.claude/skills/agents/front-end/react-next/SKILL.md §"E2E for WebSocket flows"` — Pattern A + B Playwright reference shapes
- `.claude/skills/agents/back-end/node-fastify/SKILL.md §"E2E for WebSocket flows — server-side contract"` — `/test/ws-event` Fastify handler + channel-existence guard
- `plans/archive/feat-076-ws-aware-e2e-stack-skill-blocks.md` — empirical motivator (gotribe-tribe-chat `feat-channel-view` tester wall-clock stall 2026-05-18)
- `gotribe-briefs/tier-1-atomic.md` §09 — curriculum brief that surfaced the gap

**Anti-pattern**: connecting a raw `ws` client inside Playwright's test body and orchestrating frames against the running app's WS endpoint. Couples the test to the wire protocol + requires reimplementing the kit's WS-client reducer. Use Patterns A + B above instead.

**Tester stall-class**: WS testing without a canonical pattern reliably triggers `error_stall_timeout`. If a tester dispatch is in flight on a WS feature and silent > 5 min, the orchestrator's wall-clock cap is justified — abort + force-merge the builder's committed work + file the lost-edge-cases as follow-up tests.

## Stack-skill integration

Every shipped stack skill (`.claude/skills/agents/{tier}/{stack-slug}/SKILL.md`) has a §Testing section documenting:

- Test-file naming convention
- Test runner command (with + without coverage)
- Mocking patterns (db, http, clock, tRPC, etc.)
- One example test (arrange / act / assert in the stack's idiom)
- Minimum coverage expectation — restated from THIS file so the builder sees the threshold in its dispatch context

Future stack skills added by `/skills-audit --scope=build --auto-author-stack-skills` must fill the §Testing section against this policy.

## When this policy doesn't apply

- **Data-only tasks** (seed scripts, data migrations, one-off cron jobs) — happy-path test required, edge-case + integration + E2E not required. PM should group these into single-task features with `agent_sequence: [backend-builder, reviewer]` (no tester step).
- **Config-only changes** (bump a dependency, update a token) — no new tests; tester runs the full existing suite unchanged to confirm no regression.
- **Stack-skill-declared exceptions** — a stack skill's §Testing block may narrow or widen these defaults for its ecosystem (e.g. Flutter's integration_test framework pattern may restructure what counts as "integration" vs "E2E").

## Retry ladder (cross-references refactor-004)

- **Builder test-authoring failure** → builder retries (max 2× per task) with stack-skill §Gotchas as hint-context.
- **Tester test-authoring failure** (tester's own bug) → tester retries (max 3 iterations).
- **Tester flags a genuine product bug** → task marked failed; orchestrator re-invokes builder with tester's failing test as context (per-task retry, max 3).
- **All retries exhausted** → feature marked `failed` in tasks.yaml; human review at gate 4.

## Cross-references

- `scaffolding/14-028-backend-builder-agent.md` §TDD policy — binds to this file
- `scaffolding/15-029-web-frontend-builder.md` §TDD policy — binds to this file
- `scaffolding/16-030-mobile-frontend-builder.md` §TDD policy — binds to this file
- `scaffolding/17-031-tester-agent.md` §Testing Strategy — binds to this file
- `plans/active/feat-004-builder-tdd-hybrid.md` — the plan that introduced this file
- Each shipped stack skill's §Testing block (`.claude/skills/agents/{tier}/{stack-slug}/SKILL.md`)
