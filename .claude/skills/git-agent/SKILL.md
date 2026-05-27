---
name: git-agent
description: Owns worktree lifecycle + branch management + merge-to-main + conflict routing during orchestrator Mode B. Invoked ONLY at feature boundaries (bootstrap, checkout-feature, close-feature, resolve-conflict-handoff, emergency-abort). Never inline inside builder/tester/reviewer work. Operations are deterministic git commands + lockfile writes; no long reasoning.
when_to_use: invoked by orchestrator (task-035) at Mode B stage transitions; never invoked inline inside feature work
allowed-tools: Read Write Bash Grep Glob
model: inherit
argument-hint: "--op=bootstrap | checkout-feature | close-feature | resolve-conflict-handoff | emergency-abort [op-specific args]"
---

# /git-agent — worktree lifecycle operator

Invoked by the orchestrator (task-035) at feature boundaries during Mode B. Five operations, each with a deterministic input/output shape. All return JSON validated against `GitAgentOutput` (discriminated on `op`) from `@repo/orchestrator-contracts`.

## Arguments

Required: `--op=<bootstrap | checkout-feature | close-feature | resolve-conflict-handoff | emergency-abort>`

**Op-specific arguments:**

| Op                         | Required args                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `bootstrap`                | _(none)_                                                                                   |
| `checkout-feature`         | `--worktree=<slug>` `--branch=<branch>` `--feature-id=<feat-...>` `--agent-sequence=<csv>` |
| `close-feature`            | `--worktree=<slug>`                                                                        |
| `resolve-conflict-handoff` | `--worktree=<slug>` `--attempt=<1..3>`                                                     |
| `emergency-abort`          | `--worktree=<slug>` `--reason=<str>`                                                       |

Missing `--op=` → abort with message listing the 5 valid ops. Unknown op → same.

## Hard rules (enforced in every op)

- NEVER `git push --force` / `git push -f` / any variant of force-push
- NEVER `git reset --hard` on any branch
- NEVER rewrite history on pushed branches (no `rebase -i` + force-push, no `filter-branch`, no `filter-repo`)
- NEVER `--no-verify` (hooks must run)
- NEVER `--no-gpg-sign` (unless user explicitly overrides)
- NEVER read `.env` (enforced by block-dangerous.sh; this skill inherits)
- NEVER destroy work outside `.claude/worktrees/{slug}/` or the feature branch `feat/{slug}`

If an op's output JSON shape requires `success: false, reason: "..."`, prefer that over throwing — the orchestrator needs a structured failure to route retries.

## Op 1: `bootstrap`

Runs ONCE at the start of Mode B (final Mode A stage per task-035 STAGES[]).

### Preconditions

- `.git` exists at project root
- `git status --porcelain` returns empty (no uncommitted changes)
- Current branch equals `main` (or default branch)
- `git rev-parse HEAD` equals `git rev-parse origin/main` (local == remote)

### Actions

1. `mkdir -p .claude/worktrees/` (safety net — should already exist from `/new-project`)
2. Verify `.claude/worktrees/README.md` exists (do NOT create — missing README is a seeding bug, not something to paper over)
3. Capture `git rev-parse HEAD` for `mainSha`

### Output (success)

```json
{
  "op": "bootstrap",
  "success": true,
  "mainBranch": "main",
  "mainSha": "<40-char-sha>",
  "worktreeRoot": ".claude/worktrees",
  "cleanTree": true
}
```

### Output (failure — uncommitted changes)

```json
{
  "op": "bootstrap",
  "success": false,
  "reason": "uncommitted-changes",
  "files": ["path/to/changed/file", "..."]
}
```

### Output (failure — main branch mismatch)

```json
{
  "op": "bootstrap",
  "success": false,
  "reason": "main-branch-mismatch",
  "localSha": "<sha>",
  "remoteSha": "<sha>"
}
```

Orchestrator surfaces + aborts Mode B on either failure.

## Op 2: `checkout-feature`

Runs ONCE per feature at the start of `runFeature()`.

### Inputs

- `--worktree=<slug>` — matches `tasks.yaml features[].worktree`
- `--branch=<branch>` — matches `tasks.yaml features[].branch`
- `--feature-id=<feat-...>` — matches `tasks.yaml features[].id`
- `--agent-sequence=<csv>` — comma-separated `features[].agent_sequence[]` values

### Actions

1. Validate `--branch` matches `^(feat|fix|refactor|chore)/[a-z][a-z0-9-]+$`; reject otherwise
2. Check `.claude/worktrees/{worktree}/` existence:
   - If exists AND `.feature-context.json` valid AND `feature_id` matches → **idempotent re-invocation**; read + return existing lockfile contents (no git commands run)
   - If exists AND lockfile `feature_id` mismatches → return `success: false, reason: "stale-worktree"`, `existingWorktree: ".claude/worktrees/{worktree}"`
   - If not exists → proceed to step 3
3. `git worktree add -b {branch} .claude/worktrees/{worktree} origin/main` — fresh branch from origin/main
4. Capture `git rev-parse origin/main` → `{sha}`; compose `opened_from` as `main@{sha7}` (first 7 chars)
5. **Hide the lockfile from git's tracking.** Append `.feature-context.json` to **`.git/info/exclude`** (the common/shared exclude file at the main working tree's `.git/` — NOT the per-worktree `.git/worktrees/{slug}/info/exclude`, which is NOT consulted by `git status` inside a linked worktree per feat-008 Phase 4 findings). `.git/info/exclude` is shared across all worktrees; appending `.feature-context.json` once is idempotent (check if the line already exists; don't duplicate). This ensures `git status --porcelain` inside any worktree ignores the lockfile AND `git worktree remove` succeeds without `--force` during close-feature.
6. Write `.claude/worktrees/{worktree}/.feature-context.json` with:
   - `version: "1.0"`
   - `feature_id`, `worktree`, `branch` (from args)
   - `opened_at: <now-ISO>`
   - `opened_from: main@{sha7}`
   - `agent_sequence: [from --agent-sequence]`
   - `agent_history: []`
   - `last_writing_agent: null`
   - `status: "open"`
7. Validate the lockfile via `node scripts/validate-feature-context.mjs <path>` → must exit 0

### Output (success)

```json
{
  "op": "checkout-feature",
  "success": true,
  "worktreePath": ".claude/worktrees/{worktree}",
  "lockfilePath": ".claude/worktrees/{worktree}/.feature-context.json",
  "branch": "{branch}",
  "featureId": "{feature_id}"
}
```

### Output (failure — branch conflict)

```json
{
  "op": "checkout-feature",
  "success": false,
  "reason": "branch-conflict",
  "existingWorktree": ".claude/worktrees/{other-slug}"
}
```

(Fires when `git worktree add` reports the branch is already checked out elsewhere.)

### Output (failure — stale worktree)

```json
{
  "op": "checkout-feature",
  "success": false,
  "reason": "stale-worktree",
  "existingWorktree": ".claude/worktrees/{worktree}"
}
```

## Op 3: `close-feature`

Runs at end of `runFeature()` after every agent in `agent_sequence[]` has completed.

### Inputs

- `--worktree=<slug>`

### Actions

1. Read `.claude/worktrees/{worktree}/.feature-context.json`; extract `branch`, `feature_id`, `agent_history`.
2. Confirm worktree clean: `git -C .claude/worktrees/{worktree} status --porcelain` empty. If not empty → return failure with `reason: "uncommitted-in-worktree"` (builders failed to commit).
3. `git -C .claude/worktrees/{worktree} push origin {branch}` — push branch so history exists at origin.
4. Switch to main in the main working tree: `git checkout main`.
5. Attempt merge: `git merge --no-ff {branch} -m "Merge {branch}: {feature_id}"`.
6. **On clean merge:**
   - Capture merge commit: `git rev-parse HEAD` → `mergeSha`
   - `git push origin main` — push main to origin so `git branch -d` (safe-delete in step below) can verify the feature branch's history is on origin
   - `git worktree remove .claude/worktrees/{worktree}` (the `info/exclude` entry written at checkout-feature step 5 makes the lockfile invisible to this op, so `--force` is not needed)
   - `git branch -d {branch}` — safe-delete (remote branch persists at origin for audit)
   - Persist the closed-lockfile at `.claude/worktrees/{worktree}.closed.json`: copy the pre-removal lockfile contents + set `status: "closed"`, `merge_sha`, append agent_history entry `{ agent: "git-agent", op: "close-feature", outcome: "success", finished_at: <now>, commit_sha: mergeSha }`.
   - Return success.
7. **On conflict:**
   - Parse `git diff --name-only --diff-filter=U` → `conflictingFiles[]`
   - `git merge --abort` (keep worktree + main clean for the next attempt; the LAST WRITING AGENT will redo the work in the worktree, then close-feature re-fires)
   - Update lockfile: `status: "merge-conflict"`, `conflict_files: [...]`, `conflict_detected_at: <now>`
   - Return the conflict payload

### Output (clean merge)

```json
{
  "op": "close-feature",
  "success": true,
  "conflict": false,
  "mergeSha": "<sha>",
  "featureId": "{feature_id}"
}
```

### Output (conflict)

```json
{
  "op": "close-feature",
  "success": false,
  "conflict": true,
  "conflictingFiles": ["..."],
  "lastWritingAgent": "<from .feature-context.json>",
  "worktreePath": ".claude/worktrees/{worktree}"
}
```

## Op 4: `resolve-conflict-handoff`

Invoked by the orchestrator after `close-feature` returns conflict. Max 3 attempts tracked by the orchestrator.

**This op does NOT run any git commands.** It reads + updates the lockfile + returns the context the orchestrator needs to re-invoke the last-writing agent.

### Inputs

- `--worktree=<slug>`
- `--attempt=<1 | 2 | 3>`

### Actions

1. Read `.feature-context.json` → `last_writing_agent`, `conflict_files`.
2. Capture three SHAs:
   - `mergeBaseSha`: `git merge-base main {branch}`
   - `mainHeadSha`: `git rev-parse main`
   - `featureHeadSha`: `git -C .claude/worktrees/{worktree} rev-parse HEAD`
3. Append agent_history entry: `{ agent: last_writing_agent, op: "resolve-conflict", attempt: N, started_at: <now>, outcome: "in-progress" }`.
4. Return the handoff context.

### Output

```json
{
  "op": "resolve-conflict-handoff",
  "worktreePath": ".claude/worktrees/{worktree}",
  "conflictingFiles": ["..."],
  "lastWritingAgent": "{agent}",
  "attempt": N,
  "mergeBaseSha": "<sha>",
  "mainHeadSha": "<sha>",
  "featureHeadSha": "<sha>"
}
```

Orchestrator re-invokes the named agent with `retryContext`; agent re-edits the files inside the worktree; on completion, orchestrator re-fires `close-feature`.

## Op 5: `emergency-abort`

Irrecoverable failure. Invoked after 3 exhausted `resolve-conflict-handoff` attempts OR when a task's retry budget is exhausted (per orchestrator retry-counters.ts).

### Inputs

- `--worktree=<slug>`
- `--reason=<orchestrator-supplied string>`

### Actions

1. Read `.feature-context.json` → `feature_id`, `branch`.
2. `git worktree remove --force .claude/worktrees/{worktree}` — force-remove even if dirty.
3. `git branch -D {branch}` — force-delete local branch. Remote branch may persist for forensic review.
4. Write a closed-lockfile at `.claude/worktrees/{worktree}.aborted.json` with `status: "aborted"`, `failure_reason`, `agent_history` appended.
5. Update `docs/tasks.yaml` surgically: find the matching `features[].id` entry, set its `failure_reason` + `failed_at`. (Do NOT rewrite the whole file — use a targeted find+replace on that feature's block.)

### Output

```json
{
  "op": "emergency-abort",
  "success": true,
  "featureId": "{feature_id}",
  "reason": "{reason}",
  "cleanup": "worktree-removed"
}
```

## Self-verify (before returning)

For every op that writes a lockfile:

- `node scripts/validate-feature-context.mjs <lockfile-path>` must exit 0. On failure, restore from the pre-write copy (or delete the new file) and return `success: false` with the validator's error.

For every op:

- Return JSON parses against the corresponding variant of `GitAgentOutputSchema` before returning. If your output doesn't match the schema, fix it before returning.

## Integration Points

- **Orchestrator task-035** invokes this skill via `runFeature` + `runFeatureGraph` from `orchestrator/feature-graph.ts`. `invokeAgent({ agent: "git-agent", gitOp: { op: "...", ... } })` maps directly to this skill's argument contract.
- **`GitAgentOutput` Zod schema** (in `@repo/orchestrator-contracts`) validates the return JSON; orchestrator rejects malformed outputs.
- **`scripts/validate-feature-context.mjs`** validates the lockfile after every write.
- **`cleanup-stale-worktrees`** (off-band): user-run housekeeping; scans for `status: closed` / `status: aborted` / `opened_at > staleWorktreeReapDays ago`. NOT invoked by the orchestrator.

## Gate 6 Handoff (pre-merge HITL pause — PR review)

After `reviewer` approves a feature and BEFORE `git-agent close-feature` merges to main, the orchestrator inserts gate 6 ("pr-review"). Default behavior: wait for human approval unless `--auto-merge-after-reviewer` is passed on the orchestrator CLI (per `orchestrator/src/feature-graph.ts` `FeatureGraphContext.autoMergeAfterReviewer`).

To resolve gate 6, write ONE of the following directives to **`docs/gate-6-approved-{featureId}.txt`** (one file per feature — `{featureId}` is the `feat-*` slug):

- **`approved`** — PR-review approved; `git-agent close-feature` runs, merging to main and returning a `CloseFeatureSuccess` payload.
- **`changes:<note>`** — request changes with a note; pipeline routes back through the last builder in `agent_sequence[]` with the note as `retryContext.errorMessage`. Counts against the per-task retry cap (max 3).
- **`abort`** — leave the feature branch open + un-merged. The worktree is preserved; the feature is marked `aborted` in the feature-graph result.

When `--auto-merge-after-reviewer` is set, gate 6 is bypassed; reviewer's `approved` terminal verdict alone triggers `close-feature`. Recommended default: gate 6 ON for the first 3-5 autonomous runs (per investigate-002 answer #1 on autonomy boundaries); flip to auto-merge once trust builds.

Integration: `orchestrator/src/gate-server-lifecycle.ts::waitForGateDecision({ gateType: "pr-review", featureId })` file-watches `docs/gate-6-approved-{featureId}.txt`. `tryResolveGateFile` + `readPrReviewDirective` parse the body; directive grammar is strict. The orchestrator passes the resolved `lastWritingAgent` + worktree path to `close-feature` post-approval; on conflict, `resolve-conflict-handoff` routes back to the builder with conflicting-file list + attempt counter.
