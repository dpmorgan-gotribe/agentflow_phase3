---
name: quota-status
description: Probe the Claude Agent SDK for live rate-limit bucket utilization on the active auth provider. Reports all 5 rateLimitType buckets (five_hour, seven_day, seven_day_opus, seven_day_sonnet, overage) with utilization%, status, resetsAt, plus overage-tier state. Operator-facing pre-flight check before /start-build; structured `--json` output for orchestrator integration. Closes the visibility gap from investigate-010 §F1 — the SDK exposes 8 fields on SDKRateLimitInfo and the orchestrator was reading 2.
when_to_use: before /start-build to confirm there's enough bucket headroom for a Mode B run; after a paused.json shows claude-max-five-hour-limit to see actual fullness vs. resetsAt; when the claude.ai dashboard shows low usage but the orchestrator is hitting rate limits (the dashboard meters a different bucket than the SDK enforces); periodically during a long Mode B run to catch a 'allowed_warning' event the orchestrator's pause-hook gate doesn't surface in v1
argument-hint: [--json] [--verbose] [--model <id> | --all]
allowed-tools: Read Bash
---

# /quota-status — Live SDK rate-limit bucket probe

Calls the Claude Agent SDK with a 1-token Haiku prompt, captures every
`SDKRateLimitEvent` from the response stream, and prints the
`rate_limit_info` payload — the structured 8-field breakdown the
orchestrator silently consumes for pause decisions. Operators can see
bucket fullness BEFORE dispatching a Mode B run instead of finding out
on the first failed dispatch.

## Arguments

- `--json` — emit a `QuotaStatusReport` JSON document (schema:
  `packages/orchestrator-contracts/src/quota-status.ts`). Default is
  human-readable plain text. With `--all`, emits a JSON array of
  reports (one per probed model).
- `--verbose` — also dump the raw SDK event stream (debugging).
- `--model <id>` — probe a specific model class instead of the default
  Haiku. Use to surface Sonnet/Opus weekly buckets (`seven_day_sonnet`,
  `seven_day_opus`) that a Haiku probe doesn't touch. Mutually
  exclusive with `--all`.
- `--all` — probe Haiku, Sonnet, AND Opus sequentially. Cumulative cost
  ~$0.018 (negligible against any Mode B run). Mutually exclusive with
  `--model`.

## Why model class matters

The SDK only emits `rate_limit_event` for buckets the **probed model**
exercises (per `sdk.d.ts:2926`):

| Probed model | Buckets reported                                                       |
| ------------ | ---------------------------------------------------------------------- |
| Haiku        | `five_hour` (aggregate) only — Haiku has no separate weekly cap on Max |
| Sonnet       | `five_hour` + `seven_day_sonnet`                                       |
| Opus         | `five_hour` + `seven_day_opus`                                         |

A Haiku-only probe can show `[OK]` even when `seven_day_sonnet` is
saturated and would reject the next Sonnet builder dispatch. Run
`--all` (or `--model claude-sonnet-4-6` / `--model claude-opus-4-7`)
before a Mode B run to see the actual bucket(s) the orchestrator will
hit.

## Steps

### 1. Pre-flight

Confirm CWD looks like the factory: `.claude/agents/` and
`brief-template.md` must both exist at CWD. If not, the probe still
works (it doesn't read project files) but warn the operator that
they're outside the factory and the report won't reference any project.

### 2. Run the probe

```
# Default — Haiku-only, plain-text
pnpm --filter orchestrator probe-quota

# Sonnet probe (surfaces seven_day_sonnet pressure)
pnpm --filter orchestrator probe-quota -- --model claude-sonnet-4-6

# Opus probe (surfaces seven_day_opus pressure)
pnpm --filter orchestrator probe-quota -- --model claude-opus-4-7

# All three sequentially — recommended pre-flight before Mode B
pnpm --filter orchestrator probe-quota -- --all

# Structured JSON for orchestrator integration
pnpm --filter orchestrator probe-quota -- --all --json
```

The script:

1. Imports `@anthropic-ai/claude-agent-sdk`
2. Calls `query()` with `model: claude-haiku-4-5`, `maxTurns: 1`,
   `systemPrompt: "Reply with the single word OK and stop."`,
   `allowedTools: []`
3. Iterates the response stream, accumulating `rate_limit_event`
   messages by `rateLimitType` (overwriting older events of the same
   type so the latest snapshot wins)
4. Captures overage-tier metadata (`isUsingOverage`,
   `overageStatus`, `overageResetsAt`, `overageDisabledReason`)
   alongside the buckets
5. Prints the formatted report and exits

### 3. Read the report

Plain-text shape:

```
Provider: claude-max-subscription
Model:    claude-haiku-4-5
Probed:   2026-04-28T23:50:00.000Z
Probe:    succeeded

Buckets:
  STATUS    TYPE                   USED  STATE             RESETS
  [OK]      five_hour               12%  allowed           2026-04-29T01:20Z (~1.5h)
  [WARN]    seven_day_sonnet        78%  allowed_warning   2026-05-04T00:00Z (~5d)
  [OK]      seven_day_opus           4%  allowed           2026-05-04T00:00Z (~5d)

Overage:  status=allowed  using=false  resets=2026-05-04T00:00Z (~5d)
```

Status indicators:

- `[OK]` — `status === 'allowed'`. Bucket has headroom.
- `[WARN]` — `status === 'allowed_warning'`. ~15-30 min before the SDK
  starts rejecting; finish in-flight work or pause now.
- `[REJECT]` — `status === 'rejected'`. Bucket is full. Wait for
  reset, switch provider, or use overage tier if available.

### 4. Decide

Operator decision tree before `/start-build`:

| All buckets `[OK]` and `< 70%` | Safe to dispatch a fresh Mode B run. |
| Any bucket `[WARN]` | Risky. A run may complete partially; expect a pause mid-way. Consider waiting until reset, or set `provider: anthropic-api-key` for this run. |
| Any bucket `[REJECT]` | Refuse to dispatch. Wait for `resetsAt`, switch provider, or check `overageStatus` — if `allowed`, the overage tier may auto-route the next call. |

If `--json` mode, downstream tools (start-build, future watchdog) can
parse `QuotaStatusReport` per the Zod schema and gate dispatches
programmatically.

### 5. Edge cases

- **Provider is `anthropic-api-key`**: SDK does not emit
  `rate_limit_event` (no Max-tier bucket). `buckets: []` in the
  report — that's expected, not an error.
- **Network failure**: probe exits 3 with `probeError` populated.
  Operator runs again or investigates connectivity before
  `/start-build`.
- **Probe itself rejected** (5h bucket already at 100%): exit 2,
  `probeSucceeded: false`. The `rate_limit_event` should still fire
  BEFORE the rejection error, so `buckets` will populate. If it
  doesn't, the operator knows the bucket is full but loses the
  resetsAt detail (manually check `paused.json` if one exists).

## Cost per probe

| Model   | Approx. cost | Buckets surfaced                |
| ------- | ------------ | ------------------------------- |
| Haiku   | ~$0.0001     | `five_hour`                     |
| Sonnet  | ~$0.003      | `five_hour`, `seven_day_sonnet` |
| Opus    | ~$0.015      | `five_hour`, `seven_day_opus`   |
| `--all` | ~$0.018      | All of the above                |

All negligible against a Mode B run ($5-50). Safe to invoke before
every `/start-build`.

## See also

- `investigate-010` (the parent investigation that motivated this skill)
- `feat-030` (the implementation plan; this skill is Phase A)
- `packages/orchestrator-contracts/src/quota-status.ts` (the JSON schema)
- `node_modules/.../@anthropic-ai/claude-agent-sdk/sdk.d.ts:2923` (the
  upstream `SDKRateLimitInfo` typedef this skill mirrors)
