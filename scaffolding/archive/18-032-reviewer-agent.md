---
task-id: "032"
title: "Reviewer Agent — refactor-004/feat-002/feat-004 aligned"
status: pending
priority: P2
tier: 8 — Quality & Ship
depends-on: ["028", "029", "030", "031"]
estimated-scope: medium
---

# 032: Reviewer Agent — post-feat-004 hybrid-TDD alignment

## Position in pipeline (refactor-004 Mode B)

Reviewer runs INSIDE a feature worktree per `feature.agent_sequence[]`, AFTER tester completes. Last agent in the typical chain (`backend-builder → web-frontend-builder → mobile-frontend-builder → tester → reviewer`). CWD = `.claude/worktrees/{feature.worktree}/`. On approval, orchestrator fires `git-agent close-feature` which merges the feature branch to main. On revision request, orchestrator routes to the named builder per `ReviewerOutput.retryTargets[]`.

Reviewer is **invoked ONLY when tester signals `policyCheck: "pass"` or `"fail"`** — never on `policyCheck: "blocked"` (those are genuine product bugs routed back to the builder before reviewer runs). Reviewer assumes: builder happy-path tests pass + tester edge-case/integration/E2E tests run + coverage measurable.

## Builder/tester handoff awareness (feat-004 hybrid-TDD)

Reviewer is NOT a re-tester. Tester already:

- Ran full suite + parsed coverage to `coverageTotal` (must be ≥80 for tester to emit `policyCheck: "pass"`)
- Added edge-case + integration + (optional) E2E tests
- Flagged genuine product bugs back via `genuineProductBugs[]` — orchestrator has already routed those before reviewer runs

Reviewer's job is **quality dimensions the test suite can't detect**: architecture drift, security patterns, compliance, maintainability signals, a11y, performance signals, brief-delivery cross-reference. Rewriting tests or re-running coverage is out of scope.

Reviewer reads builder's + tester's committed work via `git log --oneline` in the worktree + `.feature-context.json.agent_history[]` (to see what each agent shipped) and scopes its review to the diff introduced by this feature's branch against main.

## Stack dispatch (feat-002)

For each tier present in `architecture.yaml.tooling.stack.*`, reviewer loads the matching stack skill's §Review block (or §Gotchas — stack skills document stack-specific anti-patterns the reviewer flags). **Filter-then-load per feat-009 lesson**: only load stack skills for tiers with reviewable code in scope, where a tier is in scope when (a) `tooling.stack.{tier}_framework` is non-null AND (b) feature.skip[] does not exclude the tier AND (c) ≥1 file committed under that tier's app directory in this feature's branch.

A feat-009 observation also applies: **the quality of reviewer output is proportional to the quality of the stack skill's §Review / §Gotchas content**. Stack skills missing §Review → reviewer falls back to the generic playbook (`docs/reviewer-playbook.md`) and flags `stack-review-block-missing` as a known-gap in the `warnings[]` output.

## What This Task Produces (implemented by feat-010)

1. Agent definition at `.claude/agents/reviewer.md`
2. Skill at `.claude/skills/reviewer/SKILL.md`
3. `ReviewerOutput` Zod schema at `packages/orchestrator-contracts/src/reviewer.ts`
4. Tests for the contract at `packages/orchestrator-contracts/tests/reviewer.test.ts`

## Scope

### Agent Definition (stack-agnostic)

```yaml
---
name: reviewer
description: Architecture + security + compliance + maintainability + a11y + performance + brief-delivery review per docs/reviewer-playbook.md's 7 dimensions. Runs inside feature worktree after tester; consumes builder + tester handoff; approves/needs-revision/blocks via ReviewerOutput.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
permissionMode: acceptEdits
maxTurns: 30
effort: high
---
```

System-prompt themes (full content authored in feat-010):

- **Read-first**. Review is primarily a READ operation. You do NOT rewrite tests, you do NOT refactor code, you do NOT fix bugs yourself. You REPORT per `docs/reviewer-playbook.md`. The only exception: documentation clarifications within your own review output (e.g., adding JSDoc comments that the maintainability dimension flagged as missing) — but flag even these as needs-revision so the builder confirms.
- **Playbook-bound**. `docs/reviewer-playbook.md` is your operational reference. Every flagged issue cites the playbook dimension + concrete criterion. "Looks off" is not a finding; "security/rate-limiting: password-reset endpoint has no rate limiter (playbook §2.5)" IS a finding.
- **Retry routing is load-bearing**. Every `needs-revision` issue MUST name the agent who should revise (`retryTargets[]`). Orchestrator routes per refactor-004 per-task retry ladder (max 3). Routing precision = retry efficiency.
- **Stack-aware**. Load stack skills per step §Stack dispatch above; let their §Review / §Gotchas blocks add stack-specific checks on top of the generic playbook.

### /reviewer Skill — stack-agnostic dispatcher

Steps (authored in feat-010):

1. **Argument gate**: require `--feature-id=<feat-...>`; reject missing. Optional `--skip-perf` (perf checks need a dev server; default on; off for backend-only features or scratch-repo smoke tests).
2. **Load context**:
   - `{projectRoot}/.claude/architecture.yaml` — stack + integrations + compliance fields
   - `{projectRoot}/docs/tasks.yaml` — filter features[] to the one matching `--feature-id`
   - `{projectRoot}/brief.md` §11 (catalogue) + §14 (compliance) — for brief-delivery + compliance dimensions
   - `{projectRoot}/docs/reviewer-playbook.md` — the 7-dimension operational reference
   - Per-tier stack skill §Review / §Gotchas blocks (filter-then-load per §Stack dispatch)
   - Tester's `TesterOutput` (from this feature's prior agent run — available via `.feature-context.json.agent_history[]` or orchestrator-passed-through)
3. **Confirm worktree CWD** (same pattern as builders + tester): read + validate `.feature-context.json`; confirm `feature_id` matches; confirm tester's `agent_history` entry exists with `outcome: "success"` + `policyCheck !== "blocked"`.
4. **Scope the diff**: `git log --oneline main..HEAD` inside the worktree. Reviewer scopes checks to files touched by THIS feature's branch, not the whole repo.
5. **Walk the 7 dimensions** per `docs/reviewer-playbook.md`. For each:
   - Run the tool invocation(s) the playbook names
   - Compare output against the playbook's pass threshold
   - On fail: append to `issuesFound[]` with exact dimension + criterion reference + file:line + retry target
   - On unavailable tooling (e.g., no Lighthouse, no axe-core): skip with warning, not fail (known-gap deferrals point at post-mvp-scaffolding/)
6. **Compose overall verdict**:
   - `approved` if zero fails OR only P3 warnings
   - `needs-revision` if ≥1 dimension failed with a clear retry target (actionable by a builder within 3 attempts)
   - `blocked` if spec contradiction (e.g., brief says "GDPR" but architecture.yaml says `compliance.gdpr: false` — needs human)
7. **Append to `.feature-context.json.agent_history[]`**: one entry per invocation. Set `last_writing_agent: "reviewer"` ONLY if reviewer committed something (rare); normally the tester remains `last_writing_agent`.
8. **Return `ReviewerOutput` JSON** per `@repo/orchestrator-contracts`.

### ReviewerOutput contract skeleton (to be Zod-authored in feat-010 Phase 1)

```typescript
type ReviewDimension =
  | "architecture"
  | "security"
  | "compliance"
  | "maintainability"
  | "a11y"
  | "performance"
  | "brief-delivery";

type DimensionResult =
  | { status: "pass" }
  | { status: "fail"; issues: ReviewIssue[] }
  | { status: "skipped"; reason: string }; // e.g. no Lighthouse in scratch

type ReviewIssue = {
  dimension: ReviewDimension;
  playbookSection: string; // "§2.5 rate-limiting"
  severity: "error" | "warning";
  filePath: string;
  line?: number;
  message: string;
  retryTarget: {
    agent:
      | "backend-builder"
      | "web-frontend-builder"
      | "mobile-frontend-builder"
      | "architect"
      | "pm";
    taskIds: string[];
  };
};

type ReviewerOutput = {
  success: boolean; // true when overallVerdict === "approved"
  featureId: string; // /^feat-[a-z][a-z0-9-]{1,48}$/
  dimensions: Record<ReviewDimension, DimensionResult>;
  overallVerdict: "approved" | "needs-revision" | "blocked";
  issuesFound: ReviewIssue[];
  retryTargets: {
    // aggregated per agent across issuesFound
    agent: string;
    taskIds: string[];
  }[];
  toolsUsed: string[]; // record of what commands ran (grep + typecheck + lint + knip + ...)
  headSha: string | null;
  warnings: string[];
};
```

The Zod schema authored in feat-010 Phase 1 binds this shape; orchestrator validates on reviewer return before routing retries or advancing to git-agent close-feature.

### Retry routing

On `overallVerdict: "needs-revision"`, orchestrator reads `retryTargets[]` and re-invokes the named agent(s) with `retryContext` pointing at the specific issues they own. Per refactor-004: max 3 retries per task. On exhaust OR `overallVerdict: "blocked"`, orchestrator halts the feature at `status: failed` in tasks.yaml + surfaces to human.

Common routing patterns:

- Security/rate-limiting failure in backend code → `backend-builder` with the failing endpoint's task ID
- A11y failure on a screen → `web-frontend-builder` or `mobile-frontend-builder` per surface
- Architecture drift (wrong vendor wired, or missing integration_ref) → `backend-builder` OR `architect` (if architecture.yaml itself is inconsistent — rare, usually a spec change)
- Brief-delivery gap (feature summary doesn't match committed code) → `backend-builder` / `frontend-builder` (implementation diverged) OR `pm` (tasks.yaml features[] grouped wrongly)

### Hard rules

- Never rewrite tests — tester's scope (feat-004 role split)
- Never refactor committed code — builder's scope + retry ladder
- Never bypass the playbook's concrete criteria — "looks off" is not a finding
- Never omit retry targets on `needs-revision` issues — orchestrator can't route without them
- Never read/write `.env` (no sanctioned exception — backend-builder's alone)
- Never touch worktree lifecycle — git-agent's job

## Acceptance Criteria (for feat-010)

- [ ] `.claude/agents/reviewer.md` exists; stack-agnostic body (no framework hardcodes)
- [ ] `.claude/skills/reviewer/SKILL.md` exists; 8-step dispatcher pattern matching feat-008/009
- [ ] `packages/orchestrator-contracts/src/reviewer.ts` exports `ReviewerOutput` Zod schema
- [ ] Reviewer loads per-tier stack skill §Review / §Gotchas (filter-then-load per feat-009 lesson)
- [ ] Reviewer scopes checks to THIS feature's branch diff (`git log --oneline main..HEAD`), not whole-repo
- [ ] Every flagged issue cites the playbook section + dimension
- [ ] Every `needs-revision` issue names a retry target (agent + taskIds)
- [ ] Return JSON validates against `ReviewerOutput` Zod
- [ ] Smoke test against the feat-008/009 scratch repo's merged builder + tester output — reviewer walks the 7 dimensions, flags zero security/compliance issues on the builder-generated Prisma schema (clean starter code), emits `approved` overallVerdict

## Downstream Implications

- **git-agent close-feature** fires after reviewer approves. If reviewer blocks, close-feature doesn't run.
- **Task 036 gate 6** (PR review before merge) is the NEXT gate after reviewer approval: orchestrator creates a PR via git-agent, file-watches `docs/gate-6-approved.txt`, merges only on human approval. Reviewer's approval is a precondition but not the final human say-so.
- **Reviewer-playbook.md is the stable contract**. Stack skills evolving their §Review blocks is additive. Playbook dimension changes go through refactor-NNN plans.

## Human Verification

1. Does the reviewer walk all 7 dimensions per the playbook on a real feature?
2. Does every `needs-revision` issue carry a retry target that the orchestrator can route?
3. Does reviewer correctly skip dimensions when tooling is unavailable (e.g., no Lighthouse → skip perf dimension with warning)?
4. Does reviewer NOT rewrite tests or fix code (staying in read-report mode)?
5. For a feature where tester's `policyCheck: "fail"` was resolved pre-reviewer (via builder retry), does reviewer see the fresh tester entry in agent_history?
