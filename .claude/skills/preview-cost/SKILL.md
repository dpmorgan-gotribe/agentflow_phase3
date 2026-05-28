---
name: preview-cost
description: Pre-dispatch cost forecast for a planned agent invocation. Given a tier + input-token estimate + expected-output estimate, returns USD cost at the chosen tier plus per-tier alternatives. Useful for sizing per-stage caps + deciding routing (Haiku vs Sonnet vs Opus) before paying.
when_to_use: before a planned costly dispatch (mockups $5-10, systemic-fixer $1-4, perceptual+walkthrough at scale); when sizing per-stage cap for a new feature; when picking the right tier for an agent
argument-hint: --tier=<haiku|sonnet|opus> --input-tokens=<N> --output-tokens=<N> [--cache-hit-ratio=0..1] [--cache-ttl=5m|1h]
allowed-tools: Read, Bash
---

# /preview-cost — Forecast a dispatch before paying

## Steps

### 1. Parse arguments

- `--tier=<haiku|sonnet|opus>` (required)
- `--input-tokens=<N>` (required) — approx total of system+tools+user-message+tool-results bytes / 4
- `--output-tokens=<N>` (required) — expected response length
- `--cache-hit-ratio=<0..1>` (optional, default 0) — fraction of input tokens expected to hit cache. 0 = cold prefix; 0.85 = warm Mode B run
- `--cache-ttl=<5m|1h>` (optional, default 5m) — TTL for cache writes. 1h is the default Mode B setting (per ADR-001).

### 2. Invoke the forecast

```bash
node -e '
  import("./orchestrator/src/cost-projection.js").then(({ forecast }) => {
    const r = forecast({
      tier: "<tier>",
      inputTokens: <N>,
      expectedOutputTokens: <N>,
      cacheHitRatio: <0..1>,
      cacheTtl: "<5m|1h>"
    });
    console.log(JSON.stringify(r, null, 2));
  });
'
```

### 3. Emit the report

Format:

```
Forecast for {tier} dispatch:
  Input:  {inputTokens} tokens
  Output: {expectedOutputTokens} tokens
  Cache:  hit-ratio={cacheHitRatio}, TTL={cacheTtl}

Cost at {tier}: ${costUsd.toFixed(4)}
  - cache read:  ${breakdown.cacheReadUsd.toFixed(4)}
  - cache write: ${breakdown.cacheWriteUsd.toFixed(4)}
  - output:      ${breakdown.outputUsd.toFixed(4)}

Alternative tiers (same dispatch):
  - haiku:  ${alternatives.haiku.toFixed(4)}   ({ratio_vs_chosen}× of chosen)
  - sonnet: ${alternatives.sonnet.toFixed(4)}  ({ratio_vs_chosen}×)
  - opus:   ${alternatives.opus.toFixed(4)}    ({ratio_vs_chosen}×)
```

### 4. Recommendation

Based on the alternatives:

- If chosen tier is opus AND haiku cost ≤ 10% of opus → suggest "consider routing to haiku for this dispatch"
- If chosen tier is sonnet AND cacheHitRatio < 0.5 → suggest "warm the cache prefix before this dispatch (see ADR-001)"
- Otherwise: "Routing OK."

## What this skill does NOT do

- Doesn't dispatch any agent. Pure projection.
- Doesn't update budget caps. It reports; operator decides cap changes via .claude/models.yaml.
- Doesn't account for tool-result tokens beyond what's in --input-tokens. For accurate Mode B turn-N forecasts, include the conversation-history token count.

## Cross-references

- `orchestrator/src/cost-projection.ts` — the pure-function projection module.
- `orchestrator/src/budget-tracker.ts` — runtime spend recorder + per-pipeline cap enforcer.
- `DECISIONS.md` ADR-001 — caching commitment that makes cacheHitRatio ≥ 0.85 realistic in Mode B.
- `RESEARCH.md` §F + §3 — pricing baseline + Haiku-routing rationale.
