// orchestrator/tests/cost-projection.test.ts
// phase0-step-055 — POST-MVP adopt: cost-projection-preview unit tests.
import { describe, it, expect } from "vitest";
import {
  forecast,
  classifyForecast,
  PRICING,
} from "../src/cost-projection.js";

describe("cost-projection.forecast — math", () => {
  it("worst case (no cache hit) sonnet 10K in, 2K out", () => {
    const r = forecast({ tier: "sonnet", inputTokens: 10_000, expectedOutputTokens: 2_000 });
    // 10K × $3.75/M (5m cache-write) + 2K × $15/M = $0.0375 + $0.030 = $0.0675
    expect(r.costUsd).toBeCloseTo(0.0675, 4);
    expect(r.cacheHitRatio).toBe(0);
    expect(r.cacheTtl).toBe("5m");
  });

  it("85% cache hit, 1h TTL — Mode B steady-state cost drop", () => {
    const r = forecast({
      tier: "sonnet",
      inputTokens: 10_000,
      expectedOutputTokens: 2_000,
      cacheHitRatio: 0.85,
      cacheTtl: "1h",
    });
    // cached:  8.5K × $0.30/M = $0.00255
    // written: 1.5K × $6.00/M = $0.009
    // output:  2K   × $15/M   = $0.030
    // total = $0.04155
    expect(r.costUsd).toBeCloseTo(0.04155, 4);
  });

  it("Haiku 4.5 is ~3× cheaper than Sonnet for the same dispatch", () => {
    const s = forecast({ tier: "sonnet", inputTokens: 10_000, expectedOutputTokens: 2_000 });
    const h = forecast({ tier: "haiku", inputTokens: 10_000, expectedOutputTokens: 2_000 });
    expect(s.costUsd / h.costUsd).toBeGreaterThan(2.5);
    expect(s.costUsd / h.costUsd).toBeLessThan(3.5);
  });

  it("Opus 4.7 is ~1.67× more expensive than Sonnet (per RESEARCH §F)", () => {
    const s = forecast({ tier: "sonnet", inputTokens: 10_000, expectedOutputTokens: 2_000 });
    const o = forecast({ tier: "opus", inputTokens: 10_000, expectedOutputTokens: 2_000 });
    expect(o.costUsd / s.costUsd).toBeGreaterThan(1.5);
    expect(o.costUsd / s.costUsd).toBeLessThan(2.0);
  });

  it("alternatives breakdown includes all 3 tiers", () => {
    const r = forecast({ tier: "sonnet", inputTokens: 1000, expectedOutputTokens: 100 });
    expect(r.alternatives.haiku).toBeGreaterThan(0);
    expect(r.alternatives.sonnet).toBeGreaterThan(0);
    expect(r.alternatives.opus).toBeGreaterThan(0);
    expect(r.alternatives.haiku).toBeLessThan(r.alternatives.sonnet);
    expect(r.alternatives.sonnet).toBeLessThan(r.alternatives.opus);
  });
});

describe("cost-projection.classifyForecast", () => {
  it("under 50% → ok", () => {
    expect(classifyForecast({ forecastUsd: 0.49, perStageCapUsd: 1.0 })).toBe("ok");
  });
  it("at 50% → warn", () => {
    expect(classifyForecast({ forecastUsd: 0.50, perStageCapUsd: 1.0 })).toBe("warn");
  });
  it("above 50%, below 100% → warn", () => {
    expect(classifyForecast({ forecastUsd: 0.99, perStageCapUsd: 1.0 })).toBe("warn");
  });
  it("at cap → throw", () => {
    expect(classifyForecast({ forecastUsd: 1.0, perStageCapUsd: 1.0 })).toBe("throw");
  });
  it("over cap → throw", () => {
    expect(classifyForecast({ forecastUsd: 1.5, perStageCapUsd: 1.0 })).toBe("throw");
  });
});

describe("cost-projection.PRICING — May 2026 baseline assertions", () => {
  it("Haiku 4.5: $1/$5 per MTok input/output", () => {
    expect(PRICING.haiku.inputPerM).toBe(1.0);
    expect(PRICING.haiku.outputPerM).toBe(5.0);
  });
  it("Sonnet 4.6: $3/$15 per MTok input/output", () => {
    expect(PRICING.sonnet.inputPerM).toBe(3.0);
    expect(PRICING.sonnet.outputPerM).toBe(15.0);
  });
  it("Opus 4.7: $5/$25 per MTok input/output", () => {
    expect(PRICING.opus.inputPerM).toBe(5.0);
    expect(PRICING.opus.outputPerM).toBe(25.0);
  });
  it("cache read = 10% of base input price per tier", () => {
    for (const t of ["haiku", "sonnet", "opus"] as const) {
      expect(PRICING[t].cacheReadPerM).toBeCloseTo(PRICING[t].inputPerM * 0.1, 6);
    }
  });
  it("cache write 5m = 1.25× base input price; 1h = 2× base", () => {
    for (const t of ["haiku", "sonnet", "opus"] as const) {
      expect(PRICING[t].cacheWrite5mPerM).toBeCloseTo(PRICING[t].inputPerM * 1.25, 6);
      expect(PRICING[t].cacheWrite1hPerM).toBeCloseTo(PRICING[t].inputPerM * 2.0, 6);
    }
  });
});
