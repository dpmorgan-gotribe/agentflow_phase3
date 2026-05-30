---
id: bug-007-security-retry-targets-ignored
type: bug
status: draft
author-agent: Claude (Phase 2 Mode B post-run analysis)
created: 2026-05-30
updated: 2026-05-30
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

| Dispatch | Outcome | Cost |
|---|---|---|
| `web-frontend-builder-attempt-1` | (inferred completed; not captured) | — |
| `security-attempt-1` | error_stall_timeout (15-min cap) | (low) |
| `security-attempt-2` | Found P1 + P2 issues; `retryTargets: [web-frontend-builder]` | (low) |
| `security-attempt-3` | Same P1 + P2 issues still present; flagged UNRESOLVED | $0.39 |

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
retryTargets: z.array(AgentSequenceMember).default([])
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
