import type { RetryCounters } from "./retry-counters.js";

/**
 * Visual-review output shape (refactor-001). Each failure names the
 * screen that failed and the rule that produced the violation. Only
 * severity: "error" triggers regeneration — warnings + info feed into
 * the gate-4 human report.
 *
 * The `needsHumanReview[]` array is populated during the retry loop
 * with screens whose visual-review counter hit the Layer-5-independent
 * cap (3 per screen) before a clean pass. Gate 4 (sign-off) surfaces
 * these for manual decision.
 */
export interface VisualReviewViolation {
  screen: string; // "{platform}/{screen}"
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
}

export interface VisualReviewOutput {
  violations: readonly VisualReviewViolation[];
  needsHumanReview?: readonly string[];
}

export type RegenerateScreenFn = (args: {
  screen: string;
}) => Promise<{ success: boolean; costUsd: number; error?: string }>;

export type RerunVisualReviewFn = () => Promise<{
  output: VisualReviewOutput;
  costUsd: number;
}>;

export interface VisualReviewRetryContext {
  retryCounters: RetryCounters;
  regenerateScreen: RegenerateScreenFn;
  rerunVisualReview: RerunVisualReviewFn;
}

export interface VisualReviewRetryResult {
  finalOutput: VisualReviewOutput;
  totalCostUsd: number;
  regeneratedScreens: string[];
  needsHumanReview: string[];
  iterations: number;
}

/**
 * Processes a `/visual-review` output by regenerating each error-level
 * screen (max 3 per screen via retryCounters.tier="visual-review") and
 * re-running `/visual-review` after each batch. Loops until:
 *   - no error-severity violations remain, OR
 *   - every remaining error screen has exhausted its 3-per-screen cap
 *
 * Visual retries are INDEPENDENT of Layer 5 stage retries. A screen can
 * theoretically consume 3 Layer 5 retries on /screens generating it
 * PLUS 3 visual retries on /visual-review rejecting it — 6 total in the
 * extreme case. Screens that exhaust visual retries land in
 * `needsHumanReview[]` and surface at gate 4.
 */
export async function processVisualReviewRetries(
  initialOutput: VisualReviewOutput,
  ctx: VisualReviewRetryContext,
): Promise<VisualReviewRetryResult> {
  let output = initialOutput;
  let totalCostUsd = 0;
  const regeneratedScreens: string[] = [];
  const needsHumanReview = new Set<string>(
    initialOutput.needsHumanReview ?? [],
  );
  let iterations = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    iterations += 1;
    const errors = output.violations.filter((v) => v.severity === "error");
    if (errors.length === 0) break;

    // Distinct screens still eligible for regeneration
    const eligible = new Set<string>();
    for (const err of errors) {
      if (ctx.retryCounters.isExhausted("visual-review", err.screen)) {
        needsHumanReview.add(err.screen);
        continue;
      }
      eligible.add(err.screen);
    }
    if (eligible.size === 0) break;

    for (const screen of eligible) {
      ctx.retryCounters.increment("visual-review", screen);
      const regen = await ctx.regenerateScreen({ screen });
      totalCostUsd += regen.costUsd;
      regeneratedScreens.push(screen);
    }

    const rerun = await ctx.rerunVisualReview();
    totalCostUsd += rerun.costUsd;
    output = rerun.output;
  }

  return {
    finalOutput: {
      ...output,
      needsHumanReview: [...needsHumanReview],
    },
    totalCostUsd,
    regeneratedScreens,
    needsHumanReview: [...needsHumanReview],
    iterations,
  };
}
