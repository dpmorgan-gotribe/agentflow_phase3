// orchestrator/src/cost-projection.ts
//
// phase0-step-055 (POST-MVP adopt: cost-projection-preview).
// Pre-dispatch cost forecasting. Given a planned agent + projected input
// tokens + expected output tokens, returns per-tier cost in USD. The
// orchestrator (invoke-agent) uses this to warn at 50% of per-stage cap
// and throw BudgetExceededError at 100%, before any actual SDK spend.
//
// Pricing baseline: May 2026 Anthropic public rates per
// platform.claude.com/docs/en/about-claude/pricing. Cache reads are
// 0.1× base input; cache writes are 1.25× (5m TTL) or 2× (1h TTL).
// `forecast()` assumes no cache hits (worst case); use
// `forecastWithCache()` when you have an expected cache-hit ratio.

export type Tier = "haiku" | "sonnet" | "opus";

export interface ModelPrice {
  /** USD per 1M input tokens (no cache). */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** USD per 1M cache-read input tokens (= 0.1 × inputPerM). */
  cacheReadPerM: number;
  /** USD per 1M cache-write input tokens at 5m TTL (= 1.25 × inputPerM). */
  cacheWrite5mPerM: number;
  /** USD per 1M cache-write input tokens at 1h TTL (= 2 × inputPerM). */
  cacheWrite1hPerM: number;
}

/** May 2026 Anthropic pricing (per MTok). Update when pricing changes. */
export const PRICING: Record<Tier, ModelPrice> = {
  haiku: {
    inputPerM: 1.0,
    outputPerM: 5.0,
    cacheReadPerM: 0.1,
    cacheWrite5mPerM: 1.25,
    cacheWrite1hPerM: 2.0,
  },
  sonnet: {
    inputPerM: 3.0,
    outputPerM: 15.0,
    cacheReadPerM: 0.3,
    cacheWrite5mPerM: 3.75,
    cacheWrite1hPerM: 6.0,
  },
  opus: {
    inputPerM: 5.0,
    outputPerM: 25.0,
    cacheReadPerM: 0.5,
    cacheWrite5mPerM: 6.25,
    cacheWrite1hPerM: 10.0,
  },
};

export interface ForecastInput {
  /** Tier the dispatch will use. */
  tier: Tier;
  /** Projected input tokens (system + tools + user message + tool results). */
  inputTokens: number;
  /** Expected output tokens for this dispatch. */
  expectedOutputTokens: number;
  /** Optional: fraction of input tokens expected to hit the cache (0..1). Default 0 (worst case). */
  cacheHitRatio?: number;
  /** Optional: cache-write TTL when a cache miss occurs ("5m" or "1h"). Default "5m". */
  cacheTtl?: "5m" | "1h";
}

export interface ForecastResult {
  tier: Tier;
  inputTokens: number;
  expectedOutputTokens: number;
  cacheHitRatio: number;
  cacheTtl: "5m" | "1h";
  /** Cost in USD at the requested tier. */
  costUsd: number;
  /** Per-tier breakdown — useful for "what if we routed to a cheaper tier?". */
  alternatives: Record<Tier, number>;
  /** Breakdown of where the cost came from. */
  breakdown: {
    inputUsd: number;
    cacheReadUsd: number;
    cacheWriteUsd: number;
    outputUsd: number;
  };
}

/**
 * Pure function. Project the cost of a single dispatch in USD.
 *
 * The math:
 *   cacheReadTokens   = inputTokens × cacheHitRatio
 *   cacheWriteTokens  = inputTokens × (1 - cacheHitRatio)      (worst case: full prefix write)
 *   uncachedInputCost = 0  (in caching-on world, all input flows through cache layer)
 *   cacheReadCost     = cacheReadTokens × cacheReadPerM / 1e6
 *   cacheWriteCost    = cacheWriteTokens × cacheWritePerM / 1e6
 *   outputCost        = expectedOutputTokens × outputPerM / 1e6
 *
 * When `cacheHitRatio = 0` (default), this is the worst-case "fresh
 * prefix every dispatch" estimate — useful for sizing per-stage caps.
 * When `cacheHitRatio = 0.85` (typical Mode B turns 2+ on warm cache),
 * the estimate drops ~6×.
 */
export function forecast(input: ForecastInput): ForecastResult {
  const cacheHitRatio = input.cacheHitRatio ?? 0;
  const cacheTtl = input.cacheTtl ?? "5m";
  const cachedTokens = input.inputTokens * cacheHitRatio;
  const uncachedTokens = input.inputTokens - cachedTokens;

  function costForTier(tier: Tier): { total: number; breakdown: ForecastResult["breakdown"] } {
    const p = PRICING[tier];
    const cacheWritePerM =
      cacheTtl === "1h" ? p.cacheWrite1hPerM : p.cacheWrite5mPerM;
    const cacheReadUsd = (cachedTokens * p.cacheReadPerM) / 1_000_000;
    const cacheWriteUsd = (uncachedTokens * cacheWritePerM) / 1_000_000;
    const outputUsd = (input.expectedOutputTokens * p.outputPerM) / 1_000_000;
    const inputUsd = 0; // all flows through cache layer; uncached cost lives in cache-write
    const total = inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd;
    return { total, breakdown: { inputUsd, cacheReadUsd, cacheWriteUsd, outputUsd } };
  }

  const requested = costForTier(input.tier);

  return {
    tier: input.tier,
    inputTokens: input.inputTokens,
    expectedOutputTokens: input.expectedOutputTokens,
    cacheHitRatio,
    cacheTtl,
    costUsd: requested.total,
    breakdown: requested.breakdown,
    alternatives: {
      haiku: costForTier("haiku").total,
      sonnet: costForTier("sonnet").total,
      opus: costForTier("opus").total,
    },
  };
}

/**
 * Convenience wrapper for the common "warn at 50% / throw at 100%" pattern.
 * Returns one of three verdicts. Caller decides how to surface each.
 */
export function classifyForecast(args: {
  forecastUsd: number;
  perStageCapUsd: number;
}): "ok" | "warn" | "throw" {
  if (args.forecastUsd >= args.perStageCapUsd) return "throw";
  if (args.forecastUsd >= args.perStageCapUsd * 0.5) return "warn";
  return "ok";
}
