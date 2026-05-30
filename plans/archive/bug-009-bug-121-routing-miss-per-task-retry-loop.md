---
id: bug-009-bug-121-routing-miss-per-task-retry-loop
type: bug
status: archived
outcome: success
author-agent: Claude (post-investigate-004)
created: 2026-05-30
updated: 2026-05-30
closed-at: 2026-05-30
parent-plan: investigate-004-e2e-stall-mode-b-run-2
supersedes: null
superseded-by: null
branch: fix/bug-121-routing-miss-retry-loop
affected-files:
  - orchestrator/src/feature-graph.ts
  - orchestrator/tests/feature-graph.test.ts
feature-area: mode-b-build-orchestration
priority: P0
attempt-count: 0
max-attempts: 5
error-message: "bug-121 tester→builder routing block in feature-graph.ts:1849-1988 only checks `result.genuineProductBugs` after the FIRST tester dispatch. When attempt-1 stalls (no parseable JSON → genuineProductBugs undefined), routing is skipped and code falls through to the per-task retry loop (line 1991-2029) which is BLIND to `retryResult.genuineProductBugs`. By the time tester-attempt-3 returns structured diagnostic with builderAgent + taskId, the per-task retry loop reads only `taskStatus.failed` and the structured field is dropped on floor."
reproduction-steps: "Force a tester to stall on attempts 1 + 2, return genuineProductBugs[] on attempt 3. Observe: orchestrator marks feature failed without dispatching the originating builder. Empirical reproduction: test-app Mode B Run 2 feat-home tester-attempt-3.json has genuineProductBugs[{builderAgent: web-frontend-builder, taskId: home-screen, ...}] but no web-frontend-builder-attempt-3.json was dispatched. Builder task-retry counter was at 1 (max-3 → 2 remaining)."
stack-trace: null
---

# bug-009-bug-121-routing-miss-per-task-retry-loop: bug-121 tester→builder routing fires only on first dispatch; misses the structured genuineProductBugs[] surfaced inside per-task retry loop

## Bug Description

**Expected behavior**: when the tester returns `genuineProductBugs[]` populated with `builderAgent + taskId`, the orchestrator re-dispatches the originating builder with the bug as `retryContext.errorMessage` — regardless of whether the structured surface arrived on tester attempt-1, attempt-2, or attempt-3. Provided the originating builder still has retry budget, the routing should fire.

**Actual behavior** (per investigate-004 findings Q2): bug-121 routing block at feature-graph.ts:1849-1988 only inspects `result.genuineProductBugs` where `result` is the InvokeAgentResult from the FIRST `invokeAgent` call (line 1376). The per-task retry loop (line 1991-2029) re-dispatches the tester but reads ONLY `retryResult.taskStatus[t.id]`:

```ts
const retryResult = await ctx.invokeAgent({
  agent: agentName,    // HARDCODED to tester
  ...
});
if (retryResult.taskStatus[t.id] === "completed") { ... break; }
taskOutcomes[t.id] = "failed";
result.errors[t.id] = retryResult.errors[t.id] ?? ...
// retryResult.genuineProductBugs is NEVER READ here
```

When tester-attempt-3 returns `taskStatus.failed + genuineProductBugs: [{builderAgent: "web-frontend-builder", taskId: "home-screen"}]`, the orchestrator:

1. Reads `taskStatus.failed` → marks `taskOutcomes.failed`
2. Loop iteration ends; counter at 3 (= TASK_RETRY_CAP) → `isExhausted()` true → loop exits
3. Feature finishes failed with abortReason `"task home-e2e failed after 3 attempts: ..."`
4. **The structured `genuineProductBugs[]` is silently dropped.** No builder re-dispatch.

## Reproduction Steps

**Real empirical case**: `projects/test-app/.claude/state/15a61239-0758-4fd9-8eca-dfe33f609c52/dispatches/feat-home/`

- `tester-attempt-1.json` — stalled at wall-clock-1800000ms; no output.genuineProductBugs
- `tester-attempt-2.json` — stalled at wall-clock-1800000ms; no output.genuineProductBugs
- `tester-attempt-3.json` — completed (15min); `output.genuineProductBugs[0] = {taskId: "home-screen", builderAgent: "web-frontend-builder", testFile: "apps/web/e2e/home.spec.ts", testName: "...", failureMessage: "page.goto load timeout", likelyCause: "..."}`
- `web-frontend-builder-attempt-1.json` — stalled
- `web-frontend-builder-attempt-2.json` — completed (resolved earlier stall)
- **`web-frontend-builder-attempt-3.json` — MISSING**. bug-121 routing did not fire.

Counters: `feat-home/home-screen: 1` (builder budget remaining = 2). Should have routed.

Synthetic unit test reproduction (add to feature-graph.test.ts):

```ts
test("bug-009 — tester returns genuineProductBugs[] on retry after stalls → routes to builder", async () => {
  const dispatches: string[] = [];
  let testerCallN = 0;
  const ctx = makeFeatureGraphContext({
    invokeAgent: async ({ agent, retryContext }) => {
      dispatches.push(agent);
      if (agent === "tester") {
        testerCallN++;
        if (testerCallN < 3) {
          return {
            taskStatus: { "home-e2e": "failed" },
            errors: { "home-e2e": "error_stall_timeout: wall-clock-1800000ms" },
            costUsd: 0,
          };
        }
        // attempt-3 returns structured diagnostic
        return {
          taskStatus: { "home-e2e": "failed" },
          errors: { "home-e2e": "page.goto load timeout..." },
          genuineProductBugs: [
            {
              taskId: "home-screen",
              builderAgent: "web-frontend-builder",
              testFile: "apps/web/e2e/home.spec.ts",
              testName: "home renders hero",
              failureMessage: "page.goto load timeout",
              likelyCause: "external CDN images block window.load",
            },
          ],
          costUsd: 0,
        };
      }
      if (agent === "web-frontend-builder") {
        return {
          taskStatus: { "home-screen": "completed" },
          errors: {},
          costUsd: 0,
        };
      }
      return { taskStatus: {}, errors: {}, costUsd: 0 };
    },
    feature: makeFeature({
      id: "feat-home",
      tasks: [
        { id: "home-screen", agent: "web-frontend-builder" },
        { id: "home-e2e", agent: "tester" },
      ],
    }),
  });

  const result = await runFeature(ctx);

  // After bug-009 fix: builder dispatched on attempt 3 of the tester (when genuine bug surfaced),
  // builder completes, tester re-runs once + verifies → feature completes.
  expect(result.status).toBe("completed");
  expect(
    dispatches.filter((d) => d === "web-frontend-builder").length,
  ).toBeGreaterThanOrEqual(2); // initial + bug-121 retry
});

test("bug-009 — no regression on first-dispatch bug-121 path", async () => {
  // Same flow but tester returns genuineProductBugs on ATTEMPT 1.
  // Existing bug-121 routing should fire as before.
});
```

## Error Output

Feature-graph state at terminal:

```
[feature-graph] feat-home failed: task home-e2e failed after 3 attempts: All 17 E2E tests timeout at page.goto('/') because apps/web/app/page.tsx loads external CDN images (picsum.photos, unsplash.com) that block window.load in the Playwright test environment
```

The `genuineProductBugs[]` structured payload — diagnosing the bug to single-line precision — was present in the tester output but the orchestrator never used it.

## Root Cause Analysis

bug-121 (2026-05-18) wired tester→builder routing for the case where the tester returns `genuineProductBugs[]` on its FIRST dispatch. The code:

```ts
const result = await ctx.invokeAgent({ agent: agentName, ... });
// ... reviewer/security routing blocks ...
if (agentName === "tester" && result.genuineProductBugs && result.genuineProductBugs.length > 0) {
  // Route to originating builder
}
// Per-task retry
for (const t of agentTasks) {
  if (result.taskStatus[t.id] !== "failed") continue;
  while (!ctx.retryCounters.isExhausted(...)) {
    const retryResult = await ctx.invokeAgent({ agent: agentName, ... });
    if (retryResult.taskStatus[t.id] === "completed") break;
    taskOutcomes[t.id] = "failed";
    // retryResult.genuineProductBugs is silently dropped
  }
}
```

The structural problem: the bug-121 routing block sits between the first dispatch and the per-task retry loop. The retry loop's `retryResult` shape is identical to `result` (same InvokeAgentResult type with optional `genuineProductBugs?: GenuineProductBugType[]`) — but the retry loop doesn't inspect that field.

**Mode B parallels**: this is the third instance of "retry-target routing surface needs orchestrator-side plumbing" — bug-007 (security), bug-109 (reviewer), bug-121 (tester first dispatch). Each time the schema field was present, only the orchestrator dispatch path was missing. bug-009 extends bug-121 to cover the per-task retry surface.

## Fix Approach

Single-file minimal-diff orchestrator fix:

### Part A — feature-graph.ts per-task retry loop

In `orchestrator/src/feature-graph.ts`, after the existing `retryResult` is captured (around line 2019) and before the `taskStatus !== "completed"` branch (line 2022), insert a bug-009 check:

```ts
// bug-009 (post-investigate-004): if the tester's RETRY produced structured
// genuineProductBugs[], route to the originating builder before declaring the
// task irrecoverable. Mirrors the bug-121 first-dispatch routing block at
// line 1849, but on the retry-loop surface where the original routing
// was blind.
if (
  agentName === "tester" &&
  retryResult.genuineProductBugs &&
  retryResult.genuineProductBugs.length > 0 &&
  retryResult.taskStatus[t.id] !== "completed"
) {
  // Reuse bug-121's routing helper (extract first if not already shared):
  //   - group by originatingTaskId
  //   - for each: if builder retry budget remaining, dispatch with HARD CONSTRAINT envelope
  //   - on builder completion, re-run tester ONCE to verify (capped to 1 verify pass)
  //   - if all builders complete + tester verifies → taskOutcomes[t.id] = "completed", break
  // Otherwise fall through to the current failure path.
  const routed = await routeBug121ToBuilder(
    ctx,
    feature,
    retryResult.genuineProductBugs,
    worktreeCwd,
    featureContext,
    agentTasks,
  );
  if (routed.allResolved) {
    taskOutcomes[t.id] = "completed";
    result.taskStatus[t.id] = "completed";
    break;
  }
}
```

The `routeBug121ToBuilder` helper is the refactored version of the lines 1853-1983 block — extracting it into a function lets both call sites (first-dispatch routing at 1849 AND retry-loop routing here) share one implementation.

### Part B — feature-graph.test.ts coverage

Add 2 new test cases to `orchestrator/tests/feature-graph.test.ts` in a new `describe("runFeature — bug-009 tester retry-loop routing")` block:

1. **"routes genuineProductBugs[] surfaced on tester attempt 3 (after attempts 1+2 stalled) to builder"** — verifies the empirical case. Tester mock returns failed-no-bugs twice, then failed-with-bugs. Builder mock returns completed. Feature should end completed; builder dispatched ≥2 times (initial + bug-009 retry).
2. **"no regression on first-dispatch routing"** — tester returns genuineProductBugs[] on attempt 1; existing bug-121 path should still fire. Builder dispatched ≥2 times. Feature completes.

### Part C — refactor extraction (optional in v1)

Refactor lines 1853-1983 into a private `routeBug121ToBuilder()` helper so the first-dispatch path + retry-loop path share one implementation. If v1 ships only the retry-loop branch without extraction, the existing first-dispatch block remains; just duplicate the routing logic inline at the retry-loop site. Future refactor candidate: consolidate bug-007 (security routing) + bug-109 (reviewer routing) + bug-121/bug-009 (tester routing) into a generic `routeFindingsToAgent<TFindings>` helper. Deferred until 4th class needs the treatment or operator approves the refactor as a separate plan.

## Rejected Fixes

1. **Loosen the wall-clock cap so tester attempt-1 doesn't stall** — addresses symptom not cause. Even if attempt-1 always completes, a future tester could still produce genuineProductBugs[] inside the retry loop after authoring-time errors on earlier attempts.
2. **Move the bug-121 check INSIDE the while loop body** — that's what Part A does; the question is just whether to extract the helper. v1 can inline.
3. **Pre-compute genuineProductBugs across all attempts and check at the end** — over-engineered. The retry loop's natural surface to insert the check is right after `retryResult` is captured.
4. **Reorder: check routing BEFORE updating taskOutcomes** — current code orders the assignment correctly; Part A's check sits before the final failure-record-write, which is the intended insertion point.

## Validation Criteria

**Empirical reproduction case** — `projects/test-app/.claude/state/15a61239-0758-4fd9-8eca-dfe33f609c52/dispatches/feat-home/` shows the missing web-frontend-builder-attempt-3.json.

**Pass conditions** (after Part A + B land):

1. New unit test `routes genuineProductBugs[] surfaced on tester attempt 3 to builder` passes.
2. New unit test `no regression on first-dispatch routing` passes.
3. Existing 74 feature-graph tests still pass (no regression on bug-007 security routing, bug-109 reviewer routing, bug-121 first-dispatch tester routing).
4. Re-run Mode B against test-app's 5 failed features (assuming bug-008's screens fix has also landed). If only bug-009 ships without bug-008, the routing fires but the builder can't fix the underlying picsum/unsplash class on its own.

**Cross-references**:

- `investigate-004` — the parent investigation
- `bug-008` — sibling fix (screens preamble); together they recover the 5 failed test-app features
- `bug-007` — analogous routing fix (security agent)
- `bug-109` — analogous routing fix (reviewer agent)
- `bug-121` — the original tester routing fix this extends
- LESSONS.md candidate entry: _"Retry-target routing must be checked at EVERY dispatch surface (first dispatch + per-task retry + future surfaces). When a structured-finding field is optional on InvokeAgentResult, every code path that handles the result must explicitly inspect it; the per-task retry default 'check only taskStatus' silently drops valuable diagnostics."_

## Attempt Log

<!-- Populated automatically by agents. -->
---

## Completion Record (2026-05-30)

**Outcome: SUCCESS** — bug-009 per-task retry-loop routing fix shipped + 76/76 feature-graph tests pass.

### Ship summary

**Part A — `orchestrator/src/feature-graph.ts`**:

- Inserted ~140 LOC routing block in per-task retry loop at line ~2020 (after `retryResult.lastWritingAgent` assignment, before the `taskStatus.completed` check).
- Mirrors bug-121 first-dispatch routing algorithm:
  1. If `agentName === "tester"` && `retryResult.genuineProductBugs.length > 0` && retry not yet complete
  2. Group bugs by originating task ID; for each task, check builder retry budget, increment counter, dispatch with HARD CONSTRAINT envelope inlining bug payload
  3. Commit builder's work post-dispatch (so subsequent tester re-run sees fresh code)
  4. After all builder dispatches, re-run tester ONCE for current task to verify
  5. If tester verify passes → mark task completed, break while loop
  6. Otherwise → fall through to legacy failure path
- HARD CONSTRAINT envelope shape mirrors bug-007 + bug-121 conventions.

**Part B — `orchestrator/tests/feature-graph.test.ts`**:

- 2 new tests in `describe("runFeature — bug-009 tester retry-loop routing")` block:
  1. "routes genuineProductBugs[] surfaced on tester attempt 3 (after attempts 1+2 stalled) to builder" — directly exercises the empirical test-app case. Builder dispatched=2, tester dispatched=4 (3 initial+retries + 1 verify). bug-009 envelope contains `HARD CONSTRAINT` + `TESTER FLAGGED GENUINE PRODUCT BUG` + `picsum.photos|unsplash.com` substring.
  2. "no regression on first-dispatch bug-121 routing (tester returns genuineProductBugs[] on attempt 1)" — first-dispatch path still works. Builder=2, tester=2.

**Part C — refactor extraction**: deferred. Inline duplicate of bug-121 shape kept for minimal-diff. Future refactor candidate: factor bug-007 (security) + bug-109 (reviewer) + bug-121/bug-009 (tester) into generic `routeFindingsToAgent<TFindings>` helper. Awaiting 4th class need or explicit operator-approved refactor plan.

### Test verdict

```
cd orchestrator && pnpm vitest run tests/feature-graph.test.ts
Test Files  1 passed (1)
     Tests  76 passed (76)
              — 74 existing tests still pass
              — 2 new bug-009 tests pass
  Duration  2.92s
```

No regression to bug-007 security routing, bug-109 reviewer routing, or bug-121 first-dispatch tester routing.

### Empirical re-validation deferred

The in-flight orchestrator process during test-app Mode B Run 2 used OLD code (pre-bug-009). Live empirical re-validation requires next operator-driven Mode B re-run on test-app's 5 failed features. Order-of-ship matters: bug-008's screens fix should land first (so the picsum/unsplash URLs are gone from production code on the next builder dispatch), then bug-009's routing fix catches any remaining product bugs the tester surfaces.

### Lessons

1. **Retry-target routing must be checked at EVERY dispatch surface (first dispatch + per-task retry + future surfaces).** When a structured-finding field is optional on `InvokeAgentResult`, every code path that handles the result must explicitly inspect it. The per-task retry default ("check only taskStatus") silently drops valuable diagnostics.
2. **The fix shape REPLICATES across agent classes and dispatch surfaces.** bug-109 (reviewer first-dispatch) → bug-121 (tester first-dispatch) → bug-007 (security first-dispatch) → bug-009 (tester per-task retry). Same parse-then-loop algorithm, same HARD CONSTRAINT envelope, same retry-counter semantics. With 4 instances now, the refactor case for a generic `routeFindingsToAgent` helper is strong; deferred per minimal-diff principle but should be explicit-plan candidate.
3. **Cascade-masking hides routing bugs at multiple layers.** bug-006 (parallel-conflict cascade) hid bug-007 (security routing) — both shipped 2026-05-30. bug-007's run then hit bug-008 (screens external CDN) + bug-009 (tester retry-loop routing) — both shipping in this same commit. Each layer of masking only surfaces when the previous fix unblocks the cascade.

### Cross-references

- Empirical motivator: test-app Mode B Run 2 feat-home (2026-05-30) tester-attempt-3.json genuineProductBugs[] + missing web-frontend-builder-attempt-3.json
- Parent: investigate-004 (Q2 findings)
- Sibling shipping in same commit: bug-008 (screens preamble external CDN URLs)
- Template fix shapes: bug-007 (security routing), bug-109 (reviewer routing), bug-121 (tester first-dispatch)
- feature_list: phase2-step-024
- phase-plan: §F Row 042
- LESSONS.md candidate: see lessons §1 above

### Commits

- This commit bundles:
  - `orchestrator/src/feature-graph.ts` (bug-009 routing block)
  - `orchestrator/tests/feature-graph.test.ts` (2 routing tests)
  - `phase-plan.md` §F Row 042
  - `feature_list.json` phase2-step-024 row
  - `evidence/phase2-step-024-result.txt`
  - `plans/archive/bug-008-screens-preamble-external-cdn-urls.md` (sibling)
  - `plans/archive/bug-009-bug-121-routing-miss-per-task-retry-loop.md` (this archive)

Closed by Phase 2 build operator (David Morgan / Claude opus-4-7) 2026-05-30.
