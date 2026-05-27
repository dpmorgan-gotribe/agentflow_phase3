import { describe, expect, it } from "vitest";
import { RetryCounters } from "../src/retry-counters.js";
import {
  processVisualReviewRetries,
  type VisualReviewOutput,
} from "../src/visual-review-retry.js";

function err(
  screen: string,
  rule = "contrast-4.5",
): VisualReviewOutput["violations"][number] {
  return { screen, severity: "error", rule, message: `fails ${rule}` };
}

describe("processVisualReviewRetries — happy path", () => {
  it("returns immediately when no errors", async () => {
    const rc = new RetryCounters();
    const initial: VisualReviewOutput = { violations: [] };
    const result = await processVisualReviewRetries(initial, {
      retryCounters: rc,
      regenerateScreen: async () => ({ success: true, costUsd: 0 }),
      rerunVisualReview: async () => ({
        output: { violations: [] },
        costUsd: 0,
      }),
    });
    expect(result.regeneratedScreens).toEqual([]);
    expect(result.needsHumanReview).toEqual([]);
    expect(result.iterations).toBe(1);
  });

  it("regenerates a failing screen and re-runs visual-review; cleans on retry", async () => {
    const rc = new RetryCounters();
    const regenerated: string[] = [];
    const result = await processVisualReviewRetries(
      { violations: [err("webapp/dashboard")] },
      {
        retryCounters: rc,
        regenerateScreen: async ({ screen }) => {
          regenerated.push(screen);
          return { success: true, costUsd: 0.2 };
        },
        rerunVisualReview: async () => ({
          output: { violations: [] },
          costUsd: 0.05,
        }),
      },
    );
    expect(result.regeneratedScreens).toEqual(["webapp/dashboard"]);
    expect(result.needsHumanReview).toEqual([]);
    expect(result.totalCostUsd).toBeCloseTo(0.25, 4);
    expect(rc.get("visual-review", "webapp/dashboard")).toBe(1);
  });

  it("de-dupes multiple errors on the same screen into one regen", async () => {
    const rc = new RetryCounters();
    const regenerated: string[] = [];
    const result = await processVisualReviewRetries(
      {
        violations: [
          err("webapp/dashboard", "contrast-4.5"),
          err("webapp/dashboard", "hit-target-44"),
          err("webapp/settings", "contrast-4.5"),
        ],
      },
      {
        retryCounters: rc,
        regenerateScreen: async ({ screen }) => {
          regenerated.push(screen);
          return { success: true, costUsd: 0.1 };
        },
        rerunVisualReview: async () => ({
          output: { violations: [] },
          costUsd: 0,
        }),
      },
    );
    expect(result.regeneratedScreens.sort()).toEqual([
      "webapp/dashboard",
      "webapp/settings",
    ]);
    expect(rc.get("visual-review", "webapp/dashboard")).toBe(1);
    expect(rc.get("visual-review", "webapp/settings")).toBe(1);
  });
});

describe("processVisualReviewRetries — cap behavior", () => {
  it("pushes screens exhausted via prior retries into needsHumanReview", async () => {
    const rc = new RetryCounters();
    // Simulate 3 prior attempts already
    rc.increment("visual-review", "webapp/dashboard");
    rc.increment("visual-review", "webapp/dashboard");
    rc.increment("visual-review", "webapp/dashboard");

    const regenerated: string[] = [];
    const result = await processVisualReviewRetries(
      { violations: [err("webapp/dashboard")] },
      {
        retryCounters: rc,
        regenerateScreen: async ({ screen }) => {
          regenerated.push(screen);
          return { success: true, costUsd: 0 };
        },
        rerunVisualReview: async () => ({
          output: { violations: [] },
          costUsd: 0,
        }),
      },
    );
    expect(result.needsHumanReview).toEqual(["webapp/dashboard"]);
    expect(result.regeneratedScreens).toEqual([]);
    expect(rc.get("visual-review", "webapp/dashboard")).toBe(3);
  });

  it("retries up to 3 times per screen; then adds to needsHumanReview", async () => {
    const rc = new RetryCounters();
    const regenCalls: string[] = [];
    let rerunCount = 0;

    const result = await processVisualReviewRetries(
      { violations: [err("webapp/dashboard")] },
      {
        retryCounters: rc,
        regenerateScreen: async ({ screen }) => {
          regenCalls.push(screen);
          return { success: true, costUsd: 0.1 };
        },
        rerunVisualReview: async () => {
          rerunCount += 1;
          // Always reports the same error → forces loop
          return {
            output: { violations: [err("webapp/dashboard")] },
            costUsd: 0.05,
          };
        },
      },
    );

    expect(regenCalls.length).toBe(3);
    expect(rerunCount).toBe(3);
    expect(result.needsHumanReview).toEqual(["webapp/dashboard"]);
    expect(rc.get("visual-review", "webapp/dashboard")).toBe(3);
  });

  it("handles mixed: some screens fixed, others exhausted", async () => {
    const rc = new RetryCounters();
    let iter = 0;
    const result = await processVisualReviewRetries(
      {
        violations: [err("webapp/a"), err("webapp/b")],
      },
      {
        retryCounters: rc,
        regenerateScreen: async () => ({ success: true, costUsd: 0.1 }),
        rerunVisualReview: async () => {
          iter += 1;
          // webapp/a keeps failing; webapp/b passes after first retry
          if (iter <= 3) {
            return {
              output: { violations: [err("webapp/a")] },
              costUsd: 0.05,
            };
          }
          return { output: { violations: [] }, costUsd: 0.05 };
        },
      },
    );

    expect(result.needsHumanReview).toEqual(["webapp/a"]);
    expect(rc.get("visual-review", "webapp/a")).toBe(3);
    expect(rc.get("visual-review", "webapp/b")).toBe(1);
  });
});

describe("processVisualReviewRetries — accounting", () => {
  it("preserves pre-existing needsHumanReview entries from initial output", async () => {
    const rc = new RetryCounters();
    const result = await processVisualReviewRetries(
      {
        violations: [],
        needsHumanReview: ["webapp/oldScreen"],
      },
      {
        retryCounters: rc,
        regenerateScreen: async () => ({ success: true, costUsd: 0 }),
        rerunVisualReview: async () => ({
          output: { violations: [] },
          costUsd: 0,
        }),
      },
    );
    expect(result.needsHumanReview).toEqual(["webapp/oldScreen"]);
    expect(result.finalOutput.needsHumanReview).toEqual(["webapp/oldScreen"]);
  });

  it("sums cost across regens + reruns", async () => {
    const rc = new RetryCounters();
    const result = await processVisualReviewRetries(
      { violations: [err("webapp/dashboard")] },
      {
        retryCounters: rc,
        regenerateScreen: async () => ({ success: true, costUsd: 0.5 }),
        rerunVisualReview: async () => ({
          output: { violations: [] },
          costUsd: 0.1,
        }),
      },
    );
    // 1 regen + 1 rerun = 0.50 + 0.10 = 0.60
    expect(result.totalCostUsd).toBeCloseTo(0.6, 4);
  });
});
