---
task-id: "033"
title: "Git Agent — worktree lifecycle + branch management + merge-to-main + conflict routing"
status: pending
priority: P2
tier: 8 — Quality & Ship
depends-on: ["001", "021", "035"]
estimated-scope: medium
---

# 033: Git Agent — worktree lifecycle + branch management + merge-to-main + conflict routing

## What This Task Produces

1. Agent definition at `.claude/agents/git-agent.md`
2. Skill at `.claude/skills/git-agent/SKILL.md` accepting `--op=<operation>` for each lifecycle step
3. `schemas/feature-context.schema.json` — the lockfile contract for worktree state
4. `.claude/worktrees/README.md` — human-readable directory documentation

## Position in pipeline (refactor-004 + feat-003)

Refactor-004 split the orchestrator into Mode A (stage-linear through design + planning) and Mode B (feature-graph, post-PM). The git-agent is **invoked by the orchestrator at feature boundaries inside Mode B** — never as a standalone stage and never inline inside a builder / tester / reviewer's work.

The orchestrator's `runFeature(feature)` pseudocode (task 035 §Feature-graph phase) calls git-agent twice per feature:

- **Start of feature**: `invokeAgent("git-agent", { op: "checkout-feature", ... })` — opens the worktree + writes the lockfile
- **End of feature** (all `agent_sequence[]` members completed successfully): `invokeAgent("git-agent", { op: "close-feature", ... })` — merges feature branch into main + removes the worktree on clean merge

On merge conflict, `invokeAgent("git-agent", { op: "resolve-conflict-handoff", ... })` routes the conflict to the last writing agent; on exhaustion of retries, `{ op: "emergency-abort" }` destroys the worktree + deletes the branch + records failure in tasks.yaml.

Git-agent also runs **once at the start of Mode B** (`op: "bootstrap"`) to confirm the main working tree is clean + at `origin/main` before any feature worktrees open — the final Mode A stage per task 035's trimmed STAGES[] array.

## Scope

### Agent Definition

```yaml
---
name: git-agent
description: Owns worktree lifecycle + branch management + merge-to-main + conflict routing during the feature-graph phase. Invoked by the orchestrator at feature boundaries (checkout-feature, close-feature, resolve-conflict-handoff, emergency-abort) and once at Mode B bootstrap. Never invoked inline inside builder/tester/reviewer work.
tools: Read, Write, Bash, Grep, Glob
model: inherit
maxTurns: 15
effort: low
mcp_servers: []
---
```

Note: `effort: low` because the operations are deterministic (run exact git commands, read/write lockfile, check exit codes). No long-reasoning work. `mcp_servers: []` because git-agent uses local `git` CLI only — no Playwright / icons8 / vendor MCPs relevant.

### The 5 operations

#### 1. `bootstrap` — Mode A's final stage

Runs ONCE at the start of Mode B, after `/register-mcp-servers --scope=build` completes. Pre-flight for the feature-graph phase.

**Preconditions:**

- `.git` exists at project root
- `git status --porcelain` returns empty (no uncommitted changes — anything uncommitted aborts with a clear error pointing at the files; the user fixes + re-runs the orchestrator)
- Current branch is `main` (or whatever is configured as default)
- `git rev-parse HEAD` matches `git rev-parse origin/main` (local main = origin/main)

**Actions:**

- Create `.claude/worktrees/` if it doesn't exist (should already exist per `/new-project` step 3 — this is a safety net).
- Verify `.claude/worktrees/README.md` exists (seeded from `.claude/templates/worktrees-README.md` at `/new-project` time — NOT written by git-agent, since `.claude/worktrees/` is gitignored and git-agent should not paper over a missing seed).
- Return JSON: `{ op: "bootstrap", success: true, mainBranch: "main", mainSha: "<40-char sha>", worktreeRoot: ".claude/worktrees", cleanTree: true }`.

**On failure:**

- Uncommitted changes → return `{ success: false, reason: "uncommitted-changes", files: [...] }`. Orchestrator surfaces the error to the user and aborts Mode B.
- Main branch mismatch → return `{ success: false, reason: "main-branch-mismatch", localSha, remoteSha }`. Same abort path.

#### 2. `checkout-feature` — open a worktree for one feature

Invoked by `runFeature(feature)` at the start of each feature's execution.

**Inputs (passed by orchestrator):**

- `worktree` — the feature's `feature.worktree` value (kebab-case slug, e.g. `feat-password-reset`)
- `branch` — the feature's `feature.branch` value (e.g. `feat/password-reset`)
- `featureId` — the feature's `feature.id`
- `agentSequence` — the feature's `agent_sequence[]`, for recording in the lockfile

**Actions:**

1. Check if `.claude/worktrees/{worktree}/` already exists:
   - If yes AND `.feature-context.json` is valid AND matches the requested `featureId` → idempotent re-invocation (probably an orchestrator resume after crash); return the existing lockfile contents + proceed.
   - If yes AND lockfile mismatches → abort with `stale-worktree` error; human intervention needed (probably a leftover from a previous abort that didn't clean up).
   - If no → create fresh.
2. Run `git worktree add -b {branch} .claude/worktrees/{worktree} origin/main` (branch is created fresh from origin/main).
3. Write the lockfile `.claude/worktrees/{worktree}/.feature-context.json` per `schemas/feature-context.schema.json`:
   ```json
   {
     "version": "1.0",
     "feature_id": "feat-password-reset",
     "worktree": "feat-password-reset",
     "branch": "feat/password-reset",
     "opened_at": "2026-04-22T10:15:00Z",
     "opened_from": "main@a1b2c3d4",
     "agent_sequence": [
       "backend-builder",
       "web-frontend-builder",
       "tester",
       "reviewer"
     ],
     "agent_history": [],
     "last_writing_agent": null,
     "status": "open"
   }
   ```
4. Return JSON: `{ op: "checkout-feature", success: true, worktreePath: ".claude/worktrees/{worktree}", lockfilePath: "...", branch: "...", featureId: "..." }`.

**On failure:**

- Git worktree add fails (e.g. branch already exists on a different worktree) → return `{ success: false, reason: "branch-conflict", existingWorktree: "..." }`.
- Lockfile conflict → return `{ success: false, reason: "stale-worktree" }`.

#### 3. `close-feature` — merge the feature branch + remove the worktree

Invoked at the END of `runFeature()`, after every agent in `feature.agent_sequence[]` has signaled success.

**Inputs:**

- `worktree` — the feature's worktree slug

**Actions:**

1. Read `.claude/worktrees/{worktree}/.feature-context.json` to recover `branch` + `featureId`.
2. Confirm worktree has NO uncommitted changes: `git -C .claude/worktrees/{worktree} status --porcelain` — if not empty, abort with `uncommitted-in-worktree` (builders should have committed their work; if they didn't, that's a bug upstream).
3. `git -C .claude/worktrees/{worktree} push origin {branch}` — push the branch so the history exists at origin before the merge (also enables CI runs on the branch).
4. `git checkout main` in the MAIN working tree.
5. `git merge --no-ff {branch} -m "Merge {branch}: {featureId}"` — fast-forward disallowed; every feature produces one merge commit for auditability.
6. If merge returns non-zero (conflict):
   - **Do NOT remove the worktree**; leave it intact for the handoff.
   - Parse `git diff --name-only --diff-filter=U` to get conflicting files.
   - Update `.feature-context.json.status` to `merge-conflict`; record `conflict_files: [...]` + `conflict_detected_at: <iso-date>`.
   - Return `{ success: false, conflict: true, conflictingFiles: [...], lastWritingAgent: <from context>, worktreePath: "..." }` — orchestrator routes this to `resolve-conflict-handoff`.
7. On clean merge:
   - `git worktree remove .claude/worktrees/{worktree}` — removes the worktree directory.
   - `git branch -d {branch}` — deletes the local branch (remote remains for audit).
   - Update lockfile to `status: "closed"` (keep the file briefly for audit trail; orchestrator's `cleanup-stale-worktrees` sweeps closed ones eventually).
   - Return `{ success: true, conflict: false, mergeSha: "<sha>", featureId: "..." }`.

#### 4. `resolve-conflict-handoff` — route a conflict back to the last writing agent

Invoked by `runFeature()` when `close-feature` returns `conflict: true`. Orchestrator-owned retry counter (max 3 attempts per feature).

**Inputs:**

- `worktree` — same slug
- `attempt` — 1, 2, or 3 (orchestrator tracks)

**Actions:**

1. Read `.feature-context.json` → `last_writing_agent` + `conflict_files[]`.
2. Update lockfile: `agent_history` gains a new entry `{ agent: <last_writing_agent>, op: "resolve-conflict", attempt: N, started_at: <iso> }`.
3. **Return control to the orchestrator** with the context it needs:
   ```json
   {
     "op": "resolve-conflict-handoff",
     "worktreePath": ".claude/worktrees/{worktree}",
     "conflictingFiles": ["apps/web/src/auth/login.tsx", "..."],
     "lastWritingAgent": "web-frontend-builder",
     "attempt": 2,
     "mergeBaseSha": "<sha>",
     "mainHeadSha": "<sha>",
     "featureHeadSha": "<sha>"
   }
   ```
4. Orchestrator re-invokes the named agent with `retryContext` pointing at these files + the three commits. The agent re-edits the files in the worktree. On agent completion, orchestrator re-invokes `close-feature`.

**This op does NOT run git commands itself.** It reads + updates the lockfile and returns the context. Actual re-edit happens in the next agent invocation; actual re-merge happens in the next `close-feature` invocation.

#### 5. `emergency-abort` — irrecoverable failure

Invoked when `resolve-conflict-handoff` has been attempted 3 times without success, OR when an agent-level failure inside a worktree exceeds its retry budget (task.attempt_count > 3 per refactor-004).

**Inputs:**

- `worktree`
- `reason` — orchestrator-supplied string

**Actions:**

1. `git worktree remove --force .claude/worktrees/{worktree}` — forcibly remove even if dirty.
2. `git branch -D {branch}` — forcibly delete the local branch (remote may persist for forensics).
3. Update parent tasks.yaml: mark the corresponding feature as `status: failed` with `failure_reason: <reason>` + `failed_at: <iso>`. Orchestrator writes this via the agent's Write tool at a pre-agreed path (`docs/tasks.yaml` — agent has write permission; edits surgically only the one feature entry).
4. Return `{ op: "emergency-abort", success: true, featureId, reason, cleanup: "worktree-removed" }`. Orchestrator surfaces to human.

### `.feature-context.json` schema (schemas/feature-context.schema.json)

Lockfile contract — the source of truth for worktree state. Created by `checkout-feature`, updated by every git-agent invocation + by each agent in the sequence (they append to `agent_history` when they complete their work; this tells `close-feature` who wrote last for conflict routing).

Authoritative at `schemas/feature-context.schema.json` (shipped via this task); Zod mirror at `scaffolding/09-034b-output-contract-zod-schemas.md §feature-context.ts` (separate follow-up).

### Branch naming

Must match `feat/<slug>` | `fix/<slug>` | `refactor/<slug>` | `chore/<slug>`. Convention per task 021 (PM) — PM emits `feature.branch` values matching this shape. Git-agent does NOT rename; it validates the inbound value matches the regex before `git worktree add` and aborts otherwise.

### Commit messages

During a feature's work inside a worktree, BUILDERS / TESTER / REVIEWER commit their own changes with conventional-commit messages. Git-agent does NOT author commits inside the worktree — it only orchestrates worktree lifecycle + final merge. The merge commit git-agent writes is fixed-form:

```
Merge {branch}: {featureId}

{comma-separated list of tasks completed under this feature}
```

### Configurable behavior via `.claude/models.yaml`

```yaml
stages:
  feature-graph:
    maxConcurrentFeatures: 4 # how many worktrees run simultaneously
    maxMergeConflictRetries: 3 # per-feature conflict resolution attempts before emergency-abort
    staleWorktreeReapDays: 7 # cleanup-stale-worktrees threshold (off-band housekeeping op)
```

Git-agent reads these via the standard `readModelConfig()` merge (task 035 §Model Config Reader).

### `cleanup-stale-worktrees` (off-band housekeeping, not an orchestrator-invoked op)

Run manually or via `justfile` target:

```
just git-cleanup
```

Scans `.claude/worktrees/*/` for worktrees with `status: closed` OR `opened_at > staleWorktreeReapDays ago`. Removes their directories + deletes their branches. Not invoked by the orchestrator — post-run housekeeping that user runs when `.claude/worktrees/` grows.

### Never

- Force-push to `main` / `master`
- `git reset --hard` on main
- Rewrite history on pushed branches
- Skip hooks (`--no-verify`)
- Sign commits with `--no-gpg-sign` unless explicitly requested
- Read `.env` (inherits global block-dangerous.sh)

## Acceptance Criteria

- [ ] `.claude/agents/git-agent.md` exists with frontmatter + `effort: low` + `mcp_servers: []`
- [ ] `.claude/skills/git-agent/SKILL.md` exists accepting `--op=bootstrap|checkout-feature|close-feature|resolve-conflict-handoff|emergency-abort`
- [ ] `schemas/feature-context.schema.json` exists; required fields: version, feature_id, worktree, branch, opened_at, opened_from, agent_sequence, agent_history, last_writing_agent, status
- [ ] `.claude/worktrees/README.md` documents the directory lifecycle (factory-seeded; also appears in `/new-project` step 3 tree per refactor-004 Appendix D)
- [ ] `bootstrap` fails cleanly when main tree has uncommitted changes OR when local main != origin/main
- [ ] `checkout-feature` is IDEMPOTENT on repeat invocation (same feature_id + existing worktree = re-use; different feature_id = stale-worktree error)
- [ ] `close-feature` runs `git merge --no-ff` (never fast-forward) so every feature produces one merge commit
- [ ] `close-feature` routes conflicts via lockfile update + return payload — does NOT attempt to resolve
- [ ] `resolve-conflict-handoff` does not run git ops itself — returns context for the orchestrator to re-invoke the last writing agent
- [ ] `emergency-abort` forcibly removes worktree + deletes branch + marks feature `failed` in tasks.yaml
- [ ] Agent NEVER force-pushes, rewrites history, or skips hooks
- [ ] Branch names validated against `^(feat|fix|refactor|chore)/[a-z][a-z0-9-]+$` regex
- [ ] `cleanup-stale-worktrees` documented as off-band housekeeping (NOT orchestrator-invoked)
- [ ] `effort: low` used (operations are mechanical); `model: inherit` for orchestrator control
- [ ] Return JSON discriminated on `op` — different shapes per operation
- [ ] `schemas/feature-context.schema.json` cross-referenced from task 034b (Zod mirror in a future iteration)
- [ ] PM (task 021) feature-grouping heuristic emits `worktree` + `branch` values matching git-agent's expected shape (already present via refactor-004)
- [ ] Task 035 orchestrator §Feature-graph phase invokes git-agent by the exact op names in this doc (already present via refactor-004)

## Human Verification

1. Run a synthetic 3-feature fixture through an orchestrator dry-run. Expected: 3 `checkout-feature` invocations in sequence (concurrency=1 for test), 3 worktree dirs appear at `.claude/worktrees/{slug}/`, 3 `close-feature` invocations on completion, all 3 merged to main, all 3 worktree dirs removed.

2. Synthetic conflict: feature-A edits `apps/web/src/config.ts`; feature-B (depends-on A) edits the same file. `close-feature` on B returns `conflict: true`; orchestrator fires `resolve-conflict-handoff`; re-invokes web-frontend-builder with context; on re-edit, `close-feature` retries cleanly. Verify attempts 1-3 fire; on a hand-stubbed "still broken" path, `emergency-abort` fires; verify feature-B's tasks.yaml entry is marked `failed`.

3. Uncommitted changes at bootstrap: hand-modify a file in main tree, invoke bootstrap. Expected: error with `uncommitted-changes` + list of modified files.

4. Cleanup: open 3 worktrees, close only 2, wait 7+ days (simulate via mtime), run `just git-cleanup`. Expected: the closed 2 are removed; the open 1 remains untouched.

## Downstream implications

- Task 035 (orchestrator) — `runFeature()` pseudocode already references git-agent ops by name (refactor-004). Runtime implementation in `orchestrator/index.ts` pending (task 035 body).
- Task 021 (PM) — feature-grouping heuristic emits `worktree` + `branch` fields per feature; already documented in the refactor-004 update to 08-021-pm-agent.md.
- `/new-project` (018b) — `.claude/worktrees/` directory scaffolded at step 3; `.gitignore` excludes `.claude/worktrees/` at step 6. `.claude/worktrees/README.md` seeded at step 3 (factory template to be copied in).
- feat-004 (builder TDD) — stack skills referenced from tests run INSIDE the feature worktree, so their `test:` command must be idempotent relative to CWD. All shipped stack skills already use workspace-filter commands (`pnpm --filter @repo/api test`) which work from any worktree.
