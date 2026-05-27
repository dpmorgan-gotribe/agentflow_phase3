import type { RetryCounters } from "./retry-counters.js";

/**
 * A kit-change-request is emitted when a stage (design-phase `/screens`
 * or a post-signoff feature builder) needs a primitive / pattern /
 * layout that doesn't exist in `@repo/ui-kit`. The request file lives
 * at `docs/screens/kit-change-requests/{id}.md` and describes what's
 * needed + why.
 *
 * Detour flow per refactor-001 + refactor-003 dual-mode PM:
 *   1. Halt the emitting stage
 *   2. Invoke PM in `--mode=kit-change-request` — writes a mini-plan
 *   3. Re-run `/stylesheet` (bumps kit minor version)
 *   4a. If design-phase: resume /screens → /visual-review → /user-flows
 *   4b. If post-signoff: red-flag, revert to /screens + /visual-review,
 *       re-open gate 4 (signoff invalidated by kit version drift), AND
 *       re-run /architect if the kit change altered vendor decisions
 *       (gate 5 re-opens only when architect produces non-empty
 *       credentials-diff.md)
 *
 * Counter: `retryCounters.tier="kit-change-request"` with key
 * "pipeline" — max 2 detours per pipeline run (refactor-001 ceiling).
 * On exhaust the orchestrator escalates to human review.
 */

export interface KitChangeRequest {
  requestFile: string;
  requestedComponent: string;
  requestingAgent: string;
  screenId?: string;
}

export type KitChangeRequestPhase = "design" | "post-signoff";

export type InvokePMKitChangeRequestFn = (args: {
  request: KitChangeRequest;
}) => Promise<{ success: boolean; miniPlanPath: string; costUsd: number }>;

export type RerunStylesheetFn = (args: { miniPlanPath: string }) => Promise<{
  success: boolean;
  costUsd: number;
  newKitVersion?: string;
}>;

export type RerunArchitectFn = () => Promise<{
  success: boolean;
  costUsd: number;
  credentialsDiffPath?: string;
  credentialsChanged: boolean;
}>;

export interface KitChangeRequestDetourContext {
  retryCounters: RetryCounters;
  invokePMKitChangeRequest: InvokePMKitChangeRequestFn;
  rerunStylesheet: RerunStylesheetFn;
  rerunArchitect?: RerunArchitectFn;
}

export interface KitChangeRequestDetourResult {
  success: boolean;
  escalatedToHuman: boolean;
  detoursConsumed: number;
  newKitVersion?: string;
  reopenedGates: Array<"signoff" | "credentials">;
  totalCostUsd: number;
  reason?: string;
}

const COUNTER_KEY = "pipeline";

/**
 * Run one kit-change-request detour. Mutates the retry counter + returns
 * the post-detour state. Caller (`runPipeline` or `runFeatureGraph`) is
 * responsible for resuming the emitting stage with the new kit version
 * once this returns.
 *
 * When the detour cap (2) is hit, returns `escalatedToHuman: true` WITHOUT
 * running PM / stylesheet — orchestrator aborts the pipeline at that
 * point and surfaces for human review.
 */
export async function runKitChangeRequestDetour(
  request: KitChangeRequest,
  phase: KitChangeRequestPhase,
  ctx: KitChangeRequestDetourContext,
): Promise<KitChangeRequestDetourResult> {
  const reopenedGates: Array<"signoff" | "credentials"> = [];
  let totalCostUsd = 0;

  if (ctx.retryCounters.isExhausted("kit-change-request", COUNTER_KEY)) {
    return {
      success: false,
      escalatedToHuman: true,
      detoursConsumed: ctx.retryCounters.get("kit-change-request", COUNTER_KEY),
      reopenedGates: [],
      totalCostUsd: 0,
      reason: "kit-change-request cap (2) exhausted; human review required",
    };
  }

  const detoursConsumed = ctx.retryCounters.increment(
    "kit-change-request",
    COUNTER_KEY,
  );

  // 1. PM writes the mini-plan
  const pm = await ctx.invokePMKitChangeRequest({ request });
  totalCostUsd += pm.costUsd;
  if (!pm.success) {
    return {
      success: false,
      escalatedToHuman: false,
      detoursConsumed,
      reopenedGates: [],
      totalCostUsd,
      reason: "PM kit-change-request failed",
    };
  }

  // 2. Stylesheet bumps the kit
  const stylesheet = await ctx.rerunStylesheet({
    miniPlanPath: pm.miniPlanPath,
  });
  totalCostUsd += stylesheet.costUsd;
  if (!stylesheet.success) {
    return {
      success: false,
      escalatedToHuman: false,
      detoursConsumed,
      reopenedGates: [],
      totalCostUsd,
      reason: "stylesheet rebuild failed",
    };
  }

  // 3. Gate handling
  if (phase === "post-signoff") {
    reopenedGates.push("signoff");

    if (ctx.rerunArchitect) {
      const arch = await ctx.rerunArchitect();
      totalCostUsd += arch.costUsd;
      if (arch.credentialsChanged) reopenedGates.push("credentials");
    }
  }

  const result: KitChangeRequestDetourResult = {
    success: true,
    escalatedToHuman: false,
    detoursConsumed,
    reopenedGates,
    totalCostUsd,
  };
  if (stylesheet.newKitVersion !== undefined) {
    result.newKitVersion = stylesheet.newKitVersion;
  }
  return result;
}
