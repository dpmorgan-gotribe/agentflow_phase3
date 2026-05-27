---
name: backend-builder
description: Dispatches to the backend stack skill at .claude/skills/agents/back-end/{stack-slug}/SKILL.md based on architecture.yaml.tooling.stack.backend_framework. Generates code + happy-path tests inside a feature worktree; runs lint/typecheck/test self-verify; returns BackendBuilderOutput.
when_to_use: invoked by orchestrator Mode B inside a feature worktree AFTER git-agent checkout-feature completes; one invocation per feature where the builder has assigned tasks
allowed-tools: Read Write Edit Bash Grep Glob
model: inherit
argument-hint: "--feature-id=<feat-...> [--task-ids=<csv>]"
---

# /backend-builder — stack-agnostic backend dispatcher

Invoked by the orchestrator (task-035 `invokeAgent("backend-builder", ...)` inside `runFeature`) with CWD = `.claude/worktrees/{feature.worktree}/`. Eight steps from argument gate through return JSON.

## Arguments

- `--feature-id=<feat-...>` (required). Identifies which feature in `docs/tasks.yaml` to execute. Rejected if missing.
- `--task-ids=<csv>` (optional). Scope the run to a specific subset of tasks (used by orchestrator per-task retries). Default: all backend-builder tasks in the feature.

Missing `--feature-id=` → abort with `"/backend-builder requires --feature-id=<feat-...>"`.

## Prerequisites

- CWD must be a feature worktree at `.claude/worktrees/{slug}/` (confirmed in step 5).
- `.claude/architecture.yaml` exists at the MAIN working tree root (walk up from CWD until found).
- `docs/tasks.yaml` v2 exists and validates against the schema.
- `.claude/rules/testing-policy.md` exists.
- Stack skill at `.claude/skills/agents/back-end/{stackSlug}/SKILL.md` exists (resolved in step 3).
- `.env` (sanctioned read only) accessible at main tree root for runtime config validation.

## Steps

### 1. Argument gate

- Parse `--feature-id=` + optional `--task-ids=`. Reject missing feature-id.
- Resolve the main working tree root: walk up from CWD until `.claude/architecture.yaml` exists. Call this `projectRoot`. Your CWD stays the worktree; reads from the main tree use `{projectRoot}/<relative>` explicitly.

### 2. Load architecture

- Read `{projectRoot}/.claude/architecture.yaml`.
- Extract `tooling.stack.backend_framework` → `stackSlug`.
- If `stackSlug === null` → exit cleanly with:
  ```json
  {
    "tier": "backend",
    "success": true,
    "stackSlug": null,
    "featureId": "<feature-id>",
    "tasksCompleted": [],
    "tasksFailed": [],
    "tasksSkipped": [],
    "totalFilesWritten": 0,
    "totalTestsWritten": 0,
    "avgCoverageBuilderScope": 0,
    "lintPassed": true,
    "typecheckPassed": true,
    "testsPassed": true,
    "headSha": null,
    "warnings": ["tier-skipped: no backend_framework in architecture.yaml"]
  }
  ```

### 3. Load stack skill

- Read `{projectRoot}/.claude/skills/agents/back-end/{stackSlug}/SKILL.md` VERBATIM into your prompt context.
- If the file doesn't exist → abort:
  ```json
  {
    "tier": "backend",
    "success": false,
    "stackSlug": "<slug>",
    "featureId": "<feature-id>",
    "tasksCompleted": [],
    "tasksFailed": [],
    "tasksSkipped": [],
    "totalFilesWritten": 0,
    "totalTestsWritten": 0,
    "avgCoverageBuilderScope": 0,
    "lintPassed": false,
    "typecheckPassed": false,
    "testsPassed": false,
    "headSha": null,
    "warnings": [
      "stack-skill-missing at .claude/skills/agents/back-end/<slug>/SKILL.md; run /skills-audit --scope=build --auto-author-stack-skills"
    ]
  }
  ```

### 4. Load tasks

- Read `{projectRoot}/docs/tasks.yaml`.
- Find the feature where `features[].id === --feature-id`. If not found → abort with `feature-not-found` warning.
- Filter `features[N].tasks[]` to tasks where:
  - `agent === "backend-builder"`
  - Parent feature's `skip[]` does NOT include `"backend"`
  - If `--task-ids=` supplied, additionally filter to `tasks[].id` in that CSV
- If zero tasks remain → exit cleanly with `tier-skipped-for-feature` warning (this feature's backend work is empty or explicitly skipped).

### 5. Confirm worktree CWD

- Read `./.feature-context.json` (the lockfile in your CWD).
- If missing → abort with `worktree-not-initialized; orchestrator wiring bug`.
- Validate via `node {projectRoot}/scripts/validate-feature-context.mjs ./.feature-context.json` → exit 0 required.
- Confirm `.feature_id` matches `--feature-id`. Mismatch → abort with `feature-id-mismatch; worktree opened for a different feature`.

### 6. Per-task execute + self-verify

Topologically sort tasks by their `depends_on[]` (within-feature only per cross-field invariants). For each task in order:

1. **Read stack skill §Canonical layout + §Idioms** — those sections drive what files you write and where.
2. **Generate implementation files** for this task's scope. Stack-specific idioms come from the stack skill, NEVER from agent memory.
3. **Generate sibling happy-path tests** per stack skill §Testing. Scope:
   - Canonical success case of each public function / endpoint
   - Primary branch of each non-trivial conditional
   - Positive input-validation at boundaries
   - Edge cases / error paths are tester's job (feat-009)
4. **Commit**: `git add <files> && git commit -m "feat({task.id}): <summary>"`. Use conventional-commit format.
5. **Self-verify**: run stack skill's §Commands block (`lint && typecheck && test` or the stack-specific equivalent).
   - Parse output. If any of lint/typecheck/test fails → retry up to 2× with the error output appended to your prompt context. After 3rd failure, mark the task as `failed` in `tasksFailed[]` with the error in `errors` field; continue to next task.
   - Parse coverage. If `<60%` on builder-authored lines → generate more happy-path tests OR mark task as `failed` with `coverage-below-floor` error.
6. **Record outcome**:
   ```json
   {
     "taskId": "<task.id>",
     "status": "completed" | "failed",
     "filesWritten": [...],
     "testsWritten": [...],
     "coverageBuilderScope": <0-100>,
     "commitSha": "<HEAD sha after commit, or null on failure>",
     "errors": "<only on failure>"
   }
   ```

### 7. Update feature-context.json

After all tasks complete (success or failure):

- Read `./.feature-context.json`.
- Append ONE entry to `agent_history[]`:
  ```json
  {
    "agent": "backend-builder",
    "op": "execute-tasks",
    "started_at": "<step-6-start-iso>",
    "finished_at": "<now-iso>",
    "outcome": "success" | "failure",
    "commit_sha": "<final HEAD after all commits>",
    "notes": "<'N tasks completed, M failed' summary>"
  }
  ```
- Set `last_writing_agent: "backend-builder"` (only if at least one task committed — preserves the invariant that `last_writing_agent` points to the last agent with a real commit).
- Re-validate via `validate-feature-context.mjs`.

### 8. Emit BuilderOutput JSON

```json
{
  "tier": "backend",
  "success": <all tasks completed>,
  "stackSlug": "<slug>",
  "featureId": "<feature-id>",
  "tasksCompleted": [...],
  "tasksFailed": [...],
  "tasksSkipped": [...],
  "totalFilesWritten": <sum>,
  "totalTestsWritten": <sum>,
  "avgCoverageBuilderScope": <average across completed tasks>,
  "lintPassed": <aggregate>,
  "typecheckPassed": <aggregate>,
  "testsPassed": <aggregate>,
  "headSha": "<final HEAD after all commits, or null if no commits>",
  "warnings": [...]
}
```

Orchestrator validates via `BackendBuilderOutput` from `@repo/orchestrator-contracts` before advancing `agent_sequence[]`.

## Error paths

- **Missing `--feature-id=`** → abort at step 1 with usage message.
- **No architecture.yaml** → abort; agent wiring bug (orchestrator should not invoke builders pre-architect).
- **No backend_framework in architecture** → exit cleanly with tier-skipped warning (step 2).
- **Stack skill missing on disk** → abort with skills-audit pointer (step 3).
- **Feature not found in tasks.yaml** → abort with `feature-not-found`.
- **Not in a worktree (no .feature-context.json in CWD)** → abort with orchestrator-wiring-bug message.
- **.feature-context.json feature_id mismatch** → abort.
- **Per-task failure after 3 retries** → mark the task failed; continue other tasks; final `success: false`.

## Integration Points

- **Task 035 orchestrator `runFeature`** calls this skill via `invokeAgent({ agent: "backend-builder", cwd: worktreeCwd, ... })`.
- **Stack-skill shelf (feat-002)** at `.claude/skills/agents/back-end/{slug}/` — loaded in step 3.
- **`.claude/rules/testing-policy.md`** — load into prompt context in step 3 alongside the stack skill.
- **git-agent skill** owns the worktree lifecycle bookending this builder's run; this skill does NOT touch worktree ops.
- **`BackendBuilderOutput` Zod schema** (`@repo/orchestrator-contracts/src/builder.ts`) validates the return JSON.

## Acceptance criteria

- [ ] Skill file registers in available-skills list
- [ ] Rejects invocations without `--feature-id=`
- [ ] Exits cleanly with tier-skipped warning when backend_framework is null
- [ ] Aborts with skills-audit pointer when stack skill is missing
- [ ] Filters tasks correctly per feature.skip[] + task.agent + optional --task-ids
- [ ] Confirms worktree CWD via .feature-context.json; rejects mismatch
- [ ] Generates implementation + sibling happy-path tests per stack skill §Canonical layout + §Testing
- [ ] Runs stack skill's lint/typecheck/test self-verify; retries ≤2x on failure
- [ ] Asserts ≥60% coverage on builder-authored lines
- [ ] Appends exactly ONE entry to .feature-context.json.agent_history per invocation
- [ ] Updates last_writing_agent when commits happen
- [ ] Returns BackendBuilderOutput matching @repo/orchestrator-contracts schema
