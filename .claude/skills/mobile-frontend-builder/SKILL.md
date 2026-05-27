---
name: mobile-frontend-builder
description: Dispatches to the mobile stack skill at .claude/skills/agents/mobile/{stack-slug}/SKILL.md based on architecture.yaml.tooling.stack.mobile_framework. Generates code + happy-path tests inside a feature worktree; enforces @repo/ui-kit consumption contract with platform-aware primitives; runs lint/typecheck/test self-verify; returns MobileFrontendBuilderOutput.
when_to_use: invoked by orchestrator Mode B inside a feature worktree AFTER git-agent checkout-feature completes; one invocation per feature where the builder has assigned tasks
allowed-tools: Read Write Edit Bash Grep Glob
model: inherit
argument-hint: "--feature-id=<feat-...> [--task-ids=<csv>]"
---

# /mobile-frontend-builder — stack-agnostic mobile dispatcher

Invoked by the orchestrator (task-035 `invokeAgent("mobile-frontend-builder", ...)` inside `runFeature`) with CWD = `.claude/worktrees/{feature.worktree}/`. Eight steps, identical dispatcher structure to web-frontend-builder with tier-specific differences called out below.

## Arguments

- `--feature-id=<feat-...>` (required). Missing → reject.
- `--task-ids=<csv>` (optional). Scope to a subset of tasks.

## Prerequisites

- CWD at `.claude/worktrees/{slug}/`
- `.claude/architecture.yaml` at main working tree root
- `docs/tasks.yaml` v2
- `.claude/rules/testing-policy.md`
- Stack skill at `.claude/skills/agents/mobile/{stackSlug}/SKILL.md`
- `packages/ui-kit/` with platform-aware variants (kit handles iOS/Android split internally)
- `docs/screens/mobile/*.html` (composed by `/screens` at mobile viewport)

## Steps

### 1. Argument gate

Parse `--feature-id=` + optional `--task-ids=`. Reject missing. Walk up from CWD to find `projectRoot`.

### 2. Load architecture

Read `{projectRoot}/.claude/architecture.yaml` → `tooling.stack.mobile_framework` → `stackSlug`. If `null` → exit cleanly with `tier-skipped: no mobile_framework in architecture.yaml`.

### 3. Load stack skill

Read `{projectRoot}/.claude/skills/agents/mobile/{stackSlug}/SKILL.md` VERBATIM into prompt context. Missing → abort with skills-audit pointer.

Also read `.claude/rules/testing-policy.md`.

### 4. Load tasks

Filter `docs/tasks.yaml features[].tasks[]` to:

- `agent === "mobile-frontend-builder"`
- Parent feature's `skip[]` does NOT include `"mobile"`
- If `--task-ids=` supplied, additionally filter

Zero tasks → exit cleanly with `tier-skipped-for-feature`.

### 5. Confirm worktree CWD

Read `./.feature-context.json`. Validate. Confirm `feature_id` matches.

### 6. Per-task execute + self-verify

Topologically sort by within-feature `depends_on[]`. Per task:

1. **Read stack skill §Canonical layout + §Idioms + §Native-module patterns + §Kit-consumption contract.** Mobile-specific concerns (gesture handler, haptic feedback, keyboard avoidance, native permissions) flow from the §Native-module patterns section — don't improvise.
2. **Read the relevant screens** for this task. Look up the feature's `brief_reference` → resolve flow ID(s) → read `docs/screens/mobile/<screen-id>.html`.
3. **Walk each screen's DOM** — `data-kit-*` attributes map to kit imports. The kit's **mobile variants** render native components (`<Pressable>` not `<button>`, etc.) — the kit handles the platform split; your job is the composition.
4. **If a kit primitive is missing for a mobile-specific concern** (native gesture, camera permission UI, etc.): write `docs/screens/kit-change-requests/<screen-id>.md` at the **main working tree root**; mark task failed; continue. Same detour path as web-frontend-builder.
5. **Native-module installs** (config plugin for Expo, manual linking for bare RN): follow stack skill §Native-module patterns. Changes to `ios/` or `android/` only through the stack skill's documented mechanisms.
6. **Generate sibling happy-path tests** per stack skill §Testing:
   - Screen/component renders with canonical props
   - Primary user interaction (tap/submit) fires handler
   - Positive navigation flow — navigating TO the screen produces expected state
   - Edge cases (deep links, offline, gesture conflicts, native-permission denials) = tester's scope
7. **Commit**: `git add <files> && git commit -m "feat({task.id}): <summary>"`.
8. **Self-verify**: stack skill's `lint && typecheck && test`. Retry ≤2×. Coverage ≥60%. Third failure → fail task with error, continue.

### 7. Update feature-context.json

Append ONE `agent_history[]` entry:

```json
{
  "agent": "mobile-frontend-builder",
  "op": "execute-tasks",
  "started_at": "<iso>",
  "finished_at": "<iso>",
  "outcome": "success" | "failure",
  "commit_sha": "<final HEAD>",
  "notes": "<summary>"
}
```

Set `last_writing_agent: "mobile-frontend-builder"` when ≥1 commit. Re-validate.

### 8. Emit BuilderOutput JSON

```json
{
  "tier": "mobile",
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

Orchestrator validates via `MobileFrontendBuilderOutput`.

## Mobile-specific kit rules

Same public-barrel / no-inline-style / no-hex discipline as web-frontend-builder, plus:

- Mobile kit variants are **platform-aware** internally. Same import surface (`import { Button, Card } from "@repo/ui-kit"`), but rendered components differ by platform. Don't wrap with `Platform.OS` checks — that's the kit's job.
- Native-module concerns (permissions, haptics, gestures, file access) go through the stack skill's §Native-module patterns. Don't hand-edit `ios/Info.plist` / `android/AndroidManifest.xml` outside what the stack skill directs.
- If the kit's mobile variants don't cover a mobile-specific concern, the kit-change-request path still applies — emit the request file and stop the task.

## Error paths

Same as backend-builder + web-frontend-builder: missing architecture / tasks / stack skill / worktree-wiring-bug / feature-not-found / per-task failure. All surface in BuilderOutput.

## Integration Points

- **Task 035 orchestrator `runFeature`** invokes this skill.
- **Stack-skill shelf** at `.claude/skills/agents/mobile/{slug}/`.
- **Kit-change-request detour** (task-035 Phase 8).
- **git-agent** owns worktree lifecycle.
- **`MobileFrontendBuilderOutput` Zod schema** validates return.

## Acceptance criteria

- [ ] Skill file registers in available-skills list
- [ ] Rejects invocations without `--feature-id=`
- [ ] Exits cleanly with tier-skipped when mobile_framework is null
- [ ] Aborts with skills-audit pointer when stack skill missing
- [ ] Filters tasks per feature.skip[] (includes "mobile" → skip), task.agent, optional --task-ids
- [ ] Translates `data-kit-*` attrs from `docs/screens/mobile/*.html` into kit imports (platform-aware variants handled by kit)
- [ ] On missing kit primitive, emits `docs/screens/kit-change-requests/*.md` + fails the task
- [ ] Native-module concerns handled via stack skill §Native-module patterns (no hand-editing ios/ or android/ outside that)
- [ ] Runs stack skill's lint/typecheck/test; ≥60% coverage; retries ≤2x
- [ ] Appends exactly ONE agent_history entry per invocation
- [ ] Updates last_writing_agent when commits happen
- [ ] Returns MobileFrontendBuilderOutput matching @repo/orchestrator-contracts schema
