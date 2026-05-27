---
task-id: "021"
title: "Project Manager Agent + tasks.yaml (refactor-003 dual-mode)"
status: pending
priority: P2
tier: 6.5 — Post-Design Planning
depends-on: ["019", "020"]
estimated-scope: small
---

# 021: Project Manager Agent + tasks.yaml

## Position in pipeline (refactor-003)

PM runs **AFTER** `/architect` (not after `/analyze` as in the pre-refactor order). This lets tasks.yaml reference concrete vendor decisions from `architecture.yaml` (e.g., "wire Resend transactional-email templates to member-approval flow") rather than abstract placeholders.

PM is **dual-mode** in refactor-003:

- **`--mode=tasks`** (main pipeline run, post-architect): reads `architecture.yaml` + `requirements.md` + brief §12 / §19, produces `docs/tasks.yaml` — the full project task graph.
- **`--mode=kit-change-request`** (on-demand detour during design): reads a `docs/screens/kit-change-requests/{screen-id}.md` file + current `packages/ui-kit/package.json`, produces `plans/active/kit-change-request-{id}.md` mini-plan. Does NOT require `architecture.yaml` to exist — crucially important since design-phase detours fire BEFORE the main architect stage.

Same agent definition; two invocation surfaces. Orchestrator (task 035) owns when each mode runs.

## What This Task Produces

1. Agent definition at `.claude/agents/project-manager.md`
2. Tasks.yaml template at `docs/tasks.yaml.template`
3. Kit-change-request mini-plan template at `plans/templates/kit-change-request-plan.md`

## Scope

### Agent Definition

Decomposes requirements + architecture into a task graph (main mode) OR authors a single-purpose kit-bump mini-plan (detour mode).

```yaml
---
name: project-manager
description: Dual-mode agent. Main: decompose requirements + architecture into tasks.yaml. Detour: author kit-change-request mini-plans during design.
tools: Read, Write, Bash, Grep, Glob
model: inherit
maxTurns: 30
effort: high
---
```

### tasks.yaml Template (--mode=tasks) — **v2 per refactor-004**

Refactor-004 upgrades `tasks.yaml` from a flat `tasks:` array to a two-level `features[]` → `tasks[]` hierarchy. The orchestrator's feature-graph phase binds to this shape; every feature owns a worktree + branch + `agent_sequence[]` and the orchestrator runs agents in declared order inside each feature's worktree.

**Schema source of truth:** `schemas/tasks.schema.json` + `schemas/feature.schema.json` (project copies distributed by `/new-project`; factory copies at `schemas/` root). Zod mirrors live in `@repo/orchestrator-contracts` as `TasksV2Schema` + `FeatureSchema` + `TaskSchema` (task 034b).

Expected structure:

```yaml
version: "2.0"
generated_at: "2026-04-22T00:00:00Z"
project_name: mindapp-v2
architecture_ref: .claude/architecture.yaml
ui_kit_version: 0.1.0-tokens-only

features:
  - id: feat-password-reset
    worktree: feat-password-reset
    branch: feat/password-reset
    priority: P1
    depends_on: []
    skip: [] # [mobile] | [web] | [backend] if not applicable
    agent_sequence:
      - backend-builder
      - web-frontend-builder
      - tester
      - reviewer
    summary: "Email-based password reset with magic-link verification."
    brief_reference: "brief.md §12 auth + docs/analysis/webapp/flows.md#flow-4"
    tasks:
      - id: api-password-reset-endpoint
        agent: backend-builder
        depends_on: []
        skills: [nodemailer, bcrypt]
        priority: P1
        integration_ref: architecture.yaml#apps.api.integrations.transactional-email
        status: pending
      - id: web-password-reset-form
        agent: web-frontend-builder
        depends_on: [api-password-reset-endpoint]
        skills: [react-hook-form]
        estimated_screens: 2
        status: pending
      - id: test-password-reset
        agent: tester
        depends_on: [web-password-reset-form]
        priority: P1
        status: pending

  - id: feat-stripe-checkout
    worktree: feat-stripe-checkout
    branch: feat/stripe-checkout
    priority: P0
    depends_on: [feat-password-reset]
    skip: [mobile]
    agent_sequence:
      - backend-builder
      - web-frontend-builder
      - tester
    tasks:
      - id: backend-stripe-checkout
        agent: backend-builder
        skills: [stripe-connect]
        integration_ref: architecture.yaml#apps.api.integrations.payments
        status: pending
      - id: web-stripe-checkout-form
        agent: web-frontend-builder
        depends_on: [backend-stripe-checkout]
        estimated_screens: 3
        status: pending

summary_counts:
  total_features: 2
  total_tasks: 5
  by_agent:
    backend-builder: 2
    web-frontend-builder: 2
    tester: 1
  by_priority:
    P0: 2
    P1: 3
    P2: 0
    P3: 0

warnings: []
```

#### v2 field reference

**Top-level:**

- `version: "2.0"` — required. Orchestrator rejects anything else with a migration-guidance error (not a retry-able validation failure).
- `features[]` — ordered list; orchestrator runs them concurrently up to `maxConcurrentFeatures` respecting `feature.depends_on`.
- `summary_counts` / `warnings` — advisory; the orchestrator re-computes counts and warns on disagreement but doesn't abort.

**Per feature:**

- `id` — `feat-{slug}` kebab-case. Stable across tasks.yaml regenerations.
- `worktree` — directory name under `.claude/worktrees/{worktree}/`; matches `id` by convention.
- `branch` — `feat/{slug}` git branch. git-agent forks from `main` at `checkout-feature` time.
- `priority` — P0 / P1 / P2 / P3.
- `depends_on[]` — feature IDs that must complete before this feature's worktree opens. Governs inter-feature parallelism.
- `skip[]` — surfaces this feature does NOT touch. If `skip: [mobile]`, mobile-frontend-builder is skipped even if listed in `agent_sequence`.
- `agent_sequence[]` — ordered agent IDs. Orchestrator invokes each in order, passing only the tasks[] entries whose `agent` field matches the current step. Never includes `git-agent` — worktree lifecycle is orchestrator-owned.
- `tasks[]` — concrete work; each task's `agent` field MUST appear in `agent_sequence`.
- `summary` / `brief_reference` — human + audit fields.

**Per task:**

- `id` — kebab-case, unique within the feature.
- `agent` — the named agent responsible; must be a member of `feature.agent_sequence`.
- `depends_on[]` — task IDs within the SAME feature. Cross-feature deps live at `feature.depends_on`.
- `skills[]` — skill IDs to load when executing this task.
- `integration_ref` — pointer into architecture.yaml for vendor integrations.
- `priority` / `status` / `estimated_screens` / `summary` / `notes` — self-explanatory.

#### Feature-grouping heuristic

When PM produces `features[]` from architecture + requirements, use this heuristic (from refactor-004 plan and feat-003-git-agent-worktrees plan):

1. **Shared screen cluster** — tasks that touch the same user-flow (`docs/analysis/{platform}/flows.md` flow ID) merge into one feature. Example: "Flow 4 — password reset" → one feature covering the backend endpoint + the frontend form + the tests.
2. **Shared brief §11 feature ID** — tasks that implement the same brief-catalogue feature merge into one feature.
3. **Shared architecture.yaml integration** — multiple tasks all wiring the same vendor integration (e.g. Stripe checkout) merge into one feature.
4. **No grouping signal** — a task becomes a single-task feature. Still gets a worktree + branch; allows parallelism with other features.
5. **Feature slug** — auto-generated from the dominant screen / flow / integration. Example: `feat-password-reset`, `feat-stripe-checkout`, `feat-infra-seed-data`. Stable across regenerations so `depends_on` references survive.

#### v1 → v2 migration

v1 tasks.yaml (flat `tasks:` array with single `agent:` per task) is **deprecated** from refactor-004 forward. Since no project has produced a v1 tasks.yaml yet (PM hasn't run anywhere), no migration tool is needed. The orchestrator rejects v1 with:

```
tasks.yaml version is '1.0' or missing; orchestrator requires '2.0'.
See refactor-004-task-driven-orchestration. Re-run /pm --mode=tasks to regenerate.
```

### kit-change-request mini-plan template (--mode=kit-change-request)

```markdown
---
id: kit-change-request-{id}
type: refactor
status: draft
created: { YYYY-MM-DD }
branch: design/kit-bump-{id}
affected-files:
  - packages/ui-kit/CHANGELOG.md
  - packages/ui-kit/src/primitives/{new-primitive}.tsx
  - packages/ui-kit/stories/{new-primitive}.stories.tsx
feature-area: ui-kit
priority: P1
---

# Kit Change Request — {summary}

## Missing primitive / pattern / layout

{what the emitting stage needed and the kit didn't provide}

## Proposed addition

{minimal delta to the kit — one primitive / one pattern / one layout per request}

## Kit version bump

`{current} → {new}` (minor bump)

## Consumers requiring regeneration

- `{screen-id}` (emitted this request)
- {any other screens that would benefit — optional, PM surveys screens.json to find them}
```

### Key Responsibilities

**--mode=tasks (main)**:

- Read §12 (Key Features), §19 (Milestones), `docs/requirements.md`, `.claude/architecture.yaml`, `docs/analysis/{platform}/flows.md` (for grouping hints)
- Apply the feature-grouping heuristic (above) — merge related tasks into `features[]`
- Filter architecture.yaml `apps.*.integrations[]` to `deployment: vendor` + `deployment: self-hosted` entries; each contributes at least one task inside the appropriate feature
- `declined` integrations are skipped (no task emitted)
- Assign each task to the correct agent; ensure the agent appears in the parent feature's `agent_sequence`
- For each feature, determine the minimal `agent_sequence[]` covering all tasks + the tester + reviewer tail (builders → tester → reviewer is the typical order; `skip[]` removes tiers not needed)
- Set task + feature dependencies (e.g., backend task before frontend task within a feature; feature A before feature B if B consumes A's output)
- Set priorities (P0 = critical path, P1 = important, P2 = nice-to-have, P3 = polish)
- Estimate screen counts on frontend tasks for budget projection
- Write `docs/tasks.yaml` matching `schemas/tasks.schema.json` (v2); schema validation must pass before exit

**--mode=kit-change-request (detour)**:

- Read the specific kit-change-request file + `packages/ui-kit/package.json` + `packages/ui-kit/CHANGELOG.md`
- Author a mini-plan scoping exactly the kit delta needed (one primitive or one pattern — never a multi-primitive bundle; that's a design-cycle issue to escalate)
- Reference the emitting screen ID in the mini-plan
- Compute the new kit minor version number
- Surface as return JSON for the orchestrator to resume the design detour

## Acceptance Criteria

- [ ] `.claude/agents/project-manager.md` exists
- [ ] Skill accepts `--mode=tasks | --mode=kit-change-request` and rejects invocations without a mode with a clear error
- [ ] `docs/tasks.yaml.template` shows **v2** structure with `features[]` + per-feature `agent_sequence[]` + per-task `integration_ref` (refactor-004)
- [ ] Output validates against `schemas/tasks.schema.json` (v2) — `version: "2.0"` required
- [ ] Feature-grouping heuristic documented (shared flow ID / brief §11 / architecture integration → one feature)
- [ ] Every `task.agent` is a member of the parent `feature.agent_sequence` (cross-field invariant enforced at write time)
- [ ] `feature.depends_on[]` references resolve to other features in the same file; no cycles
- [ ] `plans/templates/kit-change-request-plan.md` template exists
- [ ] Dependencies, priorities, and agent assignments documented (tasks mode)
- [ ] Status tracking (pending, in-progress, completed, blocked, skipped)
- [ ] Kit-change-request mode produces mini-plans without requiring architecture.yaml
- [ ] Return JSON matches `PmOutput` (034b) — discriminated union on `mode`
- [ ] v1 tasks.yaml is deprecated; PM never emits flat `tasks:` arrays anymore

## Human Verification

1. Main mode: does tasks.yaml reference concrete vendor decisions via `integration-ref` fields pointing into architecture.yaml?
2. Detour mode: invoke mid-design with a sample kit-change-request. Does PM author a mini-plan without complaining about missing architecture.yaml?
3. Does the orchestrator's kit-change-request flow (035 §Kit-change-request detour) resume cleanly after PM writes the mini-plan?
