// feat-073 Phase B — tests for runRoundsOrchestrator outer-loop wrapper.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { runRoundsOrchestrator } from "../src/rounds-orchestrator.js";
import type {
  FixBugsLoopContext,
  FixBugsLoopResult,
} from "../src/fix-bugs-loop.js";
import { BudgetTracker } from "../src/budget-tracker.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "rounds-orchestrator-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Write a bugs.yaml file at projectRoot/docs/bugs.yaml. */
function writeBugs(bugs: unknown[]): void {
  const path = join(projectRoot, "docs", "bugs.yaml");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    yaml.dump({
      version: "1.0",
      generated_at: new Date().toISOString(),
      project_name: "test",
      source_run_id: "test-run",
      iteration: 1,
      iteration_cap: 5,
      bugs,
    }),
  );
}

/** Make a minimal context — most fields stubbed to no-op-friendly defaults. */
function makeCtx(
  innerLoopStub: (ctx: FixBugsLoopContext) => Promise<FixBugsLoopResult>,
  overrides: Partial<Parameters<typeof runRoundsOrchestrator>[0]> = {},
): Parameters<typeof runRoundsOrchestrator>[0] {
  return {
    projectRoot,
    factoryRoot: process.cwd(),
    pipelineRunId: "test-run",
    budget: new BudgetTracker({ perPipelineMaxUsd: 1000, perStageMaxUsd: {} }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    invokeAgent: (async (..._args: unknown[]) => ({
      taskStatus: {},
      errors: {},
      costUsd: 0,
    })) as Parameters<typeof runRoundsOrchestrator>[0]["invokeAgent"],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    runBuildToSpecVerify: (async (..._args: unknown[]) => ({
      ok: true,
      reachability: {
        orphanComponents: [],
        orphanRoutes: [],
        scannedFiles: 0,
        ignoredByAllowComment: [],
      },
      flows: { passed: [], failed: [], generated: [] },
      bugPlansFiled: [],
      costUsd: 0,
      durationMs: 0,
      warnings: [],
    })) as Parameters<typeof runRoundsOrchestrator>[0]["runBuildToSpecVerify"],
    runFixBugsLoopFn: innerLoopStub,
    ...overrides,
  };
}

const minBug = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "bug-parity-test-1",
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
});

describe("runRoundsOrchestrator", () => {
  it("derives round 5 when bugs.yaml is empty → fires final-gate inner loop → returns clean", async () => {
    writeBugs([]);
    const innerStub = async (
      _ctx: FixBugsLoopContext,
    ): Promise<FixBugsLoopResult> => ({
      status: "clean",
      iterationsRun: 1,
      bugsResolved: [],
      bugsFailed: [],
      bugsRemaining: [],
      totalCostUsd: 0,
      iterationLog: [],
    });
    const result = await runRoundsOrchestrator(makeCtx(innerStub));
    expect(result.status).toBe("clean");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.round).toBe(5);
  });

  it("derives round 1 when dev-server-compile bug pending; passes round-1 config to inner loop", async () => {
    writeBugs([
      minBug({
        id: "bug-compile-a",
        source: "dev-server-compile",
        status: "pending",
      }),
    ]);
    const captured: { roundIds: number[]; tiers: Set<number>[] } = {
      roundIds: [],
      tiers: [],
    };
    const innerStub = async (
      ctx: FixBugsLoopContext,
    ): Promise<FixBugsLoopResult> => {
      const cfg = ctx.roundConfig;
      if (cfg) {
        captured.roundIds.push(cfg.id);
        captured.tiers.push(new Set(cfg.enabledTiers));
      }
      // Simulate: round-1 fix succeeded. After the inner loop returns, the
      // bugs.yaml has the bug marked completed.
      writeBugs([
        minBug({
          id: "bug-compile-a",
          source: "dev-server-compile",
          status: "completed",
        }),
      ]);
      return {
        status: "clean",
        iterationsRun: 1,
        bugsResolved: ["bug-compile-a"],
        bugsFailed: [],
        bugsRemaining: [],
        totalCostUsd: 0.1,
        iterationLog: [],
      };
    };
    const result = await runRoundsOrchestrator(makeCtx(innerStub));
    expect(captured.roundIds[0]).toBe(1);
    expect(captured.tiers[0]?.has(2)).toBe(true);
    // Round 1 should NOT have tier 4 enabled
    expect(captured.tiers[0]?.has(4)).toBe(false);
    // After round-1 fix → bugs all completed → round 5 → clean
    expect(result.status).toBe("clean");
  });

  it("advances round 1 → 2 → 3 → 5 across outer iterations", async () => {
    // Start with a round-1 bug
    writeBugs([
      minBug({
        id: "bug-compile-r1",
        source: "dev-server-compile",
        status: "pending",
      }),
    ]);
    const sequence: number[] = [];
    let phase = 0;
    const innerStub = async (
      ctx: FixBugsLoopContext,
    ): Promise<FixBugsLoopResult> => {
      sequence.push(ctx.roundConfig?.id ?? -1);
      phase += 1;
      if (phase === 1) {
        // Round 1 fix: complete + introduce round-2 bug
        writeBugs([
          minBug({
            id: "bug-compile-r1",
            source: "dev-server-compile",
            status: "completed",
          }),
          minBug({
            id: "bug-parity-r2",
            source: "visual-parity",
            status: "pending",
            parity: {
              screen: "home",
              pattern: "layout-regrouping",
              detail: {},
            },
          }),
        ]);
      } else if (phase === 2) {
        // Round 2 fix: complete + introduce round-3 bug
        writeBugs([
          minBug({
            id: "bug-compile-r1",
            source: "dev-server-compile",
            status: "completed",
          }),
          minBug({
            id: "bug-parity-r2",
            source: "visual-parity",
            status: "completed",
            parity: {
              screen: "home",
              pattern: "layout-regrouping",
              detail: {},
            },
          }),
          minBug({
            id: "bug-perceptual-r3",
            source: "perceptual-divergence",
            status: "pending",
          }),
        ]);
      } else if (phase === 3) {
        // Round 3 fix: complete
        writeBugs([
          minBug({
            id: "bug-compile-r1",
            source: "dev-server-compile",
            status: "completed",
          }),
          minBug({
            id: "bug-parity-r2",
            source: "visual-parity",
            status: "completed",
            parity: {
              screen: "home",
              pattern: "layout-regrouping",
              detail: {},
            },
          }),
          minBug({
            id: "bug-perceptual-r3",
            source: "perceptual-divergence",
            status: "completed",
          }),
        ]);
      }
      return {
        status: "clean",
        iterationsRun: 1,
        bugsResolved: ["bug-stub"],
        bugsFailed: [],
        bugsRemaining: [],
        totalCostUsd: 0.1,
        iterationLog: [],
      };
    };

    const result = await runRoundsOrchestrator(makeCtx(innerStub));
    // Sequence should be 1 → 2 → 3 → 5 (final-gate)
    expect(sequence).toEqual([1, 2, 3, 5]);
    expect(result.status).toBe("clean");
    expect(result.rounds.map((r) => r.round)).toEqual([1, 2, 3, 5]);
  });

  it("demotes when a later-round fix introduces an earlier-round bug", async () => {
    // Start at round 3 (perceptual-divergence pending)
    writeBugs([
      minBug({
        id: "bug-perceptual-r3",
        source: "perceptual-divergence",
        status: "pending",
      }),
    ]);
    const sequence: number[] = [];
    let phase = 0;
    const innerStub = async (
      ctx: FixBugsLoopContext,
    ): Promise<FixBugsLoopResult> => {
      sequence.push(ctx.roundConfig?.id ?? -1);
      phase += 1;
      if (phase === 1) {
        // Round 3 fix: complete BUT introduce a round-1 regression
        writeBugs([
          minBug({
            id: "bug-perceptual-r3",
            source: "perceptual-divergence",
            status: "completed",
          }),
          minBug({
            id: "bug-compile-regression",
            source: "dev-server-compile",
            status: "pending",
          }),
        ]);
      } else if (phase === 2) {
        // Round 1 fix: complete regression
        writeBugs([
          minBug({
            id: "bug-perceptual-r3",
            source: "perceptual-divergence",
            status: "completed",
          }),
          minBug({
            id: "bug-compile-regression",
            source: "dev-server-compile",
            status: "completed",
          }),
        ]);
      }
      return {
        status: "clean",
        iterationsRun: 1,
        bugsResolved: ["x"],
        bugsFailed: [],
        bugsRemaining: [],
        totalCostUsd: 0.1,
        iterationLog: [],
      };
    };

    const result = await runRoundsOrchestrator(makeCtx(innerStub));
    // Sequence: 3 (fix introduces regression) → 1 (demoted) → 5 (final-gate)
    expect(sequence).toEqual([3, 1, 5]);
    expect(result.status).toBe("clean");
  });

  it("exits with no-progress when same round runs twice with no fixes", async () => {
    writeBugs([
      minBug({
        id: "bug-compile-r1",
        source: "dev-server-compile",
        status: "pending",
      }),
    ]);
    const innerStub = async (
      _ctx: FixBugsLoopContext,
    ): Promise<FixBugsLoopResult> => ({
      status: "iteration-cap-hit",
      iterationsRun: 1,
      bugsResolved: [],
      bugsFailed: [],
      bugsRemaining: ["r1"],
      totalCostUsd: 0.1,
      iterationLog: [],
    });
    const result = await runRoundsOrchestrator(makeCtx(innerStub));
    expect(result.status).toBe("no-progress");
    // 2 outer iterations expected (first one establishes baseline, second
    // triggers no-progress exit)
    expect(result.rounds).toHaveLength(2);
  });

  it("respects outer iteration cap", async () => {
    // Setup that always returns 1 fix + introduces 1 new pending bug
    writeBugs([
      minBug({
        id: "bug-compile-iter-0",
        source: "dev-server-compile",
        status: "pending",
      }),
    ]);
    let counter = 0;
    const innerStub = async (
      _ctx: FixBugsLoopContext,
    ): Promise<FixBugsLoopResult> => {
      counter += 1;
      writeBugs([
        minBug({
          id: `bug-compile-iter-${counter}`,
          source: "dev-server-compile",
          status: "pending",
        }),
      ]);
      return {
        status: "clean",
        iterationsRun: 1,
        bugsResolved: [`bug-compile-iter-${counter - 1}`],
        bugsFailed: [],
        bugsRemaining: [],
        totalCostUsd: 0.1,
        iterationLog: [],
      };
    };
    const result = await runRoundsOrchestrator(
      makeCtx(innerStub, { outerIterationCap: 3 }),
    );
    expect(result.status).toBe("outer-cap-hit");
    expect(result.rounds).toHaveLength(3);
  });

  it("sums totalCostUsd across rounds", async () => {
    writeBugs([
      minBug({
        id: "bug-compile-r1",
        source: "dev-server-compile",
        status: "pending",
      }),
    ]);
    let phase = 0;
    const innerStub = async (
      _ctx: FixBugsLoopContext,
    ): Promise<FixBugsLoopResult> => {
      phase += 1;
      if (phase === 1) {
        writeBugs([
          minBug({
            id: "bug-compile-r1",
            source: "dev-server-compile",
            status: "completed",
          }),
        ]);
      }
      return {
        status: "clean",
        iterationsRun: 1,
        bugsResolved: phase === 1 ? ["r1"] : [],
        bugsFailed: [],
        bugsRemaining: [],
        totalCostUsd: phase === 1 ? 0.5 : 0.2,
        iterationLog: [],
      };
    };
    const result = await runRoundsOrchestrator(makeCtx(innerStub));
    expect(result.totalCostUsd).toBeCloseTo(0.7); // 0.5 (round 1) + 0.2 (round 5 final-gate)
  });
});
