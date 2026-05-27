# `.claude/worktrees/` — per-feature git worktrees

This directory holds **one git worktree per open feature** during the post-PM build phase. Worktrees let multiple features build in parallel without stomping on each other's uncommitted changes.

**This directory is gitignored.** Its contents are operational state, not tracked artefacts.

## Lifecycle

```
PM emits tasks.yaml v2 → orchestrator reads features[] →
  for each feature (respecting depends_on, max N concurrent):
    git-agent checkout-feature → .claude/worktrees/{slug}/ appears
    feature.agent_sequence runs inside the worktree
      (backend-builder, web-frontend-builder, tester, reviewer, ...)
    git-agent close-feature → merge to main + remove worktree
```

Each worktree directory is tracked by a lockfile at `.claude/worktrees/{slug}/.feature-context.json` — its schema is `schemas/feature-context.schema.json` (factory root). Manual hands-off: don't edit or delete directories in here while the orchestrator is running. If you see a stale worktree after an aborted run, use `just git-cleanup` (not `rm -rf`) to clean up — the cleanup command unregisters the worktree from `git worktree list` before removing files.

## Status values (from the lockfile)

- **`open`** — worktree is actively being worked. At least one agent is writing commits.
- **`merge-conflict`** — `close-feature` hit a merge conflict. Worktree is preserved until `resolve-conflict-handoff` → retried `close-feature` succeeds OR `emergency-abort` fires.
- **`closed`** — successful merge to main. Worktree dir removed by `git worktree remove`; lockfile retained briefly for audit (swept by `just git-cleanup`).
- **`aborted`** — irrecoverable failure. Worktree + branch forcibly removed; feature marked `failed` in `docs/tasks.yaml` for human review.

## Manual recovery

**If the orchestrator crashes mid-feature**, worktrees in `open` state are safe to keep. The orchestrator's resume path checks lockfiles on startup: matching `feature_id` + valid lockfile = idempotent reuse; mismatched = stale-worktree error (human intervention).

**If you're debugging a conflict** and want to inspect the worktree manually:

```
cd .claude/worktrees/<slug>
git status
git log --oneline main..HEAD       # commits unique to this feature
git diff main                      # total delta from main
```

Don't run `git push origin main` from inside a worktree — feature branches push via `git-agent close-feature`, not directly. The main branch is updated only via the `--no-ff` merge commit from `close-feature`.

**To forcibly remove a worktree** (last resort, when `just git-cleanup` doesn't work):

```
git worktree remove --force .claude/worktrees/<slug>
git branch -D feat/<slug>                    # delete the local branch
```

Then delete the lockfile if it remains. Never `rm -rf .claude/worktrees/<slug>` without first `git worktree remove` — git tracks worktrees in `.git/worktrees/` and orphaned entries confuse subsequent `git worktree add` calls.

## Configuration

The per-stage caps live in `.claude/models.yaml` under `stages.feature-graph`:

```yaml
stages:
  feature-graph:
    maxConcurrentFeatures: 4 # how many worktrees open simultaneously
    maxMergeConflictRetries: 3 # per-feature conflict resolution attempts
    staleWorktreeReapDays: 7 # just-git-cleanup age threshold
```

Tune these if you're running a large build on a constrained machine (lower `maxConcurrentFeatures`) or want automated cleanup more often (lower `staleWorktreeReapDays`).

## Files you'll see per open worktree

```
.claude/worktrees/feat-password-reset/
├── .git                              # symlink / pointer file to the main repo's .git
├── .feature-context.json             # lockfile — lifecycle state
├── apps/                             # full project tree at feat/password-reset HEAD
├── packages/
├── docs/
└── ...                               # everything else per main branch
```

The worktree is a **real checkout** — builders + testers cd into it and work just like they would in the main tree. When `close-feature` merges, the changes flow into main via the feature branch.

## Related

- `scaffolding/20-033-git-agent.md` — full git-agent operation contract
- `schemas/feature-context.schema.json` — lockfile validator
- `multi-agent-app-generation-blueprint.md` Appendix D — refactor-004 feature-graph phase
- `plans/active/feat-003-git-agent-worktrees.md` — this directory's feature plan
