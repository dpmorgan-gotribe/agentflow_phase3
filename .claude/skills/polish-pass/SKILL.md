---
name: polish-pass
description: Promote a row from passes:true to polished:true by verifying its perf/cost budget. Produces a benchmark evidence file and flips the polished flag. Invoked on demand by the human or by the executing agent when the budget can be plausibly met.
when_to_use: row is passes:true, the agent or user wants to verify it meets the perf/cost budget declared in phase-plan.md
argument-hint: [row-id]
allowed-tools: Read, Write, Bash, Skill
---

# /polish-pass — Flip polished after benchmark

## Steps

### 1. Get the row id

- Use `$ARGUMENTS` if provided; else ask which row to polish.
- Verify the row's `passes:true` (a `false` row can't be polished — refuse).

### 2. Find the budget

Read `phase-plan.md` for the phase's budget section. Budgets look like:

```
## Budgets
- Latency: API request handler p95 ≤ 200ms
- Cost: token spend per pipeline run ≤ $5.00
- Memory: container resident set ≤ 512 MB
```

Identify the budget that applies to this row. If multiple apply, choose the strictest. If none apply, refuse: "No budget in phase-plan.md applies to {row-id}. Either add a budget for this row's area, or set `polished:true` manually with a DECISIONS.md sign-off."

### 3. Find or create the benchmark script

- Convention: `benchmarks/{row-id}.{mjs,py,sh}`. The agent writes this if it doesn't exist.
- Bench scripts must produce a JSON file at `evidence/{row-id}-bench.json` with this shape:

```json
{
  "row_id": "{id}",
  "budget": { "metric": "p95_latency_ms", "limit": 200 },
  "result": { "metric": "p95_latency_ms", "value": 173 },
  "passes_budget": true,
  "samples": 100,
  "timestamp": "2026-05-11T14:32:00Z",
  "notes": "free-text — what was measured, under what conditions"
}
```

### 4. Run the benchmark

- Execute `benchmarks/{row-id}.*`.
- Inspect `evidence/{row-id}-bench.json`. Confirm `passes_budget: true`.

### 5. Read the evidence file (required for the gate)

- Read `evidence/{row-id}-bench.json` — this triggers `track-read.mjs` which logs the path to `.claude/state/evidence-reads.json`.
- Now `verify-gate.mjs` will allow the polished flip.

### 6. Sync the plan if the polish was architectural

If the polish involved more than a tuning constant — i.e. it introduced a **caching layer, batching, connection pooling, queue, parallelism, or any new pattern** — invoke `/sync-phase-plan {row-id}` BEFORE the polished flip. A new caching layer is durable behavior; future rebuilds need to know it exists.

If the polish was just tuning (changed a timeout from 5s to 8s, raised concurrency from 4 to 8), skip the sync — the polish is recorded in the bench evidence and the lesson, that's enough.

### 7. Edit the row

- Set `polished: true` in `feature_list.json` for this row id.
- `verify-gate.mjs` sees the flip; sees evidence is fresh; allows.

### 8. Capture the lesson

- Invoke `/capture-lesson` with the row id. Even routine polish passes are worth a one-paragraph lesson — what budget was used, what the actual number was, whether you had to optimize anything.

### 9. Report

```
Row {id} polished: true
Budget: {metric} ≤ {limit}
Result: {value} ({pct vs budget})
Evidence: evidence/{id}-bench.json
Plan synced: {yes — section §X.Y | no — tuning only}
Lesson captured: yes
```

## What this skill does NOT do

- Doesn't manually rewrite the row description or steps. Only the flag flips.
- Doesn't bypass the gate. If evidence is missing, the gate denies; the agent's job is to produce the evidence, not work around the hook.
- Doesn't polish multiple rows in one invocation. One row per call.

## Edge cases

- **Budget not met**: do NOT flip the flag. Capture a lesson and leave the row at `polished: false`. The phase-gate retro will surface it in Section 2.
- **Budget can never be met (architectural)**: file a `/plan-feature` for the architectural change, do not flip polished. The row stays `passes:true polished:false` until the new feature lands.
- **Benchmark script throws**: investigate (likely a real bug — capture a lesson, file a bug if needed). Do not flip polished.
