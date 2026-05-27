---
name: web-frontend-builder
description: Dispatches to the web stack skill at .claude/skills/agents/front-end/{stack-slug}/SKILL.md based on architecture.yaml.tooling.stack.web_framework. Generates code + happy-path tests inside a feature worktree; enforces @repo/ui-kit consumption contract; runs lint/typecheck/test self-verify; returns WebFrontendBuilderOutput.
when_to_use: invoked by orchestrator Mode B inside a feature worktree AFTER git-agent checkout-feature completes; one invocation per feature where the builder has assigned tasks
allowed-tools: Read Write Edit Bash Grep Glob
model: inherit
argument-hint: "--feature-id=<feat-...> [--task-ids=<csv>]"
---

# /web-frontend-builder — stack-agnostic web dispatcher

Invoked by the orchestrator (task-035 `invokeAgent("web-frontend-builder", ...)` inside `runFeature`) with CWD = `.claude/worktrees/{feature.worktree}/`. Eight steps, identical dispatcher structure to backend-builder with tier-specific differences called out.

## Arguments

- `--feature-id=<feat-...>` (required). Missing → reject with `/web-frontend-builder requires --feature-id=<feat-...>`.
- `--task-ids=<csv>` (optional). Scope to a subset of tasks.

## Prerequisites

- CWD at `.claude/worktrees/{slug}/` (confirmed step 5)
- `.claude/architecture.yaml` at the main working tree root
- `docs/tasks.yaml` v2 valid
- `.claude/rules/testing-policy.md`
- Stack skill at `.claude/skills/agents/front-end/{stackSlug}/SKILL.md`
- `packages/ui-kit/` shipped (from `/stylesheet`) with public barrel
- `docs/screens/webapp/*.html` (composed by `/screens`; signed off at gate 4)

## Steps

### 1. Argument gate

Parse `--feature-id=` + optional `--task-ids=`. Reject missing. Walk up from CWD to find `projectRoot` (parent containing `.claude/architecture.yaml`).

### 2. Load architecture

Read `{projectRoot}/.claude/architecture.yaml` → `tooling.stack.web_framework` → `stackSlug`. If `null` → exit cleanly with `tier-skipped: no web_framework in architecture.yaml` warning + empty BuilderOutput.

### 3. Load stack skill

Read `{projectRoot}/.claude/skills/agents/front-end/{stackSlug}/SKILL.md` VERBATIM into prompt context. Missing → abort with `stack-skill-missing; run /skills-audit --scope=build --auto-author-stack-skills`.

Also read `.claude/rules/testing-policy.md` into context.

### 4. Load tasks

Filter `docs/tasks.yaml features[].tasks[]` to:

- `agent === "web-frontend-builder"`
- Parent feature's `skip[]` does NOT include `"web"`
- If `--task-ids=` supplied, additionally filter to that CSV

Zero tasks → exit cleanly with `tier-skipped-for-feature` warning.

### 5. Confirm worktree CWD

Read `./.feature-context.json`. Validate via `validate-feature-context.mjs`. Confirm `feature_id` matches `--feature-id`.

### 6. Per-task execute + self-verify

Topologically sort by within-feature `depends_on[]`. For each task:

1. **Read stack skill §Canonical layout + §Idioms + §Kit-consumption contract** — the 022b rules live here (public-barrel imports only, no inline-style, no hex in className).
2. **Read the relevant screens** for this task. For each UI-delivering task, the feature's `brief_reference` points into `docs/analysis/webapp/flows.md#flow-N`; resolve flow N's screen list from there or from the task's `summary` field. Read `docs/screens/webapp/<screen-id>.html` for each screen.
3. **Walk each screen's DOM** — every `data-kit-primitive="X"` / `data-kit-variant="Y"` / `data-kit-pattern="Z"` attribute maps deterministically to a kit import + component. Emit JSX (or framework-equivalent per the stack skill) that composes these primitives.
4. **If a required primitive/pattern is missing from the kit**: STOP. Write `docs/screens/kit-change-requests/<screen-id>.md` describing what's needed. Record the task as `status: "failed"` with `errors: "kit-change-request-emitted; see docs/screens/kit-change-requests/<screen-id>.md"`. Continue to the next task (do NOT abort the whole run; orchestrator routes the detour separately).
5. **Generate sibling happy-path tests** per stack skill §Testing:
   - Component renders without error with canonical props
   - Primary user interaction (click/submit) fires the right handler
   - Positive input-validation on forms
   - Error states, loading states, a11y deep-scan are tester's scope
6. **Commit**: `git add <files> && git commit -m "feat({task.id}): <summary>"`.
7. **Self-verify**: stack skill's `lint && typecheck && test` block. Retry ≤2× on failure. Coverage ≥60% on builder-authored lines. Third failure → mark task `failed` with error context, continue.

### 7. Update feature-context.json

Append ONE `agent_history[]` entry:

```json
{
  "agent": "web-frontend-builder",
  "op": "execute-tasks",
  "started_at": "<step-6-start-iso>",
  "finished_at": "<now-iso>",
  "outcome": "success" | "failure",
  "commit_sha": "<final HEAD>",
  "notes": "<N tasks completed, M failed>"
}
```

Set `last_writing_agent: "web-frontend-builder"` when at least one task committed. Re-validate.

### 8. Emit BuilderOutput JSON

```json
{
  "tier": "web",
  "success": <all tasks completed>,
  "stackSlug": "<slug>",
  "featureId": "<feature-id>",
  "tasksCompleted": [...],
  "tasksFailed": [...],
  "tasksSkipped": [...],
  "totalFilesWritten": <sum>,
  "totalTestsWritten": <sum>,
  "avgCoverageBuilderScope": <average>,
  "lintPassed": <aggregate>,
  "typecheckPassed": <aggregate>,
  "testsPassed": <aggregate>,
  "headSha": "<final HEAD or null>",
  "warnings": [...]
}
```

Orchestrator validates via `WebFrontendBuilderOutput` before advancing.

## Kit-consumption rules (task 022b contract)

Enforced at lint-time by `packages/ui-kit/eslint-plugin/`:

- `no-deep-imports` — imports from `@repo/ui-kit/src/...` forbidden. Public barrel only.
- `no-hex-in-className` — no hex literals in `className` attributes. Use kit tokens.
- `no-arbitrary-tailwind` — no arbitrary-value Tailwind classes that bypass the token system.
- `no-inline-style-tokens` — no `style={{}}` with token-colored values. Use the kit's variant system.

Your generated code MUST pass these rules. The stack skill's `lint` command block runs them; failure → same retry ladder as the other self-verify checks.

## Kit-change-request path

When a required primitive/pattern/layout is NOT in `@repo/ui-kit`:

1. Write `docs/screens/kit-change-requests/<screen-id>.md` (at the **main working tree root**, not inside the worktree — since the kit update lives at main tree `packages/ui-kit/`, not in your feature branch).
2. File shape:

   ```markdown
   ---
   emittingAgent: web-frontend-builder
   emittingScreen: webapp/<screen-id>
   requestedComponent: <component-name>
   emittingFeature: <feature-id>
   ---

   # Kit Change Request — <one-line>

   ## Missing

   <what the kit doesn't provide>

   ## Why

   <what screen/pattern needs it; quote the task summary>
   ```

3. Mark the task as `failed` in your BuilderOutput with `errors: "kit-change-request-emitted"`.
4. Continue to the next task. The orchestrator's kit-change-request detour (task-035 Phase 8) handles the interruption: invokes PM `--mode=kit-change-request` → re-runs `/stylesheet` with a new minor kit version → re-invokes this builder.

## Error paths

Same pattern as backend-builder: missing architecture / tasks / stack skill / worktree-wiring-bug / feature-not-found / per-task-failure-after-3-retries. All surface in the BuilderOutput warnings or tasksFailed with descriptive error strings.

## Integration Points

- **Task 035 orchestrator `runFeature`** invokes this skill.
- **Stack-skill shelf (feat-002)** at `.claude/skills/agents/front-end/{slug}/` — loaded step 3.
- **`packages/ui-kit/eslint-plugin/`** enforces kit-consumption via lint.
- **Kit-change-request detour** (task-035 Phase 8) resumes after `/stylesheet` rebuilds the kit.
- **git-agent** owns worktree lifecycle bookends; this skill never runs worktree ops.
- **`WebFrontendBuilderOutput` Zod schema** validates return.

## Acceptance criteria

- [ ] Skill file registers in available-skills list
- [ ] Rejects invocations without `--feature-id=`
- [ ] Exits cleanly with tier-skipped when web_framework is null
- [ ] Aborts with skills-audit pointer when stack skill missing
- [ ] Filters tasks per feature.skip[] (includes "web" → skip), task.agent, optional --task-ids
- [ ] Translates `data-kit-*` attrs from `docs/screens/webapp/*.html` into kit imports
- [ ] On missing kit primitive, emits `docs/screens/kit-change-requests/*.md` + fails the task (no silent workaround)
- [ ] Runs stack skill's lint/typecheck/test self-verify; ≥60% coverage floor; retries ≤2x
- [ ] Appends exactly ONE agent_history entry per invocation
- [ ] Updates last_writing_agent when commits happen
- [ ] Returns WebFrontendBuilderOutput matching @repo/orchestrator-contracts schema
