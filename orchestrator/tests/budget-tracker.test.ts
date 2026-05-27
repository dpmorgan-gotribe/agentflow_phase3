import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetTracker } from "../src/budget-tracker.js";

const defaultCaps = {
  perPipelineMaxUsd: 100,
  perStageMaxUsd: { analyze: 3, mockups: 10 },
};

describe("BudgetTracker — cumulative math", () => {
  it("starts at 0", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(t.getCumulative()).toBe(0);
  });

  it("sums recorded costs", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(1.5);
    t.record(2.25);
    t.record(0.3);
    expect(t.getCumulative()).toBeCloseTo(4.05, 4);
  });

  it("accepts zero-cost records (cached / dry-run)", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(0);
    expect(t.getCumulative()).toBe(0);
  });

  it("rejects negative cost", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(() => t.record(-0.01)).toThrow(RangeError);
  });
});

describe("BudgetTracker — cap lookups", () => {
  it("exposes perPipelineMaxUsd", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(t.getPipelineCap()).toBe(100);
  });

  it("returns per-stage cap when configured", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(t.getStageCap("analyze")).toBe(3);
    expect(t.getStageCap("mockups")).toBe(10);
  });

  it("returns undefined for unconfigured stage", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(t.getStageCap("no-such-stage")).toBeUndefined();
  });
});

describe("BudgetTracker — assertUnderBudget", () => {
  it("passes when projected + cumulative ≤ cap", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(40);
    expect(() => t.assertUnderBudget(60)).not.toThrow(); // exactly at cap
  });

  it("throws BudgetExceededError when projected + cumulative > cap", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(40);
    expect(() => t.assertUnderBudget(60.01)).toThrow(BudgetExceededError);
  });

  it("error carries cumulative + projected + cap fields", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(95);
    try {
      t.assertUnderBudget(10);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const e = err as BudgetExceededError;
      expect(e.cumulative).toBe(95);
      expect(e.projected).toBe(10);
      expect(e.cap).toBe(100);
    }
  });

  it("rejects negative projected", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(() => t.assertUnderBudget(-1)).toThrow(RangeError);
  });
});

describe("BudgetTracker — exhausted()", () => {
  it("returns false while under cap", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(99.99);
    expect(t.exhausted()).toBe(false);
  });

  it("returns true when cumulative reaches cap exactly", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(100);
    expect(t.exhausted()).toBe(true);
  });

  it("returns true when cumulative exceeds cap (after record past the line)", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(100.01);
    expect(t.exhausted()).toBe(true);
  });
});

describe("BudgetTracker — persistence round-trip", () => {
  it("toJSON() returns only cumulative when no breakdown recorded", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(12.34);
    expect(t.toJSON()).toEqual({ cumulativeUsd: 12.34 });
  });

  it("restoreCumulative() replaces cumulative for crash-recovery", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(5);
    t.restoreCumulative(42);
    expect(t.getCumulative()).toBe(42);
  });

  it("restoreCumulative rejects negative", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(() => t.restoreCumulative(-1)).toThrow(RangeError);
  });
});

// feat-030 Phase D — per-model breakdown
describe("BudgetTracker — modelBreakdown (feat-030 Phase D)", () => {
  it("starts empty and toJSON omits the field when empty", () => {
    const t = new BudgetTracker(defaultCaps);
    expect(t.getModelBreakdown()).toEqual({});
    expect(t.toJSON()).toEqual({ cumulativeUsd: 0 });
  });

  it("accumulates per-model token + cost across multiple recordModelBreakdown calls", () => {
    const t = new BudgetTracker(defaultCaps);
    t.recordModelBreakdown({
      "claude-sonnet-4-6": {
        costUSD: 0.42,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
      },
    });
    t.recordModelBreakdown({
      "claude-sonnet-4-6": {
        costUSD: 0.18,
        inputTokens: 400,
        outputTokens: 80,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 0,
      },
      "claude-haiku-4-5": {
        costUSD: 0.01,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    const bd = t.getModelBreakdown();
    expect(bd["claude-sonnet-4-6"]).toEqual({
      costUsd: 0.6,
      inputTokens: 1400,
      outputTokens: 280,
      cacheReadInputTokens: 700,
      cacheCreationInputTokens: 100,
    });
    expect(bd["claude-haiku-4-5"]).toEqual({
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("tolerates partial ModelUsage shapes (missing fields default to 0)", () => {
    const t = new BudgetTracker(defaultCaps);
    t.recordModelBreakdown({ "claude-sonnet-4-6": { costUSD: 0.1 } });
    expect(t.getModelBreakdown()["claude-sonnet-4-6"]).toEqual({
      costUsd: 0.1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("toJSON includes modelBreakdown when populated", () => {
    const t = new BudgetTracker(defaultCaps);
    t.record(0.5);
    t.recordModelBreakdown({
      "claude-haiku-4-5": {
        costUSD: 0.5,
        inputTokens: 500,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    const json = t.toJSON();
    expect(json.cumulativeUsd).toBe(0.5);
    expect(json.modelBreakdown).toBeDefined();
    expect(json.modelBreakdown?.["claude-haiku-4-5"]?.costUsd).toBe(0.5);
  });

  it("restoreModelBreakdown round-trips through toJSON", () => {
    const t1 = new BudgetTracker(defaultCaps);
    t1.recordModelBreakdown({
      "claude-opus-4-7": {
        costUSD: 1.23,
        inputTokens: 5000,
        outputTokens: 1200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 800,
      },
    });
    const snap = t1.toJSON();

    const t2 = new BudgetTracker(defaultCaps);
    t2.restoreModelBreakdown(snap.modelBreakdown);
    expect(t2.getModelBreakdown()).toEqual(snap.modelBreakdown);
  });

  it("restoreModelBreakdown(undefined) clears (back-compat with pre-feat-030 files)", () => {
    const t = new BudgetTracker(defaultCaps);
    t.recordModelBreakdown({ "claude-sonnet-4-6": { costUSD: 0.5 } });
    t.restoreModelBreakdown(undefined);
    expect(t.getModelBreakdown()).toEqual({});
  });
});
