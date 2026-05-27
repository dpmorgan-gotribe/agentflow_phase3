import { describe, expect, it } from "vitest";
import {
  runKitChangeRequestDetour,
  type KitChangeRequest,
  type KitChangeRequestDetourContext,
} from "../src/kit-change-request-detour.js";
import { RetryCounters } from "../src/retry-counters.js";

function baseRequest(): KitChangeRequest {
  return {
    requestFile: "docs/screens/kit-change-requests/wallet-balance.md",
    requestedComponent: "WalletBalance",
    requestingAgent: "/screens",
    screenId: "mobile/wallet",
  };
}

function baseCtx(
  overrides: Partial<KitChangeRequestDetourContext> = {},
): KitChangeRequestDetourContext {
  return {
    retryCounters: new RetryCounters(),
    invokePMKitChangeRequest: async () => ({
      success: true,
      miniPlanPath: "plans/active/kit-change-request-001.md",
      costUsd: 0.3,
    }),
    rerunStylesheet: async () => ({
      success: true,
      costUsd: 0.5,
      newKitVersion: "1.1.0",
    }),
    ...overrides,
  };
}

describe("runKitChangeRequestDetour — design phase", () => {
  it("runs PM + stylesheet on first detour without re-opening gates", async () => {
    const ctx = baseCtx();
    const result = await runKitChangeRequestDetour(
      baseRequest(),
      "design",
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.escalatedToHuman).toBe(false);
    expect(result.detoursConsumed).toBe(1);
    expect(result.newKitVersion).toBe("1.1.0");
    expect(result.reopenedGates).toEqual([]);
    expect(result.totalCostUsd).toBeCloseTo(0.8, 4);
    expect(ctx.retryCounters.get("kit-change-request", "pipeline")).toBe(1);
  });

  it("supports 2 detours back-to-back; caps on the 3rd", async () => {
    const ctx = baseCtx();
    const r1 = await runKitChangeRequestDetour(baseRequest(), "design", ctx);
    const r2 = await runKitChangeRequestDetour(baseRequest(), "design", ctx);
    const r3 = await runKitChangeRequestDetour(baseRequest(), "design", ctx);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(false);
    expect(r3.escalatedToHuman).toBe(true);
    expect(r3.reason).toContain("cap (2) exhausted");
    expect(ctx.retryCounters.get("kit-change-request", "pipeline")).toBe(2);
  });
});

describe("runKitChangeRequestDetour — post-signoff", () => {
  it("re-opens signoff gate; does NOT re-open credentials when architect says unchanged", async () => {
    const ctx = baseCtx({
      rerunArchitect: async () => ({
        success: true,
        costUsd: 0.4,
        credentialsChanged: false,
      }),
    });
    const result = await runKitChangeRequestDetour(
      baseRequest(),
      "post-signoff",
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.reopenedGates).toEqual(["signoff"]);
    expect(result.totalCostUsd).toBeCloseTo(1.2, 4);
  });

  it("re-opens BOTH signoff + credentials when architect reports credentials changed", async () => {
    const ctx = baseCtx({
      rerunArchitect: async () => ({
        success: true,
        costUsd: 0.4,
        credentialsDiffPath: "docs/credentials-diff.md",
        credentialsChanged: true,
      }),
    });
    const result = await runKitChangeRequestDetour(
      baseRequest(),
      "post-signoff",
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.reopenedGates.sort()).toEqual(["credentials", "signoff"]);
  });

  it("re-opens signoff even without architect runner wired", async () => {
    const ctx = baseCtx(); // no rerunArchitect
    const result = await runKitChangeRequestDetour(
      baseRequest(),
      "post-signoff",
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.reopenedGates).toEqual(["signoff"]);
  });
});

describe("runKitChangeRequestDetour — failure paths", () => {
  it("returns success:false when PM invocation fails", async () => {
    const ctx = baseCtx({
      invokePMKitChangeRequest: async () => ({
        success: false,
        miniPlanPath: "",
        costUsd: 0.1,
      }),
    });
    const result = await runKitChangeRequestDetour(
      baseRequest(),
      "design",
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.reason).toContain("PM kit-change-request failed");
    // Counter was incremented when detour started — a consumed detour even on PM fail
    expect(ctx.retryCounters.get("kit-change-request", "pipeline")).toBe(1);
  });

  it("returns success:false when stylesheet rebuild fails", async () => {
    const ctx = baseCtx({
      rerunStylesheet: async () => ({
        success: false,
        costUsd: 0.2,
      }),
    });
    const result = await runKitChangeRequestDetour(
      baseRequest(),
      "design",
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.reason).toContain("stylesheet rebuild failed");
  });

  it("does not invoke PM or stylesheet when cap is already at 2", async () => {
    const rc = new RetryCounters();
    rc.increment("kit-change-request", "pipeline");
    rc.increment("kit-change-request", "pipeline");
    let pmCalled = false;
    let styleCalled = false;
    const ctx = baseCtx({
      retryCounters: rc,
      invokePMKitChangeRequest: async () => {
        pmCalled = true;
        return { success: true, miniPlanPath: "p", costUsd: 0 };
      },
      rerunStylesheet: async () => {
        styleCalled = true;
        return { success: true, costUsd: 0 };
      },
    });
    const result = await runKitChangeRequestDetour(
      baseRequest(),
      "design",
      ctx,
    );
    expect(result.escalatedToHuman).toBe(true);
    expect(pmCalled).toBe(false);
    expect(styleCalled).toBe(false);
  });
});
