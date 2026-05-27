import { describe, expect, it } from "vitest";
import {
  FeatureGraphProgressSchema,
  InFlightFeatureSchema,
} from "../src/feature-graph-progress.js";

describe("InFlightFeatureSchema", () => {
  it("parses a typical entry", () => {
    const out = InFlightFeatureSchema.parse({
      featureId: "feat-filters",
      worktree: "feat-filters",
      branch: "feat/filters",
      lastAgent: "web-frontend-builder",
      nextAgent: "tester",
      lastProgressAt: "2026-04-27T10:55:01.000Z",
      dispatchedAt: "2026-04-27T10:50:00.000Z",
    });
    expect(out.featureId).toBe("feat-filters");
    expect(out.nextAgent).toBe("tester");
  });

  it("accepts nextAgent: null (sequence ended, close-feature pending)", () => {
    const out = InFlightFeatureSchema.parse({
      featureId: "feat-x",
      worktree: "feat-x",
      branch: "feat/x",
      lastAgent: "reviewer",
      nextAgent: null,
      lastProgressAt: "2026-04-27T10:55:01.000Z",
      dispatchedAt: "2026-04-27T10:50:00.000Z",
    });
    expect(out.nextAgent).toBeNull();
  });

  it("rejects unknown agent name", () => {
    expect(() =>
      InFlightFeatureSchema.parse({
        featureId: "feat-x",
        worktree: "feat-x",
        branch: "feat/x",
        lastAgent: "ux-researcher",
        nextAgent: null,
        lastProgressAt: "2026-04-27T10:55:01.000Z",
        dispatchedAt: "2026-04-27T10:50:00.000Z",
      }),
    ).toThrow();
  });
});

describe("FeatureGraphProgressSchema", () => {
  it("parses an empty snapshot at run start", () => {
    const out = FeatureGraphProgressSchema.parse({
      version: "1.0",
      pipelineRunId: "pipe-001",
      lastUpdatedAt: "2026-04-27T10:00:00.000Z",
      masterCommitSha: "abc1234567890abcdef",
      completed: [],
      failed: [],
      aborted: [],
      inFlight: [],
    });
    expect(out.version).toBe("1.0");
  });

  it("parses a populated snapshot mid-run", () => {
    const out = FeatureGraphProgressSchema.parse({
      version: "1.0",
      pipelineRunId: "pipe-001",
      lastUpdatedAt: "2026-04-27T11:00:00.000Z",
      masterCommitSha: "abc1234567890abcdef",
      completed: ["feat-shell", "feat-board"],
      failed: ["feat-broken"],
      aborted: ["feat-skipped"],
      inFlight: [
        {
          featureId: "feat-filters",
          worktree: "feat-filters",
          branch: "feat/filters",
          lastAgent: "tester",
          nextAgent: "reviewer",
          lastProgressAt: "2026-04-27T10:58:00.000Z",
          dispatchedAt: "2026-04-27T10:50:00.000Z",
        },
      ],
    });
    expect(out.inFlight).toHaveLength(1);
    expect(out.completed).toContain("feat-board");
  });

  it("rejects wrong version literal", () => {
    expect(() =>
      FeatureGraphProgressSchema.parse({
        version: "0.9",
        pipelineRunId: "x",
        lastUpdatedAt: "2026-04-27T10:00:00.000Z",
        masterCommitSha: "x",
        completed: [],
        failed: [],
        aborted: [],
        inFlight: [],
      }),
    ).toThrow();
  });

  it("rejects malformed lastUpdatedAt (not ISO)", () => {
    expect(() =>
      FeatureGraphProgressSchema.parse({
        version: "1.0",
        pipelineRunId: "x",
        lastUpdatedAt: "not-a-date",
        masterCommitSha: "x",
        completed: [],
        failed: [],
        aborted: [],
        inFlight: [],
      }),
    ).toThrow();
  });
});
