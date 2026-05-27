---
name: dag-status
description: Render the feature DAG of a Mode B project with live state markers ([DONE]/[FLOW]/[NEXT]/[WAIT]/[FAIL]/[ABRT]) + per-feature dependency edges + cumulative spend + per-model cost breakdown (incl. cache-hit ratio post-feat-031). Operator-facing pre-flight + during-run observability skill. Closes the "where are we in the cascade?" gap that previously required jq across 3 files.
when_to_use: during a Mode B run to see which features are in-flight vs. waiting on a chokepoint dependency; before /start-build to confirm the DAG looks right + which features will fan out together; after a paused.json fires to see exactly which feature was inFlight; periodically to watch cache-hit ratio climb post-feat-031 (modelBreakdown.cacheReadInputTokens / inputTokens)
argument-hint: [project-slug] [--json]
allowed-tools: Read Bash
---

# /dag-status — Feature-DAG state + spend snapshot

Reads `docs/tasks.yaml` (the feature DAG) +
`<runId>/feature-graph-progress.json` (live state) +
`<runId>/counters.json` (spend + per-model breakdown) and renders a
table of every feature with a state marker. Cross-links to
`/quota-status` for live SDK rate-limit visibility.

## Arguments

- `<project-slug>` (optional) — name under `projects/`. Defaults to
  the most-recently-touched project (by counters.json mtime across
  every project's runs).
- `--json` — emit a `DagStatusReport` JSON document for programmatic
  consumption (start-build pre-flight, future watchdog).

## Steps

### 1. Pre-flight

Confirm CWD looks like the factory: `.claude/agents/` and
`brief-template.md` must both exist at CWD. If not, error:
`This doesn't look like the factory repo. Run from the agentflow-phase2 root.`.

### 2. Run

```
pnpm --filter orchestrator dag-status                    # most-recent project
pnpm --filter orchestrator dag-status -- repo-health-dashboard-01
pnpm --filter orchestrator dag-status -- --json
```

The script:

1. Resolves the target project (operator arg or most-recent).
2. Picks the most-recent run-id under that project's
   `.claude/state/` directory (counters.json mtime).
3. Reads the 3 source files (tasks.yaml, feature-graph-progress.json,
   counters.json) — graceful if any are missing (treats absent state
   as "no features completed yet").
4. Walks every feature, classifies its state from progress (or from
   dependency-satisfaction if it hasn't started), prints the result.

### 3. Read the report

Plain-text shape:

```
Project:  repo-health-dashboard-01
Run ID:   6b5985b4-3543-4db2-8f3e-07d9026e76c8
Rendered: 2026-04-29T00:39:54Z

Summary:  1 done, 1 in-flight, 0 ready, 6 waiting
Spend:    $2.59 cumulative
Models:
  claude-sonnet-4-6      $1.84  in:24536  out:8412  cache-hit:42.3%
  claude-haiku-4-5       $0.04  in:2104   out:392   cache-hit: 0.0%

Features:
  [DONE]   feat-proxy-and-cache         P0
  [FLOW]   feat-web-shell               P0 ← feat-proxy-and-cache
              (web-frontend-builder → tester)
  [WAIT]   feat-home                    P0 ← feat-web-shell
  [WAIT]   feat-report                  P0 ← feat-web-shell
  …
```

State markers:

| Marker | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| [DONE] | Feature merged to master.                                        |
| [FLOW] | Currently dispatched (lastAgent → nextAgent shown below).        |
| [NEXT] | All deps satisfied; not yet started. Eligible for next dispatch. |
| [WAIT] | At least one dep is not in `completed[]`. Blocked.               |
| [FAIL] | Exhausted retry budget. Human review needed.                     |
| [ABRT] | Dependency-cascade abort (a dep failed → this is unreachable).   |

### 4. Decide

- **All [DONE] except a final [FLOW]** → run is wrapping up.
- **One [FLOW] + many [WAIT] on it** → DAG chokepoint (e.g., `feat-web-shell`
  is the chokepoint here). Wait for the [FLOW] feature; its merge
  unblocks a wave.
- **Multiple [FLOW]** → parallel dispatch is working (max-concurrent
  > 1).
- **Any [FAIL]** → operator triage required. Run
  `/plan-bug` against the failing feature OR check
  `<runId>/stall-log.json` for liveness info.
- **Any [ABRT]** → cascading failure from an upstream [FAIL]. Fix
  the upstream first; the aborted features will retry.

### 5. Cache-hit ratio (post-feat-031)

The Models section shows per-model cache-hit ratio
(`cacheReadInputTokens / inputTokens × 100`). After feat-031 ships
(systemPrompt with excludeDynamicSections), expected:

- First dispatch of an agent class: cache-hit ~0% (cache creation).
- Subsequent dispatches of the same agent class: cache-hit > 50%.

A persistent cache-hit ratio of 0% across multiple dispatches is a
signal that prompt caching isn't working — investigate before the
bucket cost balloons.

## Edge cases

- **Most-recent project has no runs**: error
  `No Mode B run found under projects/<name>/.claude/state/. Has /start-build been invoked?`
- **tasks.yaml is malformed**: error with the parser exception message.
- **counters.json missing**: spend + breakdown sections omitted; the
  feature table still renders.
- **feature-graph-progress.json missing**: every feature is classified
  as `[NEXT]` (no completed yet) or `[WAIT]` (has deps). Useful as a
  pre-flight before `/start-build`.

## Future (Phase B — deferred)

ETA forecast from historical Mode B run durations. Walks
archived `feature-graph-progress.json` files across multiple runs to
compute mean per-feature wall-clock + 95% confidence band. Needs ≥3
historical runs to be useful; currently no archive walker.

## See also

- `/quota-status` — live SDK rate-limit bucket probe (cross-link from
  the spend section).
- `feat-024-orchestrator-pause-resume` — the pause/resume mechanism
  this skill observes.
- `feat-030-quota-observability` — the rate-limit-events ledger this
  shares state directories with.
- `feat-031-prompt-cache-systemprompt` — wires the cache-hit ratio
  this skill surfaces.
