import { describe, expect, it } from "vitest";
import { PauseReason, PausedStateSchema } from "../src/paused-state.js";

describe("PauseReason — accepted enum values", () => {
  it("accepts all v1 trigger reasons", () => {
    for (const reason of [
      "user-request",
      "sigint",
      "claude-max-five-hour-limit",
      "claude-max-seven-day-limit",
      "auth-failed",
      "stall-timeout",
    ] as const) {
      expect(PauseReason.parse(reason)).toBe(reason);
    }
  });

  it("rejects unknown reasons", () => {
    expect(() => PauseReason.parse("network-down")).toThrow();
  });
});

describe("PausedStateSchema — happy paths", () => {
  it("parses a minimal user-request pause", () => {
    const out = PausedStateSchema.parse({
      version: "1.0",
      pausedAt: "2026-04-27T10:00:00.000Z",
      reason: "user-request",
      reasonDetail: "operator invoked /pause-build",
      authProvider: "claude-max-subscription",
      drainedInFlight: true,
      pipelineRunId: "pipe-001",
    });
    expect(out.reason).toBe("user-request");
    expect(out.resetsAt).toBeUndefined();
  });

  it("parses a Claude Max five-hour pause with resetsAt", () => {
    const out = PausedStateSchema.parse({
      version: "1.0",
      pausedAt: "2026-04-27T11:42:05.000Z",
      reason: "claude-max-five-hour-limit",
      reasonDetail: "SDKRateLimitEvent rateLimitType=five_hour",
      resetsAt: 1735689600,
      authProvider: "claude-max-subscription",
      drainedInFlight: true,
      pipelineRunId: "pipe-002",
    });
    expect(out.reason).toBe("claude-max-five-hour-limit");
    expect(out.resetsAt).toBe(1735689600);
  });

  it("parses a SIGINT pause with drainedInFlight=false (hard exit)", () => {
    const out = PausedStateSchema.parse({
      version: "1.0",
      pausedAt: "2026-04-27T11:42:05.000Z",
      reason: "sigint",
      reasonDetail: "second SIGINT within 5s",
      authProvider: "claude-max-subscription",
      drainedInFlight: false,
      pipelineRunId: "pipe-003",
    });
    expect(out.drainedInFlight).toBe(false);
  });
});

describe("PausedStateSchema — rejections", () => {
  it("rejects wrong version literal", () => {
    expect(() =>
      PausedStateSchema.parse({
        version: "0.9",
        pausedAt: "2026-04-27T10:00:00.000Z",
        reason: "sigint",
        reasonDetail: "x",
        authProvider: "x",
        drainedInFlight: true,
        pipelineRunId: "p",
      }),
    ).toThrow();
  });

  it("rejects malformed pausedAt (not ISO datetime)", () => {
    expect(() =>
      PausedStateSchema.parse({
        version: "1.0",
        pausedAt: "yesterday",
        reason: "sigint",
        reasonDetail: "x",
        authProvider: "x",
        drainedInFlight: true,
        pipelineRunId: "p",
      }),
    ).toThrow();
  });

  it("rejects empty reasonDetail", () => {
    expect(() =>
      PausedStateSchema.parse({
        version: "1.0",
        pausedAt: "2026-04-27T10:00:00.000Z",
        reason: "sigint",
        reasonDetail: "",
        authProvider: "x",
        drainedInFlight: true,
        pipelineRunId: "p",
      }),
    ).toThrow();
  });

  it("rejects negative resetsAt", () => {
    expect(() =>
      PausedStateSchema.parse({
        version: "1.0",
        pausedAt: "2026-04-27T10:00:00.000Z",
        reason: "claude-max-five-hour-limit",
        reasonDetail: "x",
        authProvider: "x",
        drainedInFlight: true,
        pipelineRunId: "p",
        resetsAt: -1,
      }),
    ).toThrow();
  });
});
