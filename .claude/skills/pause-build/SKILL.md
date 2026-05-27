---
name: pause-build
description: Request a graceful pause of the active orchestrator Mode B run for projects/<name>/. Writes a paused.json sentinel that the running orchestrator polls between agent dispatches, drains in-flight work up to 60s, then exits 0. With --hard, also sends SIGINT to the orchestrator process via its dropped pid file. Inverse of /resume-build.
when_to_use: when the user asks to pause, halt, suspend, interrupt, or take a break from an in-progress Mode B run; when Claude Max five-hour quota is approaching and the user wants to checkpoint before the limit hits; when the operator notices an environment issue (low disk, rate limit, drifted master) and wants to stop dispatching new agents while preserving merged features
argument-hint: <name> [--hard] [--yes] [--dry-run]
allowed-tools: Read Write Bash Glob Grep
---

# /pause-build — Graceful Pause of an In-Flight Mode B Run

Writes `projects/<name>/.claude/state/<runId>/paused.json` (the sentinel
file the live orchestrator polls between agent dispatches). On the next
agent boundary the orchestrator drains its current dispatches up to 60s,
flushes `feature-graph-progress.json`, and exits 0.

The lifecycle inverse of `/resume-build`. Same name regex, same
preview-by-default discipline as `/delete-project`. When run without
`--yes` (and without `--dry-run`), prints a preview + does nothing.

## Arguments

- `<name>` (required) — project slug under `projects/`. Same regex as
  `/new-project`: `^[a-z][a-z0-9-]{1,48}$`.
- `--hard` — also send SIGINT to the orchestrator process (read from
  `<runId>/orchestrator.pid`). On the first SIGINT the orchestrator
  attempts a graceful drain; a second SIGINT within 5s force-exits.
  Without `--hard`, the orchestrator catches up to the sentinel between
  agents — typically within a few seconds for cheap stages, up to a
  builder's wall-clock timeout for an in-progress builder.
- `--yes` — skip the preview gate and write the sentinel. Without this
  flag, the skill prints the preview + exits 0 without touching the
  filesystem.
- `--dry-run` — print the preview only and exit 0. Mutually exclusive
  with `--yes`.

## Steps

### 1. Validate `<name>`

- Regex: `^[a-z][a-z0-9-]{1,48}$`.
- Reject reserved names: `active`, `archive`, `templates`, `test`,
  `shared`, `factory`.
- Reject paths that escape `projects/<name>/` (`..`, leading `/`, `\`,
  drive prefix).
- On failure, error with `Project name '<name>' invalid.`
- On mutually-exclusive `--yes` + `--dry-run`, error with
  `--yes and --dry-run are mutually exclusive.`

### 2. Pre-flight

- Confirm CWD looks like the factory: `.claude/agents/` and
  `brief-template.md` must both exist at CWD. If not, error
  `This doesn't look like the factory repo. Run from the agentflow-phase2 root.`.
- Confirm `projects/<name>/` exists. If not, error
  `Project 'projects/<name>/' not found.`.

### 3. Resolve the active run-id

Walk `projects/<name>/.claude/state/` and pick the directory with the
most-recently-modified `counters.json` (its mtime is the proxy for "the
active run"). Specifically:

```
ls projects/<name>/.claude/state/*/counters.json 2>/dev/null
```

For each match, run `stat --format='%Y' <path>` and select the newest.

- If there are zero matches, error `No active orchestrator run found
under projects/<name>/.claude/state/.`. Exit code 1.
- If there are matches but the newest is older than 24 hours, warn
  `(warning: most recent run is N hours old — pausing anyway)` but
  proceed.

The directory containing the chosen counters.json is the `<runId>`. Set:

- `runIdDir = projects/<name>/.claude/state/<runId>`
- `pausedPath = $runIdDir/paused.json`
- `pidPath = $runIdDir/orchestrator.pid`
- `progressPath = $runIdDir/feature-graph-progress.json`

### 4. Detect "already paused"

If `pausedPath` already exists, parse it + show the existing pause's
`reason` + `pausedAt`. Exit code 2:

```
Run is already paused (reason: <reason>; at: <pausedAt>).
Run /resume-build <name> to clear, or delete the file manually.
```

### 5. Print the preview

Always print, regardless of `--yes` / `--dry-run` / no-flag:

```
/pause-build <name> — preview

Run id:                <runId>
State directory:       projects/<name>/.claude/state/<runId>/
Mode:                  hard (SIGINT) | sentinel-only
Sentinel write target: paused.json (with reason: user-request)
Orchestrator pid:      <pid> (file present | file missing)
Progress snapshot:     feature-graph-progress.json (N completed, M in-flight, K failed)
```

Read `progressPath` to populate the progress snapshot row when it
exists. If it doesn't exist (run started before feat-024 landed), show
`(snapshot not present — orchestrator may have started before feat-024
shipped; resume will be partial)`.

### 6. Confirmation gate

- `--dry-run` → print
  `Dry-run: nothing was written. Re-run with --yes to commit.` and exit
  0 with `preview: true`, `success: true`.
- `--yes` → continue.
- Neither flag → print
  `Re-run with --yes to confirm, or --dry-run to preview only.` and
  exit 0 with `preview: true`, `success: true`.

### 7. Write the sentinel

Write `paused.json` to `pausedPath` with this exact shape (matches
`PausedStateSchema` in `@repo/orchestrator-contracts`):

```json
{
  "version": "1.0",
  "pausedAt": "<ISO-8601 UTC datetime now>",
  "reason": "user-request",
  "reasonDetail": "operator invoked /pause-build",
  "authProvider": "<read from progressPath if available, else 'unknown'>",
  "drainedInFlight": true,
  "pipelineRunId": "<runId>"
}
```

Use a tempfile + rename for atomic write (same pattern as the
orchestrator). The exact recipe (bash):

```
TMP=$(mktemp); cat > "$TMP" <<EOF
{
  "version": "1.0",
  "pausedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "reason": "user-request",
  "reasonDetail": "operator invoked /pause-build",
  "authProvider": "claude-max-subscription",
  "drainedInFlight": true,
  "pipelineRunId": "<runId>"
}
EOF
mv "$TMP" "$pausedPath"
```

### 8. Optional `--hard` SIGINT

If `--hard` is set:

1. Read `pidPath`. If missing or empty, warn
   `(warning: orchestrator.pid missing — cannot send SIGINT; sentinel
will catch up at next agent boundary)` and continue.
2. Parse the pid as a positive integer. If parse fails, warn similarly
   and continue.
3. Send SIGINT via Node's `process.kill(pid, "SIGINT")` (works on
   Windows via SetConsoleCtrlHandler abstraction).
4. Capture per-call success/failure into `removed.signaled[]`. If kill
   fails (process already gone, permission denied), capture warning
   but don't fail the skill — the sentinel write is still useful.

### 9. Self-verify

- `pausedPath` exists + parses as valid JSON.
- For `--hard`: the kill returned without throwing (or the warning was
  recorded).

### 10. Return structured JSON

```json
{
  "success": true,
  "projectName": "<name>",
  "runId": "<runId>",
  "preview": false,
  "wrote": ["projects/<name>/.claude/state/<runId>/paused.json"],
  "signaledPid": <pid-or-null>,
  "warnings": [],
  "errors": [],
  "nextStep": "Orchestrator will pause at the next agent boundary. Run /resume-build <name> to continue."
}
```

In dry-run / no-flag mode, `wrote: []` and `preview: true`.

## Edge cases

- **Empty `<name>`**: error
  `/pause-build requires a project name. Usage: /pause-build <name>
[--hard] [--yes|--dry-run]`. Exit 1.
- **No `.claude/state/` directory**: error
  `No orchestrator state under projects/<name>/.claude/state/. Has Mode B
ever run for this project?`. Exit 1.
- **counters.json present but feature-graph-progress.json missing**:
  warn but proceed — pre-feat-024 runs lack the progress file.
- **paused.json already exists**: exit 2 (idempotent — don't overwrite).
- **Both `--yes` and `--dry-run`**: rejected in §1.
- **Path contains backslashes (Windows)**: normalize to forward slashes
  before matching against `projects/<name>/`.
- **`process.kill` on Windows**: Node maps SIGINT to the process's
  console-event handler. The orchestrator's own SIGINT handler in
  `cli.ts` is the same on both platforms, so no platform branch needed.

## See also

- `/resume-build <name>` — the inverse op (clears paused.json + dispatches
  `pnpm --filter orchestrator start generate <name> --resume-feature-graph
--pipeline-run-id <runId>`).
- `feat-024-orchestrator-pause-resume.md` — the plan that introduced this
  skill, including the SDK API audit + paused.json schema.
- `investigate-007-orchestrator-liveness-and-pause.md` — parent
  investigation; details the F4 hybrid liveness mechanism + the F6 pause
  trigger triage.

## Operator note (orchestrator not running)

A common failure mode is `/pause-build` being called when the
orchestrator isn't actually running (the operator forgot they Ctrl+C'd
earlier, or the run already completed). The skill detects this loosely
via the counters.json mtime ("most recent run is N hours old" warning).

If the orchestrator IS gone but a stale paused.json sentinel was written
on top, the next `/resume-build` will start a NEW orchestrator process
that immediately sees the sentinel + re-pauses. Workaround:
`rm projects/<name>/.claude/state/<runId>/paused.json` manually before
re-running.
