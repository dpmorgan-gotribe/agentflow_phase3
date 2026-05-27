---
name: fix-bugs
description: Run the orchestrator's automated bug-fix loop standalone against a project's `docs/bugs.yaml`. Iterates verify → fix → verify until clean OR caps hit. MANUAL operator override — the same loop fires automatically from `/start-build` after `/build-to-spec-verify` produces bugs. Use this skill only when you've manually edited `docs/bugs.yaml`, added externally-triaged entries, OR want to retry a previously-paused fix-loop without re-running Mode B.
when_to_use: when the operator has manually populated or edited `docs/bugs.yaml` and wants to dispatch the fix-loop without re-running Mode B; when a prior `/start-build` exited with `completed-with-integration-failures` and the operator has manually corrected something they expect the loop to now resolve; when iterating on a single failed bug after manual debugging
argument-hint: "<project> [--max-iterations=N] [--max-concurrent=N] [--bugs-file=<path>] [--dry-run]"
allowed-tools: Read Bash Grep Glob
model: inherit
---

# /fix-bugs — standalone bug-fix loop driver

Manually invokes the factory orchestrator's automated bug-fix loop (`runFixBugsLoop` in `orchestrator/src/fix-bugs-loop.ts`) against a named project. Same machinery as the auto-invocation that fires from `/start-build` after `/build-to-spec-verify` produces bugs — this skill just lets the operator trigger it independently.

**Critical**: this skill is the OPERATOR-OVERRIDE channel. The auto-invocation from Mode B already covers the common path. Use `/fix-bugs` only when:

- you manually edited `docs/bugs.yaml` (added a bug entry from external triage, bumped a `maxAttempts`, etc.)
- a prior `/start-build` paused mid fix-loop and you want to resume just that part
- you fixed something by hand outside the orchestrator and want to clear the failed-bug backlog

**This skill does NOT touch `/plan-bug`-authored plans**. `/plan-bug` is the user-only channel for human-discovered bugs; `bugs.yaml` is the orchestrator-only channel for verifier-discovered bugs. The two channels never overlap by design.

## Arguments

- `<project>` (required) — project directory under `projects/`. Must exist and must have `docs/bugs.yaml`.
- `--max-iterations=N` — override the loop's iteration cap (default 5).
- `--max-concurrent=N` — override the per-iteration dispatch concurrency (skill default 3; orchestrator hard-caps at 3 per bug-059 event-loop-starvation finding on reading-log-01 at concurrency=5). Pass `--max-concurrent=1` to force serial dispatch when debugging a specific bug class. Pass `FIX_BUGS_MAXCONCURRENT_OVERRIDE=N` env var to bypass the 3-cap for empirical experimentation.
- `--bugs-file=<path>` — override the default `docs/bugs.yaml` (rare; useful for testing forks).
- `--dry-run` — preview which bugs would dispatch + estimated cost; invoke no agents.

**Why `--max-concurrent=3` is the skill default:** the orchestrator's `runFixBugsLoop` defaults internally to `maxConcurrent: 1` (sequential, single-worktree). Empirical reading-log-02 run 2026-05-11: 21 bugs at ~9 min/bug = ~3hr wall-clock for one iteration. With `--max-concurrent=3` (parallel per-bug worktrees via feat-046 Phase A.1), expected ~1hr for the same workload. The 3-cap is the safe ceiling; concurrency=5 caused 5-17 dropped keepalive ticks + 156-509s drift on bug-059 empirical. Caller can override with `--max-concurrent=1` to force serial when diagnosing a single bug class.

Rejected inputs:

- Missing `<project>` → error with a list of available `projects/*/`
- `<project>` exists but `docs/bugs.yaml` is missing → error: "No bugs.yaml at docs/bugs.yaml. Run /start-build first to generate one via the verifier, or manually create one matching schemas/bugs-yaml.schema.json."
- `bugs.yaml` exists but every bug is `status: completed` or `failed` → exit 0 with message "No pending bugs to work on."

## Steps

### 1. Parse + validate arguments

Extract `<project>` from positional. If empty, list projects and exit:

```
/fix-bugs requires a project name.
Available projects with docs/bugs.yaml:
  - kanban-webapp-10  (bugs.yaml: 6 pending, 2 completed, 1 failed)
  - revolution-pictures (bugs.yaml: 0 pending — nothing to do)
```

### 2. Read + validate `docs/bugs.yaml`

Validate against `schemas/bugs-yaml.schema.json`. Surface validation errors with line numbers and exit 1 — do NOT attempt to dispatch against a malformed file.

### 3. Preview (dry-run + live runs)

Always show a preview first:

```
About to run fix-bugs loop for kanban-webapp-10:
  - bugs.yaml at docs/bugs.yaml
  - 6 pending bugs (status: pending)
  - max-iterations: 5
  - max-concurrent: 3 (parallel per-bug worktrees; cap from bug-059)
  - bug-fix worktree: .claude/worktrees/fixup (shared merge target)
  - estimated cost: $12-30 per iteration × ~2 iterations = $24-60 total

Pending bugs (priority order):
  P0 bug-orphan-carddetailmodal     → web-frontend-builder, tester, reviewer (attempts: 0/3)
  P0 bug-flow-flow-4-card-modal     → web-frontend-builder, tester, reviewer (attempts: 0/3)
  P0 bug-flow-flow-3-board-edit     → web-frontend-builder, tester, reviewer (attempts: 1/3)
  P0 bug-flow-flow-5-card-create    → web-frontend-builder, tester, reviewer (attempts: 0/3)
  P0 bug-flow-flow-6-board-archive  → web-frontend-builder, tester, reviewer (attempts: 0/3)
  P0 bug-flow-flow-7-card-delete    → web-frontend-builder, tester, reviewer (attempts: 0/3)

Proceed? [y/N]
```

`--dry-run` exits here with no work.

### 4. Confirm + invoke

Live runs prompt `[y/N]`. On `y`, invoke the orchestrator:

```bash
cd <factory-root>
pnpm --filter orchestrator start generate <project> \
  --resume-feature-graph \
  --bugs-yaml-mode=append \
  --max-concurrent ${MAX_CONCURRENT:-3} \
  [other-flags]
```

The `--bugs-yaml-mode=append` flag tells the orchestrator NOT to archive `docs/bugs.yaml` at run start — instead, the existing file is read + the loop continues from saved state.

`--max-concurrent 3` is the skill-default per-iteration parallelism (3 bugs dispatched in parallel via per-bug worktrees, merge into shared `fixup` branch at iteration end). Without this flag the orchestrator's `runFixBugsLoop` falls back to sequential single-worktree (default `maxConcurrent: 1`), tripling wall-clock for any non-trivial bug set. The skill-default of 3 matches the hard cap from bug-059's empirical event-loop-starvation finding (anything above 3 drops keepalive ticks).

Stream stdout verbatim. The orchestrator emits structured log lines:

```
[fix-bugs-loop] iteration 1/5: 6 pending bugs
[fix-bugs-loop] dispatching web-frontend-builder for bug-orphan-carddetailmodal
[web-frontend-builder] wrote apps/web/src/components/board/KanbanBoard.tsx (+12 lines)
[fix-bugs-loop] bug-orphan-carddetailmodal: completed
[fix-bugs-loop] dispatching web-frontend-builder for bug-flow-flow-4-card-modal
...
[fix-bugs-loop] iteration 1 complete: resolved 5, failed 0, remaining 1
[fix-bugs-loop] re-running /build-to-spec-verify
[fix-bugs-loop] verify produced 1 new bug (bug-flow-flow-9-card-edit) — appended to bugs.yaml
[fix-bugs-loop] iteration 2/5: 2 pending bugs
...
[fix-bugs-loop] all bugs resolved; verify clean — loop exiting clean
```

### 5. Report exit

On status === "clean":

```
/fix-bugs kanban-webapp-10 complete.
2 iterations; 7 bugs resolved; 0 failed; 0 remaining.
Total spend: $24.50
```

On status === "iteration-cap-hit" or "all-bugs-failed":

```
/fix-bugs kanban-webapp-10 halted.
Status: iteration-cap-hit (5/5 iterations consumed)
  - resolved (4): bug-orphan-foo, bug-flow-flow-1, bug-flow-flow-2, bug-flow-flow-3
  - failed   (2): bug-flow-flow-4, bug-orphan-bar
  - remaining (1): bug-flow-flow-5

Failed bugs have been escalated to plans/active/ with `escalated-from-bugs-yaml: true` frontmatter.
Resume with: /fix-bugs kanban-webapp-10 (continues from saved bugs.yaml state)
```

### 6. Self-verify

- Exit code matches orchestrator's exit code
- `docs/bugs.yaml` reflects final per-bug statuses + iteration counter
- Failed-bug plan files (`plans/active/bug-NNN-*.md`) carry `escalated-from-bugs-yaml: true` frontmatter
- No secrets in transcript

## What this skill does NOT do

- **Does NOT run Mode A or any feature builds.** It only re-dispatches against existing bugs.
- **Does NOT touch `/plan-bug`-authored plans.** Those live in the user channel; this skill only iterates over the orchestrator-managed `docs/bugs.yaml`.
- **Does NOT clear or archive `docs/bugs.yaml`.** The `--bugs-yaml-mode=fresh` archival behavior is `/start-build`-only. This skill always uses `--bugs-yaml-mode=append`.
- **Does NOT auto-invoke from anywhere else in the factory.** The orchestrator's main path (Mode B → verify → loop) is the auto-channel; this skill is the manual override.
- **Does NOT modify the verifier or its bug-filing logic.** Pre-existing bugs.yaml entries are dispatched as-is.

## Error paths

- **`<project>` missing or invalid** → list available projects + exit 2
- **`docs/bugs.yaml` missing** → error pointing at `/start-build` to generate one
- **`docs/bugs.yaml` malformed** → schema validation error with line numbers; exit 1
- **No pending bugs** → exit 0 with friendly message; no work fired
- **Orchestrator binary missing** → "Factory orchestrator/ package not found. Run `pnpm install` at factory root."
- **Budget exceeded mid-run** → orchestrator halts + writes state; resume on next invocation

## Examples

### Standalone fix-loop after manual triage

```
/fix-bugs kanban-webapp-10
→ bugs.yaml: 6 pending, max-iterations: 5
→ Proceed? y
→ orchestrator runs...
→ exit 0: 7/7 resolved over 2 iterations, $24 spent
```

### Dry-run

```
/fix-bugs kanban-webapp-10 --dry-run
→ bugs.yaml: 6 pending
→ Pending bugs (priority order):
    P0 bug-orphan-carddetailmodal …
    P0 bug-flow-flow-4-card-modal …
    …
→ Estimated cost: $24-60 across ~2 iterations
→ No agents invoked.
```

### Override iteration cap for stubborn case

```
/fix-bugs kanban-webapp-10 --max-iterations=10
→ Loop runs up to 10 iterations (default 5)
```

### Force serial dispatch (debugging a specific bug class)

```
/fix-bugs kanban-webapp-10 --max-concurrent=1
→ Disables per-bug-worktree parallelism (skill default 3); runs one bug at a time in shared fixup worktree
→ Use when diagnosing a single bug type — easier to follow output, no worktree merge interleaving
```

### Custom bugs file

```
/fix-bugs kanban-webapp-10 --bugs-file=docs/bugs-experimental.yaml
→ Loop reads from docs/bugs-experimental.yaml instead of docs/bugs.yaml
→ Final write returns to the same custom path
```

## Factory ↔ project scope

Factory-level skill only. Lives at `.claude/skills/fix-bugs/SKILL.md` in the factory root. Not copied into `projects/<name>/.claude/skills/` by `/new-project` — it invokes the factory's `orchestrator/` binary against a named project, so it must run from factory root.

## Integration points

- **`orchestrator/src/fix-bugs-loop.ts`** — the loop runner this skill wraps
- **`orchestrator/src/cli-runner.ts`** — adds `--bugs-yaml-mode=append` flag handling
- **`packages/orchestrator-contracts/src/bugs-yaml.ts`** — schema for the input file
- **`schemas/bugs-yaml.schema.json`** — JSON-Schema export for external validators
- **`scripts/file-bug-plan.mjs`** — the verifier-side writer that originally populates bugs.yaml
- **`/start-build`** — the auto-invocation channel; this skill is the manual override

## Acceptance criteria

- [ ] `.claude/skills/fix-bugs/SKILL.md` exists with the frontmatter above
- [ ] Accepts `<project>` as required positional; rejects with available-projects list when missing
- [ ] Reads + validates `docs/bugs.yaml` against `schemas/bugs-yaml.schema.json`
- [ ] Always invokes orchestrator with `--resume-feature-graph --bugs-yaml-mode=append --max-concurrent ${MAX_CONCURRENT:-3}`
- [ ] Operator can override `--max-concurrent` to 1 (debug serial) or 2; values above 3 only honored when `FIX_BUGS_MAXCONCURRENT_OVERRIDE` env is set (orchestrator clamps per bug-059)
- [ ] Confirms before live run; skips confirmation for `--dry-run`
- [ ] Exit code matches orchestrator's exit code
- [ ] Factory-level only (NOT copied into per-project skill dirs)
- [ ] Does NOT touch `/plan-bug`-authored plans
- [ ] Does NOT auto-invoke from anywhere else (manual override channel only)
