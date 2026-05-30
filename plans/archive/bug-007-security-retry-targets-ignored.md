---
id: bug-007-security-retry-targets-ignored
type: bug
status: archived
outcome: success
author-agent: Claude (Phase 2 Mode B post-run analysis)
created: 2026-05-30
updated: 2026-05-30
closed-at: 2026-05-30
parent-plan: null
supersedes: null
superseded-by: null
branch: fix/security-retry-targets-routing
affected-files:
  - orchestrator/src/feature-graph.ts
  - orchestrator/src/invoke-agent.ts
  - .claude/agents/security.md
  - packages/orchestrator-contracts/src/security.ts
feature-area: mode-b-build-orchestration
priority: P0
attempt-count: 0
max-attempts: 5
error-message: "Security agent on feat-contact-inquiry returns findings with retryTargets: [web-frontend-builder] for P1 IP-spoofing + P2 CSP form-action; orchestrator re-dispatches security 3x instead of routing to builder. Builder never sees the security findings + never gets a chance to fix."
reproduction-steps: "Run Mode B against any project with security in agent_sequence where security finds P1 issues + emits retryTargets[builder]. Observe orchestrator re-dispatches security N times instead of routing back to builder."
stack-trace: null
---

# bug-007-security-retry-targets-ignored: Security agent's retryTargets[builder] are not routed to builder — orchestrator just re-dispatches security in a loop

## Bug Description

The reviewer agent's `retryTargets[]` field is documented in row-009 to route the retry to the named agent (e.g. `[web-frontend-builder]` re-dispatches the builder with the reviewer's findings as `retryContext.errorMessage`). The security agent's findings should follow the same routing contract — when security flags `retryTargets: [web-frontend-builder]`, the orchestrator should re-dispatch the builder.

Empirical observation (2026-05-30 live Mode B run on test-app, pipelineRunId `15a61239-0758-4fd9-8eca-dfe33f609c52`):

`feat-contact-inquiry` agent_sequence: `[web-frontend-builder, security, tester, reviewer]`

Dispatch sequence (per `.claude/state/<runId>/dispatches/feat-contact-inquiry/`):

| Dispatch                         | Outcome                                                      | Cost  |
| -------------------------------- | ------------------------------------------------------------ | ----- |
| `web-frontend-builder-attempt-1` | (inferred completed; not captured)                           | —     |
| `security-attempt-1`             | error_stall_timeout (15-min cap)                             | (low) |
| `security-attempt-2`             | Found P1 + P2 issues; `retryTargets: [web-frontend-builder]` | (low) |
| `security-attempt-3`             | Same P1 + P2 issues still present; flagged UNRESOLVED        | $0.39 |

Between `security-attempt-2` and `security-attempt-3`, **no builder dispatch fired**. The orchestrator just re-dispatched the security agent with the prior findings as retry context — security ran AGAIN, found the same issues still unresolved (which is correct — the builder was never asked to fix them).

The orchestrator's retry routing for security's `retryTargets[]` is broken. Security cannot fix code; only the builder can. Looping security against the same un-modified code emits identical findings ad infinitum.

## Why this hides

The bug surfaces only when:

1. Feature's `agent_sequence` contains `security` (not all features have security; PM emits it only for security-sensitive surfaces — typically inquiry forms, auth flows, payment flows)
2. Security finds an issue with `retryTargets: [<builder>]`
3. The builder code requires modification to fix

For `feat-contact-inquiry` on test-app, all three conditions hit. In the prior failed Mode B run (Run 1), feat-contact-inquiry was in the `aborted[]` set (transitive consequence of feat-design-system's parallel-conflict failure per bug-006), so security never dispatched — the bug stayed hidden.

After bug-006 unblocked the dispatch path, Run 2 surfaced this bug as the next failure layer.

## Root cause analysis

The reviewer agent's output schema (`ReviewerOutput.retryTargets[]`) is wired in `orchestrator/src/feature-graph.ts:2435` and the orchestrator routes retries to the named agents per its handling logic.

The security agent's analog is presumed to follow the same shape but **may not be wired into the routing logic**. Two hypotheses for the root cause:

1. **Security agent's output is not unpacked as a `SecurityOutput` with structured `retryTargets[]`** — its output is treated as opaque task-outcome JSON. The `retryTargets` field, if present in the agent's text output, is not parsed by the orchestrator. The orchestrator's only retry trigger for security failures is the `errorMessage` field, which routes to... itself (security re-dispatch).

2. **Security agent's output schema IS structured but the routing dispatch table doesn't include security as a valid retry-source** — the orchestrator's `routeRetryToAgent()` (or equivalent) treats security findings as "task failures" that re-dispatch the same agent, rather than as "external retry-target requests" that route to a different agent.

Both root-cause hypotheses produce the same observable symptom (security re-dispatched). Investigation should walk `orchestrator/src/feature-graph.ts` post-security branch to confirm which is the actual hole.

## Fix Approach

Two-part fix:

### Part A — Schema: declare `SecurityOutput.retryTargets[]` as a structured field

In `packages/orchestrator-contracts/src/security.ts` (or wherever the security output schema lives), add:

```ts
retryTargets: z.array(AgentSequenceMember).default([]);
```

Same shape as `ReviewerOutput.retryTargets[]`. Update `.claude/agents/security.md` to instruct the agent to emit this structured field (most security agents already emit it in the error message as prose; structured field makes parsing unambiguous).

### Part B — Orchestrator routes security's retryTargets to the named agents

In `orchestrator/src/feature-graph.ts`, after a security dispatch returns with findings + `retryTargets[]`:

1. Parse `SecurityOutput.retryTargets[]`
2. For each target agent: re-dispatch that agent with security's findings as `retryContext.errorMessage`
3. The dispatched agent's retry counter increments per existing `retry-counters.ts` semantics
4. After the target agent finishes, security re-dispatches automatically (the agent_sequence loop continues; security fires next per row-007 conditional dispatch on agent_sequence)

This mirrors the existing reviewer routing logic — same code path, just extended to security.

### Part C — Test

Add `orchestrator/tests/feature-graph-security-routing.test.ts` covering:

- Security returns `retryTargets: [web-frontend-builder]` + findings
- Orchestrator dispatches web-frontend-builder with findings as `retryContext`
- After builder completes, security re-fires (and ideally finds the issue resolved)
- Max-3 retry cap applies per task per `retry-counters.ts`

## Empirical observation — current Mode B run impact

feat-contact-inquiry on the in-flight Mode B run is on track to hit emergency-abort soon (security has flagged P1 unresolved 3 times). When the abort fires, feat-deployment (which depends_on feat-analytics-observability, which in turn depends_on feat-design-system → all completed) may still dispatch — but feat-deployment's CSP headers task could ALSO hit similar security findings + similar routing failure.

Operator-side workaround until bug-007 ships: after Mode B completes, manually fix `apps/web/app/api/inquiry/route.ts` to:

1. Validate `x-forwarded-for` against trusted-proxy IPs (or use `x-real-ip` from Vercel's deployment)
2. Add CSP `form-action 'self'` header via `apps/web/middleware.ts` OR `next.config.ts` `headers()`

Same patches required for feat-analytics-observability's csp-headers task (likely subject to the same routing miss when that feature's security-review fires).

## Rejected Fixes

- **Fix X — Lower security retry cap to 1 so it doesn't loop** — Rejected: silences the symptom without fixing the routing. Security cap = 1 means a single retry, but the security agent still doesn't know if the builder fixed the issue. The semantic broken-ness remains.

- **Fix Y — Mark security findings as `genuine product bugs` so bug-121 routing fires** — Rejected: bug-121 is for tester's `genuineProductBugs[]` array, not security's `retryTargets[]`. Different agent + different field. Plumbing security findings through bug-121 would conflate the two failure-class routes.

- **Fix Z — Drop security from default agent_sequence for inquiry-form-class features** — Rejected: security IS appropriate for those features (the brief's §13 and architecture.yaml flagged them). The fix is the routing bug, not the dispatch policy.

## Validation Criteria

**Empirical reproduction case** — re-fire Mode B on `projects/test-app` after Part A + B + C land. feat-contact-inquiry's security dispatch + builder routing should fire correctly: security finds issue → builder dispatched → builder fixes route.ts + middleware.ts → security re-fires → finds resolved → tester → reviewer → close-feature merge.

**Pass conditions:**

1. New unit test `feature-graph-security-routing.test.ts` exits 0 with 3+ test cases
2. Mode B re-run on test-app produces ≤2 security attempts per feature (1 first-fire + 1 verify-after-builder-fix); no 3-attempt-exhaust → emergency-abort cycle
3. Security agent's output JSON has structured `retryTargets[]` field per the schema extension
4. Reviewer's existing retry routing unchanged (no regression)

**Cross-references:**

- bug-006 (PM affects_files overlap audit) — sibling Mode B failure-mode finding from the same 2026-05-30 run
- row-009 (reviewer dispatch) — the existing retry routing this bug extends to security
- feat-024 stall watchdog — surfaced security-attempt-1's 15-min stall
- LESSONS.md candidate entry on close: _"The retry-target routing for reviewer + tester (bug-121) is fully wired but security's analog was overlooked — same retryTargets[] shape needs the same plumbing. Any new agent type that emits retry-routing requests must be explicitly threaded through feature-graph's routing dispatch table; the default fallback is re-dispatch-self which is silently wrong."_

## Attempt Log

<!-- Populated automatically by agents. -->
---

## Completion Record (2026-05-30)

**Outcome: SUCCESS** — bug-007 security retryTarget routing shipped + 74/74 feature-graph tests pass.

### Ship summary

Three-part fix mirrors bug-109's reviewer-driven routing pattern.

**Part A — packages/orchestrator-contracts/src/security.ts**: No schema change needed. `SecurityAgentOutput.findings[].retryTarget` already exists as `SecurityRetryAgent` enum (backend-builder | web-frontend-builder | mobile-frontend-builder | tester). Schema was correct; only orchestrator routing was missing.

**Part B — orchestrator/src/invoke-agent.ts**:

- Added `SecurityAgentOutput as SecurityAgentOutputType` to type import alongside ReviewerOutputType
- Added `SecurityAgentOutput as SecurityAgentOutputSchema` to value import
- Added `securityOutput?: SecurityAgentOutputType` to InvokeAgentResult output type
- Added parse block (~line 2118): when agent === "security", run `SecurityAgentOutputSchema.safeParse(extracted.parsed)` + capture into `securityOutput` for feature-graph to consume
- Added to captureReturn shape: `...(securityOutput !== undefined ? { securityOutput } : {})`

**Part C — orchestrator/src/feature-graph.ts**:

- Added SecurityAgentOutputType import
- Added `securityOutput?: SecurityAgentOutputType` to InvokeAgentResult interface with JSDoc explaining bug-007 routing semantics (mirrors bug-109 reviewerOutput JSDoc)
- Added ~200 LOC security-driven routing block (~lines 1631-1830) AFTER reviewer routing and BEFORE bug-121 tester routing. Algorithm:
  1. On `agentName === "security" && result.securityOutput && verdict !== "approved"`:
     - "blocked" → fail feature with `security-blocked: ${severity} ${owaspCategory}: ${title}` abort reason
     - "needs-revision" → routing loop bounded by TASK_RETRY_CAP:
       a. Group findings[] by retryTarget agent into Map<AgentSequenceMember, string[]>
       b. For each named agent, dispatch with HARD CONSTRAINT bug-007 envelope inlining findings (severity + owaspCategory + cweId + file + line + title + description + suggestedFix)
       c. Commit retry-target's work via commitChanges so security re-run sees fresh code
       d. Re-dispatch security to re-validate
       e. "approved" → break + continue agent_sequence; "blocked" → fail; else loop
  2. On retry-cap exhaustion → `security-cap-exhausted (bug-007): ${detail}` abort reason

**Part D — orchestrator/tests/feature-graph.test.ts**: 3 routing tests appended in new `describe("runFeature — security-driven retry routing (bug-007)")` block:

1. **"routes needs-revision verdict to named builder + re-runs security until approved"** — verifies builder gets HARD CONSTRAINT retry envelope with `x-forwarded-for` finding content; builder dispatched=2, security dispatched=2.
2. **"fails feature on blocked verdict without re-dispatching builder"** — P0 hardcoded-secret case; builder dispatched=1 only; `result.status === "failed"`, `result.abortReason matches /security-blocked/`.
3. **"aggregates findings by retryTarget agent"** — 2 P1 findings both targeting web-frontend-builder → single dispatch carrying both findings in one retry envelope; builder=2, security=2.

### Test verdict

```
pnpm vitest run orchestrator/tests/feature-graph.test.ts
Test Files  1 passed (1)
     Tests  74 passed (74)
              — 71 existing tests still pass (no regression to bug-109 reviewer or bug-121 tester routing)
              — 3 new bug-007 security-routing tests pass
  Duration  4.67s
```

### Empirical motivator + observation

- **Motivator**: 2026-05-30 live Mode B run on projects/test-app (resumed after bug-006 fix unblocked the cascade). feat-contact-inquiry security agent correctly flagged P1 (x-forwarded-for trusted without proxy validation, route.ts:48) + P2 (no CSP form-action). Orchestrator re-dispatched SECURITY 3 times instead of routing to web-frontend-builder per findings[].retryTarget. Security can't fix code; builder never saw the findings + never got a chance to fix.
- **Why this hid**: In Run 1, feat-contact-inquiry was in aborted[] (transitive consequence of bug-006). Security never dispatched in Run 1. After bug-006 unblocked the cascade, Run 2 surfaced bug-007 as the next failure layer.
- **Mode B failure-handling worked correctly through the failure**: conflict-handoff fired, last-writing-agent retry cap exhausted (max-3), emergency-abort fired cleanly, partial-failure-policy continued the graph + computed blast-radius (per feat-081 / row 022), exit 0 (clean shutdown despite failure).
- **Empirical re-validation**: deferred to next operator-driven Mode B re-run. The in-flight orchestrator process at the time of fix-land was using OLD code (orchestrator process boot loaded the old feature-graph.ts); next `/start-build test-app` will exercise the new routing on feat-contact-inquiry.

### Operator workaround (during the live run)

While the orchestrator process was still running with OLD code, the operator manually fixed apps/web/app/api/inquiry/route.ts (validate x-forwarded-for against trusted-proxy IPs) + added CSP form-action via apps/web/middleware.ts. These manual fixes resolve test-app's specific case but the orchestrator-side routing fix is what generalizes to future Mode B runs.

### Lessons

1. **Retry-target routing is a per-agent contract that must be EXPLICITLY threaded through feature-graph's routing dispatch table.** The default fallback (re-dispatch self on per-task retry) is silently wrong + only surfaces when a project's Mode B dispatch actually reaches the missed-routing agent class. Adding a new agent that emits retry-routing requests (security findings, reviewer dimensions, tester genuineProductBugs) requires:
   - schema field on the agent's output contract
   - parse block in invoke-agent.ts
   - routing block in feature-graph.ts (mirror the closest analog — bug-109 for verdict-based routing; bug-121 for found-product-bugs routing)
   - 3 unit tests minimum (happy path + blocked + multi-finding aggregation)
2. **The retry-target routing fix shape REPLICATES across agent classes.** bug-109 fix shape (reviewer routing) → bug-121 fix shape (tester routing) → bug-007 fix shape (security routing). Same parse-then-loop algorithm, same HARD CONSTRAINT envelope, same retry-counter semantics. This suggests a future opportunity to factor the routing block into a generic `routeFindingsToAgent` helper rather than 3 nearly-identical 200-LOC blocks; deferred until a 4th agent class needs the same treatment.
3. **Cascade-masking hides routing bugs.** bug-007 was undiscoverable while bug-006 cascade-aborted feat-contact-inquiry. Same lesson as bug-006's lesson 3 — Mode B runs that hit emergency-abort early should be re-run after the upstream fix to discover the next failure layer.
4. **The security agent's empirical findings on the test-app run were ACTUAL P1 bugs**, not noise. The fix doesn't just route security findings correctly; it confirms the security agent itself is producing valid actionable findings. Operator should not lower security retry cap to 1 (an earlier rejected alternative) — that would silence symptom while hiding actual security bugs.

### Cross-references

- Empirical motivator: test-app Mode B Run 2 (2026-05-30) — feat-contact-inquiry security loop
- Sibling bug (parent in same Mode B run): bug-006 (PM affects_files overlap audit)
- Template fix shape: bug-109 (reviewer-driven retry routing)
- Adjacent routing fix: bug-121 (tester genuineProductBugs routing — preserved without regression in this commit)
- feature_list: phase2-step-023 (parent row)
- phase-plan: §F Row 041
- ADR: none (mechanical orchestrator fix; no architectural decision)
- LESSONS.md candidate entry: "Retry-target routing is per-agent contract — schema + parse + route + 3-test minimum"

### Commits

- This commit bundles:
  - orchestrator/src/invoke-agent.ts (security parse block)
  - orchestrator/src/feature-graph.ts (security routing block + InvokeAgentResult.securityOutput)
  - orchestrator/tests/feature-graph.test.ts (3 routing tests)
  - phase-plan.md §F Row 041 (this fix)
  - feature_list.json (phase2-step-023 row)
  - plans/archive/bug-006-pm-affects-files-overlap-miss.md (sibling archive)
  - plans/archive/bug-007-security-retry-targets-ignored.md (this archive)

Closed by Phase 2 build operator (David Morgan / Claude opus-4-7) 2026-05-30.
