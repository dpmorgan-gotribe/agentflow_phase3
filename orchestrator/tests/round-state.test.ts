// feat-073 Phase A — unit tests for deriveRoundState + bugsInRound.

import { describe, expect, it } from "vitest";

import { bugsInRound, deriveRoundState } from "../src/round-state.js";
import type { BugEntry } from "@repo/orchestrator-contracts";

// Test helper — minimal BugEntry shape that satisfies the contract
// without us having to fill every defaulted field.
function makeBug(overrides: Partial<BugEntry> = {}): BugEntry {
  return {
    id: "bug-test-1",
    iteration: 1,
    source: "visual-parity",
    severity: "P1",
    summary: "test",
    correlatedOrphanPath: null,
    owningFeature: null,
    affectsFiles: [],
    agentSequence: ["bug-fixer"],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    flapResets: 0,
    resolvedInIteration: null,
    bugPlanPath: "active/bug-test-1.md",
    errorLog: [],
    ...overrides,
  } as unknown as BugEntry;
}

describe("deriveRoundState", () => {
  it("returns 5 (final-gate) when bugs list is empty", () => {
    expect(deriveRoundState([])).toBe(5);
  });

  it("returns 5 when no bugs are pending (all completed / failed)", () => {
    const bugs = [
      makeBug({ id: "a", status: "completed" }),
      makeBug({ id: "b", status: "failed" }),
      makeBug({ id: "c", status: "needs-operator-review" }),
    ];
    expect(deriveRoundState(bugs)).toBe(5);
  });

  it("returns 1 when a dev-server-compile bug is pending", () => {
    const bugs = [
      makeBug({ id: "a", source: "dev-server-compile", status: "pending" }),
    ];
    expect(deriveRoundState(bugs)).toBe(1);
  });

  it("returns 1 when a runtime-error bug is pending", () => {
    const bugs = [
      makeBug({ id: "a", source: "runtime-error", status: "pending" }),
    ];
    expect(deriveRoundState(bugs)).toBe(1);
  });

  it("returns 1 when a reachability-orphan bug is pending", () => {
    const bugs = [
      makeBug({ id: "a", source: "reachability-orphan", status: "pending" }),
    ];
    expect(deriveRoundState(bugs)).toBe(1);
  });

  it("returns 2 when a visual-parity:layout-regrouping bug is pending", () => {
    const bugs = [
      makeBug({
        id: "a",
        source: "visual-parity",
        status: "pending",
        parity: {
          screen: "home",
          pattern: "layout-regrouping",
          detail: {},
        } as unknown as BugEntry["parity"],
      }),
    ];
    expect(deriveRoundState(bugs)).toBe(2);
  });

  it("returns 2 when a flow-execution-failure (no special primaryCause) is pending", () => {
    const bugs = [
      makeBug({
        id: "a",
        source: "flow-execution-failure",
        status: "pending",
      }),
    ];
    expect(deriveRoundState(bugs)).toBe(2);
  });

  it("returns 3 when a visual-parity:style-drift bug is pending", () => {
    const bugs = [
      makeBug({
        id: "a",
        source: "visual-parity",
        status: "pending",
        parity: {
          screen: "settings",
          pattern: "style-drift",
          detail: {},
        } as unknown as BugEntry["parity"],
      }),
    ];
    expect(deriveRoundState(bugs)).toBe(3);
  });

  it("returns 3 when a perceptual-divergence bug is pending", () => {
    const bugs = [
      makeBug({
        id: "a",
        source: "perceptual-divergence",
        status: "pending",
      }),
    ];
    expect(deriveRoundState(bugs)).toBe(3);
  });

  it("returns 1 when both round-1 and round-3 bugs are pending (lowest wins, automatic demotion)", () => {
    const bugs = [
      // round-3 bug
      makeBug({
        id: "a",
        source: "perceptual-divergence",
        status: "pending",
      }),
      // round-1 bug (later in array but earlier round)
      makeBug({
        id: "b",
        source: "dev-server-compile",
        status: "pending",
      }),
    ];
    expect(deriveRoundState(bugs)).toBe(1);
  });

  it("returns 2 when both round-2 and round-3 bugs are pending", () => {
    const bugs = [
      makeBug({
        id: "a",
        source: "visual-parity",
        status: "pending",
        parity: {
          screen: "home",
          pattern: "shell-stripping",
          detail: {},
        } as unknown as BugEntry["parity"],
      }),
      makeBug({
        id: "b",
        source: "perceptual-divergence",
        status: "pending",
      }),
    ];
    expect(deriveRoundState(bugs)).toBe(2);
  });

  it("ignores completed bugs when deriving round", () => {
    // round-3 completed + round-1 completed → all done → 5
    const bugs = [
      makeBug({ id: "a", source: "dev-server-compile", status: "completed" }),
      makeBug({
        id: "b",
        source: "perceptual-divergence",
        status: "completed",
      }),
    ];
    expect(deriveRoundState(bugs)).toBe(5);
  });

  it("ignores failed bugs (they're not blocking — operator escalated)", () => {
    const bugs = [
      makeBug({ id: "a", source: "dev-server-compile", status: "failed" }),
    ];
    expect(deriveRoundState(bugs)).toBe(5);
  });

  it("flow-execution-failure with dev-server-not-responding primaryCause is round 1 (when pending)", () => {
    // In practice, bug-084 routes these to needs-operator-review so they
    // won't usually be in pending. But the round-membership rule still
    // matches by primaryCause if anyone enters the pending pool.
    const bugs = [
      makeBug({
        id: "a",
        source: "flow-execution-failure",
        status: "pending",
        primaryCause: "dev-server-not-responding",
      } as unknown as Partial<BugEntry>),
    ];
    expect(deriveRoundState(bugs)).toBe(1);
  });
});

describe("bugsInRound", () => {
  it("filters to round-3 bugs by source", () => {
    const bugs = [
      makeBug({ id: "a", source: "dev-server-compile" }),
      makeBug({ id: "b", source: "perceptual-divergence" }),
      makeBug({
        id: "c",
        source: "visual-parity",
        parity: {
          screen: "home",
          pattern: "style-drift",
          detail: {},
        } as unknown as BugEntry["parity"],
      }),
    ];
    const round3 = bugsInRound(bugs, 3);
    expect(round3.map((b) => b.id).sort()).toEqual(["b", "c"]);
  });

  it("filters parity bugs by pattern (round 2 vs round 3)", () => {
    const bugs = [
      makeBug({
        id: "systemic",
        source: "visual-parity",
        parity: {
          screen: "home",
          pattern: "layout-regrouping",
          detail: {},
        } as unknown as BugEntry["parity"],
      }),
      makeBug({
        id: "drift",
        source: "visual-parity",
        parity: {
          screen: "home",
          pattern: "variant-drift",
          detail: {},
        } as unknown as BugEntry["parity"],
      }),
    ];
    expect(bugsInRound(bugs, 2).map((b) => b.id)).toEqual(["systemic"]);
    expect(bugsInRound(bugs, 3).map((b) => b.id)).toEqual(["drift"]);
  });

  it("returns empty array for round 5 (no fixable classes)", () => {
    const bugs = [
      makeBug({ id: "a", source: "dev-server-compile" }),
      makeBug({ id: "b", source: "perceptual-divergence" }),
    ];
    expect(bugsInRound(bugs, 5)).toEqual([]);
  });
});
