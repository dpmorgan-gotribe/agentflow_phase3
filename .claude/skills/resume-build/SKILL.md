---
name: resume-build
description: Resume a previously-paused orchestrator Mode B run for projects/<name>/. Reads paused.json + feature-graph-progress.json, runs an in-flight worktree recovery decision tree, deletes paused.json, and dispatches a fresh orchestrator process with --resume-feature-graph + --pipeline-run-id pointed at the same run. Inverse of /pause-build.
when_to_use: when the user wants to continue a Mode B run that was previously paused (via /pause-build, SIGINT, Claude Max rate limit, auth-failed, or stall-timeout); after manually resolving the issue that caused the pause (e.g. waited for the 5h reset, fixed credentials); when the operator asks to "pick up where we left off" on a project
argument-hint: <name> [--yes] [--dry-run] [--ignore-master-drift] [--max-concurrent <n>]
allowed-tools: Read Write Bash Glob Grep
---

# /resume-build — Continue a Paused Mode B Run

Reads the pause sentinel + feature-graph progress snapshot for the
specified project, walks the in-flight worktree recovery decision tree,
deletes `paused.json`, and re-launches the orchestrator targeting the
same `pipelineRunId` so all already-merged features stay merged + only
the right next-agent gets dispatched per in-flight feature.

The lifecycle inverse of `/pause-build`. Same name regex, same
preview-by-default discipline as `/delete-project`.

## Arguments

- `<name>` (required) — project slug. Same regex as `/new-project`:
  `^[a-z][a-z0-9-]{1,48}$`.
- `--yes` — skip the preview gate and execute the resume.
- `--dry-run` — print the recovery plan only and exit 0. Mutually
  exclusive with `--yes`.
- `--ignore-master-drift` — proceed even if the project's current master
  HEAD differs from the SHA captured in `feature-graph-progress.json`
  at pause time. Default behavior is to warn + exit 2 unless the
  operator explicitly opts in.
- `--max-concurrent <n>` — passes through to the resumed orchestrator's
  `--max-concurrent` flag. Useful when the rate-limit posture has changed
  since the original `/start-build` (e.g. operator wants to drop from
  C=5 to C=3 to burn the five_hour bucket more slowly). When omitted,
  the orchestrator uses its default (sequential = 1 unless overridden in
  models.yaml).

## Steps

### 1. Validate `<name>`

- Regex: `^[a-z][a-z0-9-]{1,48}$`.
- Reject reserved names (same list as `/pause-build`).
- Reject path-escape attempts.
- On mutually-exclusive `--yes` + `--dry-run`, error.

### 2. Pre-flight

- Confirm CWD looks like the factory (.claude/agents/ + brief-template.md).
- Confirm `projects/<name>/` exists.

### 3. Resolve the run-id

Find the run-id by walking `projects/<name>/.claude/state/`. Specifically:

```
ls projects/<name>/.claude/state/*/paused.json 2>/dev/null
```

- **Zero matches**: error
  `No paused run found under projects/<name>/.claude/state/. Was
/pause-build invoked? Or has the orchestrator already been resumed?`.
  Exit 1.
- **One match**: that's the run-id (parent dir of paused.json).
- **Multiple matches**: pick the newest by mtime; warn `(warning: multiple
paused runs found — resuming most recent)`.

Set:

- `runIdDir = projects/<name>/.claude/state/<runId>`
- `pausedPath = $runIdDir/paused.json`
- `progressPath = $runIdDir/feature-graph-progress.json`
- `pidPath = $runIdDir/orchestrator.pid`

### 4. Read + validate the pause sentinel

- Parse `pausedPath` as JSON. Validate against the `PausedStateSchema`
  shape (the orchestrator's contract):
  - `version === "1.0"` (required)
  - `reason` ∈ `{user-request, sigint, claude-max-five-hour-limit,
claude-max-seven-day-limit, auth-failed, stall-timeout}`
  - `pipelineRunId === <runId>`
- On parse failure or schema mismatch, error
  `paused.json malformed; cannot resume safely. Inspect: <pausedPath>.`.
  Exit 2.
- If `reason ∈ {claude-max-five-hour-limit, claude-max-seven-day-limit}`
  AND `resetsAt` > current epoch seconds, warn
  `(warning: rate limit not yet reset — current=<now> resetsAt=<resetsAt>;
resuming anyway, the SDK will throw if still rate-limited)`.

### 5. Read + validate the progress snapshot

- Parse `progressPath` as JSON. Validate against the
  `FeatureGraphProgressSchema`.
- On missing file: warn `(warning: feature-graph-progress.json missing —
resume will be partial; orchestrator will rely on git state heuristics)`.
- On schema mismatch: error
  `feature-graph-progress.json malformed. Inspect: <progressPath>.`.
  Exit 2.

### 6. Master-commit-SHA drift check

- Run `git -C projects/<name> rev-parse master 2>/dev/null` (fallback to
  `main` if master doesn't exist).
- Compare with the snapshot's `masterCommitSha`.
- **Match**: continue silently.
- **Drift + `--ignore-master-drift`**: warn `(warning: master drifted
<snapshotSha> → <currentSha> — proceeding due to --ignore-master-drift)`.
- **Drift without flag**: error
  `master drifted since pause: snapshot=<snapshotSha>, current=<currentSha>.
Investigate the diff or re-run with --ignore-master-drift to override.`.
  Exit 2.

### 7. Walk the in-flight recovery decision tree

For each entry in `progress.inFlight[]`, inspect its worktree at
`projects/<name>/.claude/worktrees/<worktree>/`:

| Worktree state                                                | Action                                                                                                 | Recovery class  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------- |
| Directory missing                                             | Mark feature as failed → next orchestrator pass treats it as fresh                                     | `orphaned`      |
| Branch DOESN'T exist anymore (`git rev-parse <branch>` fails) | Mark feature aborted → surface to operator                                                             | `aborted`       |
| Worktree clean (`git status --porcelain` empty)               | Resume from `nextAgent` (or close-feature when nextAgent=null)                                         | `clean`         |
| Worktree dirty + `nextAgent !== null`                         | Stage + commit (`git add -A && git commit -m '<lastAgent>: resume snapshot'`) → advance to `nextAgent` | `dirty-advance` |
| Worktree dirty + `nextAgent === null`                         | Stage + commit (`git add -A && git commit -m '<lastAgent>: resume snapshot'`) → run close-feature next | `dirty-final`   |

**bug-020:** the previous decision tree split dirty worktrees by
`lastAgent`-tier — soft-resetting all dirty `backend-builder` /
`web-frontend-builder` / `mobile-frontend-builder` outputs and
preserving dirty `tester` / `reviewer` outputs. This was wrong for the
empirical hit where backend-builder produced ~2300 LOC, returned
successfully, and the orchestrator paused at the rate-limit BEFORE
running its per-agent auto-commit. The dirty state IS the completed
work; soft-reset destroys it.

The new rule preserves work universally: any dirty worktree gets
committed before advancing. Across the four scenarios that produce
dirty state at pause time, three are completed-but-uncommitted and
one — pause fires DURING agent execution — is mid-execution partial
output. The latter is rare (rate-limit hits typically fire at SDK API
boundaries, not mid-agent) and recoverable: tester runs against the
partial output, fails, the per-task retry ladder routes back to the
builder for a fix attempt.

**Operator note — mid-execution edge case.** If you suspect the
worktree's dirty state is partial output from an agent that was killed
mid-execution (versus an agent that returned successfully but didn't
commit), inspect the worktree before running `/resume-build`. If the
output is clearly incomplete — e.g. only stub files, half-written
imports, missing expected artefacts — manually `git -C
projects/<name>/.claude/worktrees/<worktree> reset --hard <branch>`
before resuming. The new commit-and-advance rule will then see a
clean worktree and route to the `clean` recovery class instead.

Future work: bug-020 Layer 3 (deferred) tracks a per-agent
`lastAgentCompletedAt` timestamp on the in-flight snapshot so the
classifier can distinguish completed-uncommitted vs mid-execution
without operator inspection. Spawn a follow-up bug if the manual
workaround proves insufficient.

Build a `recoveryPlan[]` array with one entry per in-flight feature:

```json
[
  {
    "featureId": "feat-filters",
    "class": "clean",
    "action": "advance to tester"
  },
  {
    "featureId": "feat-search",
    "class": "dirty-advance",
    "action": "commit + advance to web-frontend-builder"
  }
]
```

Do NOT execute the recovery actions yet — they happen in step 9.

### 8. Print the preview

```
/resume-build <name> — preview

Run id:                <runId>
Pause reason:          <reason> (at <pausedAt>)
Auth provider:         <authProvider> (current: <currentProvider>; match | DRIFT)
Master SHA:            <snapshotSha> (current: <currentSha>; match | DRIFT)

Progress snapshot:
  Completed: N (<csv of feature-ids>)
  Failed:    N (<csv>)
  Aborted:   N (<csv>)
  In-flight: N
    - <featureId>  branch=<branch>  lastAgent=<lastAgent>  nextAgent=<nextAgent>

Recovery plan:
  - <featureId>  class=<class>  action=<action>

Dispatch:
  pnpm --filter orchestrator start generate <name> --resume-feature-graph
  --pipeline-run-id <runId>
```

### 9. Confirmation gate

- `--dry-run` → print `Dry-run: nothing was modified.` and exit 0 with
  `preview: true, success: true`.
- `--yes` → continue.
- Neither → print `Re-run with --yes to confirm, or --dry-run to preview only.`
  and exit 0 with `preview: true, success: true`.

### 10. Execute the recovery actions

For each `recoveryPlan[]` entry, run the action documented in step 7.
Use `git -C projects/<name>/.claude/worktrees/<worktree> ...`. Capture
per-entry success/failure into `recovered[]`.

If ANY entry fails (e.g., `git reset --hard` errors out), STOP — do
NOT proceed to step 11. Surface the failures + exit 2 with
`success: false`. The operator can re-run after manually resolving the
worktree state.

### 11. Delete paused.json

```
rm projects/<name>/.claude/state/<runId>/paused.json
```

This unblocks the orchestrator's between-agent sentinel poll.

### 12. Dispatch the orchestrator resume

```
pnpm --filter orchestrator start generate <name> --resume-feature-graph
--pipeline-run-id <runId> [--max-concurrent <n>]
```

The `--pipeline-run-id` flag (added in feat-024 Phase D) tells the
orchestrator to reuse the existing run-id rather than mint a new one,
so the resumed process writes to the SAME `<runId>/counters.json` +
`feature-graph-progress.json` files.

**Orchestrator-side resume contract (bug-021):** when started with
`--resume-feature-graph` + `--pipeline-run-id <id>`, the orchestrator
hydrates `feature-graph-progress.json` from disk and seeds its in-memory
progress tracker from that snapshot. For each feature in `inFlight[]`,
`runFeature` then:

- SKIPS `checkout-feature` (the worktree exists; calling it would hit
  `stale-worktree`).
- Advances the `agent_sequence[]` walk to the index of `nextAgent`.
- When `nextAgent === null`, skips the walk entirely + goes to
  close-feature.

For each feature in `completed[]` / `failed[]` / `aborted[]`, the
topological loop pre-populates the result so the feature is NOT
re-dispatched. This is what closes the loop on the recovery actions
this skill performs in step 10 — without the hydration the orchestrator
would not see the in-flight entries and `checkout-feature` would
hard-fail with `stale-worktree`.

This is the LAST step the skill takes. The orchestrator runs in the
foreground (or background, depending on the user's invocation context) —
the skill's exit code reflects whether it dispatched the command
successfully, NOT whether the orchestrator's own run completed.

### 13. Self-verify

- `paused.json` is no longer present at `pausedPath`.
- The dispatch command exited with code 0 (or returned a process handle
  for foreground runs).

### 14. Return structured JSON

```json
{
  "success": true,
  "projectName": "<name>",
  "runId": "<runId>",
  "preview": false,
  "pauseReason": "<reason>",
  "recovered": [{ "featureId": "feat-x", "class": "clean", "ok": true }],
  "deleted": ["projects/<name>/.claude/state/<runId>/paused.json"],
  "dispatched": "pnpm --filter orchestrator start generate <name> --resume-feature-graph --pipeline-run-id <runId>",
  "warnings": [],
  "errors": [],
  "nextStep": "Orchestrator resumed. Watch its output for the dispatch of N in-flight features."
}
```

## Edge cases

- **No paused.json**: error
  `No paused run found. Run /pause-build <name> first, or check the
state directory manually.`. Exit 1.
- **paused.json malformed (parse error)**: error in §4. Exit 2.
- **Schema mismatch on paused.json or feature-graph-progress.json**:
  error. Exit 2.
- **Master drifted + no `--ignore-master-drift`**: error in §6. Exit 2.
- **Worktree branch missing (operator deleted it)**: feature marked
  aborted in §7; surface to operator in the JSON return.
- **Worktree directory missing**: feature marked failed; orchestrator's
  next pass redispatches from scratch.
- **Auth provider drift** (paused.json says `claude-max-subscription`
  but current `models.yaml` says `anthropic-api`): error
  `Auth provider drifted since pause: snapshot=<a> current=<b>.
Resume with the same provider, or accept the change explicitly by
editing paused.json before running /resume-build.`. Exit 2.
- **Both `--yes` and `--dry-run`**: rejected in §1.
- **rm of paused.json fails**: warn but continue to dispatch — the
  orchestrator will see the leftover sentinel and re-pause immediately,
  which is recoverable by manual cleanup.

## See also

- `/pause-build <name>` — the inverse op (writes paused.json).
- `feat-024-orchestrator-pause-resume.md` — the plan that introduced this
  skill, including the F5 in-flight recovery decision tree referenced in
  step 7.
- `investigate-007-orchestrator-liveness-and-pause.md` — parent
  investigation; details the auth-provider-drift detection rationale +
  the F5 worktree state matrix.

## Operator note (the SDK already started a new run)

If the user accidentally ran `/start-build` (or `pnpm generate ...`
without `--resume-feature-graph`) while paused.json was still present,
they now have TWO orchestrator runs of the same project — the new one
will mint a fresh `pipelineRunId` and start over.

To recover: kill the new run (Ctrl+C), delete its `<runId>/` directory,
and re-run `/resume-build <name>`. The feat-024 sentinel-poll catches
this race only if the pid file from the original run is still around;
post-feat-024 we'll add a "another run is already in flight" guard
during pre-flight (deferred to feat-025).
