---
id: bug-010-security-agent-prose-only-output
type: bug
status: archived
outcome: success
author-agent: Claude (post-empirical-Run-3 triage)
created: 2026-05-30
updated: 2026-05-30
closed-at: 2026-05-30
parent-plan: null
supersedes: null
superseded-by: null
branch: fix/security-prose-only-output-contract
affected-files:
  - .claude/agents/security.md
  - orchestrator/src/invoke-agent.ts
  - orchestrator/src/feature-graph.ts
  - orchestrator/tests/feature-graph.test.ts
feature-area: mode-b-build-orchestration
priority: P0
attempt-count: 0
max-attempts: 5
error-message: "Security agent emits prose-only findings in errors[] instead of structured SecurityAgentOutput.findings[]. bug-007 routing condition `result.securityOutput && verdict !== approved` evaluates false → routing skipped → falls through to legacy per-task retry loop which re-dispatches SECURITY 3× against unchanged code → retry cap exhaustion → feature failed."
reproduction-steps: "Run Mode B on a feature with security in agent_sequence. When security finds P1+/P2 issues but returns prose-only output (no structured securityOutput JSON), orchestrator silently fails to route per bug-007. Empirical: test-app feat-analytics-observability Run 3 (2026-05-30 09:00Z) security-attempt-7/8/9 all returned `securityOutput: undefined`, taskStatus: failed, errors: prose-narrative. Builder never re-dispatched; feature cascade-failed feat-deployment."
stack-trace: null
---

# bug-010-security-agent-prose-only-output: Security agent emits prose-only `errors[]` bypassing SecurityAgentOutput contract; bug-007 routing skipped silently

## Bug Description

**Expected behavior**: when security agent finds issues, it returns `SecurityAgentOutput` JSON wrapped in `<<<TASK_OUTCOME>>>...<<<END_TASK_OUTCOME>>>` sentinels per its agent-md contract. The output includes `findings[].retryTarget` for each finding so bug-007 routing can dispatch the builder.

**Actual behavior** (per empirical observation, test-app feat-analytics-observability 2026-05-30 09:00Z): security agent returns prose-only output. Inspect dispatches:

```
==security-attempt-7==
  taskStatus: {"analytics-security-review":"failed"}
  securityOutput is null? true
  errors: "P2 CSP: style-src has 'unsafe-inline' without nonces (middleware.ts:6). P2 Privacy: Plausible script.js ignores DNT—no navigator.doNotTrack guard before load (layout.tsx). SENTRY_AUTH_TOKEN clean."

==security-attempt-8== (identical class)
==security-attempt-9== (identical class)
```

All 3 security attempts returned prose-only — no structured `securityOutput`. The orchestrator's bug-007 routing block (feature-graph.ts:1656) requires `result.securityOutput && verdict !== "approved"` — since `securityOutput` is undefined, the condition is FALSE. Routing skipped. Falls through to legacy per-task retry which re-dispatches **security** (not builder) against unchanged code. Three identical dispatches, no builder fixes, retry cap exhausted, feature failed.

## Reproduction Steps

1. Run Mode B on a project with security in agent_sequence (e.g. test-app feat-analytics-observability).
2. Observe security dispatches in `.claude/state/<runId>/dispatches/<feat>/security-attempt-N.json`.
3. If `output.securityOutput` is undefined AND `taskStatus.<task>: failed` AND `errors.<task>` contains prose narrative (rather than structured findings), the agent is bypassing the JSON contract.
4. Observe subsequent dispatches: per-task retry re-dispatches the SAME agent (security) instead of bug-007's routing to the builder.

Synthetic unit-test reproduction (add to feature-graph.test.ts):

```ts
test("bug-010 — security returns prose-only output (no securityOutput) → orchestrator detects + retries security with strict-schema reminder", async () => {
  let securityCalls = 0;
  let lastRetryContext: string | undefined;
  const invokeAgent: InvokeAgentFn = async (args) => {
    if (args.agent === "git-agent") return { taskStatus: {}, errors: {}, gitAgentOutput: ..., costUsd: 0 };
    if (args.agent === "security") {
      securityCalls++;
      lastRetryContext = args.retryContext?.errorMessage;
      if (securityCalls === 1) {
        // First attempt: prose-only
        return {
          taskStatus: { "analytics-security": "failed" },
          errors: { "analytics-security": "P1 CSP missing nonces, P2 Plausible no DNT guard" },
          costUsd: 0.1,
        };
      }
      // bug-010 retry should carry strict-schema HARD CONSTRAINT
      // 2nd attempt complies + returns structured SecurityAgentOutput
      return { taskStatus: { "analytics-security": "completed" }, errors: {}, securityOutput: { verdict: "approved", findings: [], ... }, costUsd: 0.1 };
    }
    ...
  };
  const result = await runFeature(...);
  expect(result.status).toBe("completed");
  expect(securityCalls).toBe(2); // 1 prose-only + 1 with strict-schema retry
  expect(lastRetryContext).toMatch(/SecurityAgentOutput/);
  expect(lastRetryContext).toMatch(/structured JSON/i);
});
```

## Root Cause Analysis

Three layers of root cause:

1. **Agent-side compliance gap**: `.claude/agents/security.md` says "wrap your final outcome JSON in `<<<TASK_OUTCOME>>>` sentinels". It ALSO says "outside the sentinels, write a markdown summary for human reviewers." The agent may prioritize the markdown summary over the JSON when running near token limits OR when interpreting the instruction as suggesting BOTH outputs are equal-priority. Bigger issue: the contract isn't enforced anywhere — the security agent dispatch can return ANYTHING and the orchestrator tolerates it.

2. **Orchestrator-side silent fallback**: `feature-graph.ts:1656` bug-007 routing condition `agentName === "security" && result.securityOutput && verdict !== "approved"`. When `securityOutput` is undefined, this evaluates false WITHOUT logging a warning. Code silently falls through to per-task retry (line 1991+) which dispatches `agentName` (security) hardcoded. Same security-agent-against-same-code loop until retry cap.

3. **Diagnostic surface gap**: there's no orchestrator-side detection of "security agent emitted prose where structured JSON was required". The output-contract violation is invisible from the operator's perspective until manual inspection of the dispatch JSON files.

Same prose-only-consumer-rule drift class as bug-002/003/004/005/006/008. The agent has a structured output contract, but on this dispatch it emitted prose, and the orchestrator silently fell back to a wrong default.

## Fix Approach

Two-part fix:

### Part A — Agent prompt tightening (`.claude/agents/security.md`)

Strengthen the §"Output contract" section + §"Hard rules" to:

1. Lead with "The JSON inside `<<<TASK_OUTCOME>>>` sentinels is your PRIMARY output. The markdown summary outside the sentinels is OPTIONAL secondary context for human reviewers. NEVER emit prose-only without the JSON."
2. Add a new mandatory step in §"Procedure": "Step N+1 (mandatory): before returning, verify you have emitted ALL fields of the `SecurityAgentOutput` schema. If you cannot fill `findings[].retryTarget` because the issue is broadly distributed, pick the most-likely-relevant builder (web-frontend-builder for chrome/asset issues, backend-builder for API/middleware issues)."
3. Move the §"Hard rules" sentinel reminder to be the FIRST rule (not buried at #6).
4. Add an explicit anti-pattern callout: "Anti-pattern: returning the findings as prose in `errors[]`. This silently bypasses bug-007 routing and burns retry budget. The orchestrator now detects + retries with a strict-schema reminder (bug-010), but the agent should comply on first attempt."

### Part B — Orchestrator-side validator + retry-with-reminder (`orchestrator/src/feature-graph.ts`)

Insert a bug-010 detection block in the per-task retry loop (line ~2020, sibling to bug-009):

```ts
// bug-010 (post-Run-3 empirical): when security agent returns taskStatus.failed
// AND securityOutput is undefined, that's an output-contract violation.
// The agent emitted prose instead of structured JSON. bug-007 routing requires
// structured findings[], so falling through to per-task retry would re-dispatch
// security 3× against unchanged code. Detect + retry security ONCE with a
// HARD CONSTRAINT envelope reminding it of the SecurityAgentOutput schema.
if (
  agentName === "security" &&
  !retryResult.securityOutput &&
  retryResult.taskStatus[t.id] !== "completed"
) {
  // Use ONE of the task-retry budget slots for the strict-schema retry.
  // If after that retry securityOutput is still undefined OR verdict !== approved,
  // we fall through to the bug-007 routing (with whatever securityOutput is now)
  // or legacy retry (if still missing).
  const proseErrorMessage = retryResult.errors[t.id] ?? "(no errors field)";
  attempts += 1;
  const strictSchemaResult = await ctx.invokeAgent({
    agent: "security",
    cwd: worktreeCwd,
    featureContext,
    tasks: [t],
    retryContext: {
      taskId: t.id,
      errorMessage:
        `HARD CONSTRAINT — OUTPUT CONTRACT VIOLATION (bug-010)\n` +
        `Your prior attempt emitted prose-only findings in errors[] instead of ` +
        `the structured SecurityAgentOutput JSON contract. The orchestrator ` +
        `cannot route findings[].retryTarget without the JSON; bug-007 routing ` +
        `is silently skipped.\n\nYour prior prose was:\n${proseErrorMessage}\n\n` +
        `You MUST emit a SecurityAgentOutput JSON wrapped in <<<TASK_OUTCOME>>> ` +
        `and <<<END_TASK_OUTCOME>>> sentinels. Each finding must have: id, ` +
        `severity (P0/P1/P2), owaspCategory, cweId, file, line, title, description, ` +
        `suggestedFix, retryTarget (one of: backend-builder | web-frontend-builder ` +
        `| mobile-frontend-builder | tester). overallVerdict must be one of: ` +
        `approved | needs-revision | blocked. See .claude/agents/security.md ` +
        `§"Output contract" for the full schema example.`,
    },
  });
  totalCostUsd += strictSchemaResult.costUsd;
  lastWritingAgent = strictSchemaResult.lastWritingAgent ?? "security";
  // Fold the strict-schema retry's outcome into retryResult so subsequent
  // bug-007 routing (the legacy code below) can route findings[] to builder.
  retryResult.securityOutput = strictSchemaResult.securityOutput;
  retryResult.taskStatus = {
    ...retryResult.taskStatus,
    ...strictSchemaResult.taskStatus,
  };
  retryResult.errors = { ...retryResult.errors, ...strictSchemaResult.errors };
}
```

(Specific insertion point + boundary conditions to be finalized during ship.)

Plus a structured commit-warning log so the operator sees this happen.

### Part C — Tests

Add 1 new test case in feature-graph.test.ts:

1. **"bug-010 — security returns prose-only output → orchestrator retries with strict-schema reminder + then routes per bug-007"**
   - mock: security attempt-1 returns prose-only (no securityOutput); attempt-2 (with bug-010 retry context) returns structured SecurityAgentOutput with findings[].retryTarget=web-frontend-builder; builder fixes; security attempt-3 returns verdict=approved.
   - assert: securityCalls=3, builderCalls=2 (1 initial + 1 via bug-007 routing), retry context on attempt-2 contains "HARD CONSTRAINT" + "SecurityAgentOutput" + "structured JSON".

## Rejected Fixes

1. **Just strengthen the agent prompt (Part A only)** — doesn't catch the case when the agent still ignores the contract due to token-limit pressure or chain-of-thought drift. Defense-in-depth via orchestrator validation is load-bearing.
2. **Treat prose-only as a hard-fail without retry** — too brittle. The agent CAN comply; just needs an explicit reminder. 1 retry budget for the strict-schema reminder is cheap insurance.
3. **Parse the prose `errors[]` heuristically to extract retryTargets** — over-engineered + fragile. The agent has the structured-output capability; just needs to use it.
4. **Lower security retry cap to 1** — same as rejected for bug-007. Hides real issues.

## Validation Criteria

**Empirical reproduction case** — `projects/test-app/.claude/state/15a61239-0758-4fd9-8eca-dfe33f609c52/dispatches/feat-analytics-observability/security-attempt-{7,8,9}.json` — all three have `securityOutput: undefined` + prose `errors[]`.

**Pass conditions** (after Part A + B + C land):

1. New unit test "bug-010 prose-only → strict-schema retry → bug-007 routing fires" passes.
2. Existing 76 feature-graph tests still pass (no regression on bug-007 security routing or bug-009 tester routing).
3. Re-run Mode B on test-app (resumable from same pipelineRunId). feat-analytics-observability re-dispatches security; if security still emits prose, bug-010 retry triggers + agent complies on attempt-2; bug-007 routes findings to builder; builder fixes; security approves.

**Cross-references**:

- `bug-007` — analogous routing fix (handles structured securityOutput correctly)
- `bug-009` — analogous orchestrator-blind-spot detection (per-task retry surface)
- `bug-008` — sibling prose-only-consumer-rule drift class (screens preamble)
- `bug-132` — bug-007 sentinel-and-strict-output requirement that landed for tester (this extends the pattern to security)
- Empirical motivator: test-app Run 3 (2026-05-30 09:00Z) feat-analytics-observability security-attempt-7/8/9
- LESSONS.md candidate: _"When an agent's output contract is silently bypassable (orchestrator tolerates malformed output), the contract isn't enforced — it's aspirational. Every structured-output agent (security, tester, reviewer) needs a mechanical schema-validation gate + 1-retry-with-strict-schema-reminder before falling through to legacy retry. Otherwise the agent learns from token-budget pressure that prose is 'acceptable' and the contract erodes."_

## Attempt Log

<!-- Populated automatically by agents. -->
---

## Completion Record (2026-05-30)

**Outcome: SUCCESS** — bug-010 three-part security output-contract validator shipped + 77/77 feature-graph tests pass.

### Ship summary

**Part A — `.claude/agents/security.md`**:

- §"Output contract" expanded with 2-paragraph emphasis: "structured JSON inside `<<<TASK_OUTCOME>>>` sentinels is your PRIMARY output. Without it, the orchestrator cannot route `findings[].retryTarget` — bug-007 routing is silently skipped and your findings effectively vanish."
- Bug-010 anti-pattern callout: "returning the findings as prose in `errors[]` only"
- §"Hard rules" reordered — sentinel rule promoted from #6 to #1 with expanded language requiring `findings[].retryTarget` population

**Part B — `orchestrator/src/feature-graph.ts`**:

- **Site 1** (first-dispatch surface, line ~1657, BEFORE bug-007 routing): detects `agentName === "security" && !result.securityOutput && some task failed` → dispatches strict-schema retry with HARD CONSTRAINT envelope → folds result into `result` so bug-007 routing acts on now-structured output.
- **Site 2** (in-loop surface, line ~2042, BEFORE bug-009 routing): same condition on `retryResult` → same fix → folds into `retryResult` for downstream bug-007 routing.
- Both sites push `commitWarnings.push("bug-010-detect: ...")` for operator visibility.

**Part C — `orchestrator/tests/feature-graph.test.ts`**:

- 1 new test in `describe("runFeature — bug-010 security prose-only output detection")`:
  - "retries security with strict-schema reminder when first attempt is prose-only, then routes per bug-007"
  - Asserts `securityInvocations=3`, `builderInvocations=2`, retry envelope contains `HARD CONSTRAINT`, `OUTPUT CONTRACT VIOLATION`, `SecurityAgentOutput`, `TASK_OUTCOME`.

### Test verdict

```
cd orchestrator && pnpm vitest run tests/feature-graph.test.ts
Test Files  1 passed (1)
     Tests  77 passed (77)
              — 76 existing tests still pass (no regression on bug-007/009/121, bug-109)
              — 1 new bug-010 test passes
  Duration  2.70s
```

### Empirical re-validation deferred

The in-flight orchestrator process for test-app Run 3 used OLD code (pre-bug-010). The bug-010 fix takes effect on next operator-driven Mode B re-run; feat-analytics-observability would then either:

- complete cleanly (security agent learns from the bug-010 detection retry + agent-prompt tightening); OR
- fail with a STRUCTURED `SecurityAgentOutput` that bug-007 routes correctly to the builder for the CSP nonce / Plausible DNT-guard fixes.

### Lessons

1. **When an agent's output contract is silently bypassable (orchestrator tolerates malformed output), the contract isn't enforced — it's aspirational.** Every structured-output agent (security, tester, reviewer) needs a mechanical schema-validation gate + 1-retry-with-strict-schema-reminder before falling through to legacy retry. Otherwise the agent learns from token-budget pressure that prose is "acceptable" and the contract erodes.
2. **The fix shape REPLICATES across agent classes and dispatch surfaces.** bug-109 (reviewer) → bug-121 (tester first-dispatch) → bug-007 (security routing) → bug-009 (tester in-loop) → bug-010 (security output-contract). Same parse-then-loop algorithm, same HARD CONSTRAINT envelope, same retry-counter semantics. With 5 instances now, the refactor case for a generic `validateAndRouteAgentOutput<T>` helper is very strong; deferred per minimal-diff principle but should be explicit-plan candidate.
3. **Cascade-masking continues across runs.** Run 1 cascade-aborted feat-contact-inquiry hiding bug-007. Run 2 surfaced bug-007 AND hid bug-008/009 (e2e stalls). Run 3 surfaced bug-009 in feat-about AND hid bug-010 in feat-analytics-observability. Pattern: each fix unblocks the next layer.

### Cross-references

- Empirical motivator: test-app Run 3 (2026-05-30 09:00Z) feat-analytics-observability security-attempt-7/8/9
- Parent class: bug-002 → bug-008 (prose-only-consumer-rule drift)
- Template fix shapes: bug-007 (security routing), bug-009 (tester in-loop routing), bug-109 (reviewer)
- feature_list: phase2-step-026
- phase-plan: §F Row 044
- LESSONS.md candidate: see lessons §1 above

### Commits

- This commit bundles:
  - `.claude/agents/security.md` (§Output contract + §Hard rules)
  - `orchestrator/src/feature-graph.ts` (Sites 1 + 2 bug-010 detection)
  - `orchestrator/tests/feature-graph.test.ts` (1 routing test)
  - `phase-plan.md` §F Row 044
  - `feature_list.json` phase2-step-026 row
  - `evidence/phase2-step-026-result.txt`
  - `plans/archive/bug-010-security-agent-prose-only-output.md` (this archive)

Closed by Phase 2 build operator (David Morgan / Claude opus-4-7) 2026-05-30.
