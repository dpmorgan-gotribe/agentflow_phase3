import type { BudgetCaps } from "./model-config.js";

/**
 * Thrown when a projected cost would push cumulative spend past the
 * pipeline-wide cap. Orchestrator catches this at stage boundaries to
 * checkpoint context before aborting.
 */
export class BudgetExceededError extends Error {
  readonly cumulative: number;
  readonly projected: number;
  readonly cap: number;

  constructor(cumulative: number, projected: number, cap: number) {
    super(
      `Budget exceeded: cumulative ${cumulative.toFixed(4)} USD + projected ` +
        `${projected.toFixed(4)} USD = ${(cumulative + projected).toFixed(4)} USD ` +
        `> cap ${cap.toFixed(2)} USD (perPipelineMaxUsd).`,
    );
    this.name = "BudgetExceededError";
    this.cumulative = cumulative;
    this.projected = projected;
    this.cap = cap;
  }
}

/**
 * feat-030 Phase D — per-model token + cost accumulator. Mirrors the
 * SDK's `ModelUsage` shape (sdk.d.ts:1050) so the orchestrator can
 * surface "Sonnet ate 86% of this run's spend" without summing token
 * fields by hand. All fields are non-negative cumulative counters.
 */
export interface ModelBreakdown {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Pipeline-wide cost accumulator. Reads `perPipelineMaxUsd` from the
 * merged model config at construction; callers `assertUnderBudget()`
 * before firing a `query()` and `record()` after the call returns.
 *
 * Per-stage caps (`perStageMaxUsd`) are enforced by the stage-runner
 * separately — BudgetTracker holds the caps map but doesn't apply it
 * here. Single responsibility: cumulative pipeline spend.
 */
export class BudgetTracker {
  private cumulativeUsd = 0;
  private modelBreakdown: Record<string, ModelBreakdown> = {};
  private readonly caps: BudgetCaps;

  constructor(caps: BudgetCaps) {
    this.caps = caps;
  }

  /** Current cumulative spend in USD. */
  getCumulative(): number {
    return this.cumulativeUsd;
  }

  /** Pipeline-wide cap (read-only). */
  getPipelineCap(): number {
    return this.caps.perPipelineMaxUsd;
  }

  /** Per-stage cap for the given stage, or `undefined` if not configured. */
  getStageCap(stageName: string): number | undefined {
    return this.caps.perStageMaxUsd[stageName];
  }

  /**
   * Check whether the pipeline budget has already been exhausted. Returns
   * true when cumulative spend has reached (or exceeded) the cap.
   */
  exhausted(): boolean {
    return this.cumulativeUsd >= this.caps.perPipelineMaxUsd;
  }

  /**
   * Throw `BudgetExceededError` if adding `projectedUsd` would push
   * cumulative past `perPipelineMaxUsd`. Call this before firing a
   * `query()` when the stage has a cost estimate.
   */
  assertUnderBudget(projectedUsd: number): void {
    if (projectedUsd < 0) {
      throw new RangeError(
        `assertUnderBudget: projectedUsd must be ≥ 0, got ${projectedUsd}`,
      );
    }
    if (this.cumulativeUsd + projectedUsd > this.caps.perPipelineMaxUsd) {
      throw new BudgetExceededError(
        this.cumulativeUsd,
        projectedUsd,
        this.caps.perPipelineMaxUsd,
      );
    }
  }

  /**
   * Record actual cost of a completed `query()`. Negative values are
   * rejected; zero is allowed (dry-runs / cached responses).
   */
  record(costUsd: number): void {
    if (costUsd < 0) {
      throw new RangeError(`record: costUsd must be ≥ 0, got ${costUsd}`);
    }
    this.cumulativeUsd += costUsd;
  }

  /**
   * feat-030 Phase D — accumulate per-model token + cost from the SDK's
   * `result.modelUsage` map. Called once per `runLlmAgent` after the
   * terminal `result` message. Idempotent for the same call (caller
   * passes the cumulative ModelUsage from the SDK; we add the delta
   * implicitly because the SDK reports per-call totals, not running
   * totals — so the `modelUsage` we receive IS the delta from this
   * call).
   *
   * `modelUsage` is the shape from
   * `@anthropic-ai/claude-agent-sdk::ModelUsage` (sdk.d.ts:1050) — but
   * we accept a wider record type to stay version-tolerant.
   */
  recordModelBreakdown(
    modelUsage: Record<
      string,
      {
        costUSD?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      }
    >,
  ): void {
    for (const [model, usage] of Object.entries(modelUsage ?? {})) {
      const existing = this.modelBreakdown[model] ?? {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      this.modelBreakdown[model] = {
        costUsd: existing.costUsd + (usage.costUSD ?? 0),
        inputTokens: existing.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: existing.outputTokens + (usage.outputTokens ?? 0),
        cacheReadInputTokens:
          existing.cacheReadInputTokens + (usage.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens:
          existing.cacheCreationInputTokens +
          (usage.cacheCreationInputTokens ?? 0),
      };
    }
  }

  /** Read-only view of the per-model breakdown. */
  getModelBreakdown(): Record<string, ModelBreakdown> {
    return { ...this.modelBreakdown };
  }

  /**
   * Serializable snapshot. Used by state-persistence (Phase 4) to survive
   * crashes. Cap values are static (come from YAML) — persistence only
   * needs cumulative + per-model breakdown (feat-030 Phase D).
   */
  toJSON(): {
    cumulativeUsd: number;
    modelBreakdown?: Record<string, ModelBreakdown>;
  } {
    const out: {
      cumulativeUsd: number;
      modelBreakdown?: Record<string, ModelBreakdown>;
    } = { cumulativeUsd: this.cumulativeUsd };
    if (Object.keys(this.modelBreakdown).length > 0) {
      out.modelBreakdown = this.modelBreakdown;
    }
    return out;
  }

  /** Restore cumulative from a persisted snapshot. */
  restoreCumulative(cumulativeUsd: number): void {
    if (cumulativeUsd < 0) {
      throw new RangeError(
        `restoreCumulative: cumulativeUsd must be ≥ 0, got ${cumulativeUsd}`,
      );
    }
    this.cumulativeUsd = cumulativeUsd;
  }

  /**
   * feat-030 Phase D — restore the per-model breakdown from a persisted
   * snapshot. Tolerant of absence (back-compat with pre-feat-030
   * counters.json files).
   */
  restoreModelBreakdown(
    modelBreakdown: Record<string, ModelBreakdown> | undefined,
  ): void {
    this.modelBreakdown = modelBreakdown ? { ...modelBreakdown } : {};
  }
}
